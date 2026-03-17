-- Unified schema for Event Manager B + Supabase and C + Supabase
-- Run this in the Supabase SQL Editor on a fresh project.
-- This merged version keeps C-level features (audit logs, dashboard-ready data, RLS, RPC)
-- while preserving B-compatible columns and function names.

create extension if not exists pgcrypto;

-- ============================================================================
-- Tables
-- ============================================================================

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique,
  display_name text not null default 'New User',
  role text not null default 'user' check (role in ('user', 'admin')),
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now())
);

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null default '',
  venue text not null,
  starts_at timestamptz not null,
  capacity integer not null check (capacity > 0),
  created_by uuid not null references public.profiles(id) on delete restrict default auth.uid(),
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now())
);

create table if not exists public.registrations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default timezone('utc'::text, now()),
  constraint registrations_event_user_unique unique (event_id, user_id)
);

create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles(id) on delete set null,
  entity_type text not null,
  entity_id uuid,
  action text not null,
  payload jsonb,
  created_at timestamptz not null default timezone('utc'::text, now())
);

create index if not exists idx_profiles_role on public.profiles(role);
create index if not exists idx_events_starts_at on public.events(starts_at);
create index if not exists idx_registrations_event_id on public.registrations(event_id);
create index if not exists idx_registrations_user_id on public.registrations(user_id);
create index if not exists idx_audit_logs_created_at on public.audit_logs(created_at desc);

-- ============================================================================
-- Utility functions / triggers
-- ============================================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc'::text, now());
  return new;
end;
$$;

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at
  before update on public.profiles
  for each row
  execute procedure public.set_updated_at();

drop trigger if exists trg_events_updated_at on public.events;
create trigger trg_events_updated_at
  before update on public.events
  for each row
  execute procedure public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1), 'New User')
  )
  on conflict (id) do update
    set email = excluded.email,
        display_name = coalesce(public.profiles.display_name, excluded.display_name),
        updated_at = timezone('utc'::text, now());

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute procedure public.handle_new_user();

create or replace function public.is_admin(p_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = p_user
      and role = 'admin'
  );
$$;

create or replace function public.promote_user_to_admin(target_email text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_id uuid;
begin
  select id into target_id
  from auth.users
  where email = target_email;

  if target_id is null then
    raise exception 'No auth user found for %', target_email;
  end if;

  update public.profiles
  set role = 'admin',
      updated_at = timezone('utc'::text, now())
  where id = target_id;

  if not found then
    raise exception 'Profile row not found for %', target_email;
  end if;
end;
$$;

-- ============================================================================
-- Audit log functions / triggers
-- ============================================================================

create or replace function public.log_event_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  payload_data jsonb;
  target_id uuid;
  action_name text;
begin
  if tg_op = 'DELETE' then
    payload_data := to_jsonb(old);
    target_id := old.id;
    action_name := 'delete';
  elsif tg_op = 'UPDATE' then
    payload_data := jsonb_build_object('before', to_jsonb(old), 'after', to_jsonb(new));
    target_id := new.id;
    action_name := 'update';
  else
    payload_data := to_jsonb(new);
    target_id := new.id;
    action_name := 'insert';
  end if;

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, payload)
  values (auth.uid(), 'event', target_id, action_name, payload_data);

  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_events_audit on public.events;
create trigger trg_events_audit
  after insert or update or delete on public.events
  for each row
  execute procedure public.log_event_changes();

create or replace function public.log_registration_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  payload_data jsonb;
  target_id uuid;
  action_name text;
begin
  if tg_op = 'DELETE' then
    payload_data := to_jsonb(old);
    target_id := old.id;
    action_name := 'cancel';
  else
    payload_data := to_jsonb(new);
    target_id := new.id;
    action_name := 'register';
  end if;

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, payload)
  values (auth.uid(), 'registration', target_id, action_name, payload_data);

  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_registrations_audit on public.registrations;
create trigger trg_registrations_audit
  after insert or delete on public.registrations
  for each row
  execute procedure public.log_registration_changes();

-- ============================================================================
-- Dashboard / compatibility functions
-- ============================================================================

create or replace function public.get_event_stats()
returns table (event_id uuid, registration_count bigint)
language sql
security definer
set search_path = public
as $$
  select e.id as event_id, count(r.id)::bigint as registration_count
  from public.events e
  left join public.registrations r on r.event_id = e.id
  group by e.id;
$$;

grant execute on function public.get_event_stats() to authenticated;

-- Main registration RPC used by the C version
create or replace function public.register_event(p_event uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user uuid := auth.uid();
  current_capacity integer;
  current_count integer;
begin
  if current_user is null then
    raise exception 'ログインが必要です。';
  end if;

  -- Keep B-sample behavior: admins cannot register as attendees.
  if public.is_admin(current_user) then
    raise exception 'Admins cannot register as attendees in this sample app.';
  end if;

  select capacity into current_capacity
  from public.events
  where id = p_event
  for update;

  if current_capacity is null then
    raise exception '対象イベントが存在しません。';
  end if;

  if exists (
    select 1
    from public.registrations
    where event_id = p_event
      and user_id = current_user
  ) then
    raise exception 'すでに参加登録済みです。';
  end if;

  select count(*) into current_count
  from public.registrations
  where event_id = p_event;

  if current_count >= current_capacity then
    raise exception '定員に達しているため、参加登録できません。';
  end if;

  insert into public.registrations (event_id, user_id)
  values (p_event, current_user);
end;
$$;

grant execute on function public.register_event(uuid) to authenticated;

-- B-compatible alias name
create or replace function public.register_for_event(p_event_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.register_event(p_event_id);
end;
$$;

grant execute on function public.register_for_event(uuid) to authenticated;

create or replace function public.cancel_registration(p_event uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user uuid := auth.uid();
begin
  if current_user is null then
    raise exception 'ログインが必要です。';
  end if;

  delete from public.registrations
  where event_id = p_event
    and user_id = current_user;

  if not found then
    raise exception '参加登録が見つかりません。';
  end if;
end;
$$;

grant execute on function public.cancel_registration(uuid) to authenticated;

-- ============================================================================
-- RLS / grants
-- ============================================================================

alter table public.profiles enable row level security;
alter table public.events enable row level security;
alter table public.registrations enable row level security;
alter table public.audit_logs enable row level security;

revoke all on public.profiles from anon, authenticated;
revoke all on public.events from anon, authenticated;
revoke all on public.registrations from anon, authenticated;
revoke all on public.audit_logs from anon, authenticated;

grant select, insert, update on public.profiles to authenticated;
grant select, insert, update, delete on public.events to authenticated;
grant select on public.registrations to authenticated;
grant select on public.audit_logs to authenticated;

drop policy if exists "profiles_select_own_or_admin" on public.profiles;
create policy "profiles_select_own_or_admin"
on public.profiles
for select
to authenticated
using (id = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists "profiles_insert_self" on public.profiles;
create policy "profiles_insert_self"
on public.profiles
for insert
to authenticated
with check (id = auth.uid());

drop policy if exists "profiles_update_self_or_admin" on public.profiles;
create policy "profiles_update_self_or_admin"
on public.profiles
for update
to authenticated
using (id = auth.uid() or public.is_admin(auth.uid()))
with check (
  (id = auth.uid() and role = (select role from public.profiles where id = auth.uid()))
  or public.is_admin(auth.uid())
);

drop policy if exists "events_select_authenticated" on public.events;
create policy "events_select_authenticated"
on public.events
for select
to authenticated
using (true);

drop policy if exists "events_insert_admin" on public.events;
create policy "events_insert_admin"
on public.events
for insert
to authenticated
with check (public.is_admin(auth.uid()) and created_by = auth.uid());

drop policy if exists "events_update_admin" on public.events;
create policy "events_update_admin"
on public.events
for update
to authenticated
using (public.is_admin(auth.uid()))
with check (public.is_admin(auth.uid()));

drop policy if exists "events_delete_admin" on public.events;
create policy "events_delete_admin"
on public.events
for delete
to authenticated
using (public.is_admin(auth.uid()));

drop policy if exists "registrations_select_own_or_admin" on public.registrations;
create policy "registrations_select_own_or_admin"
on public.registrations
for select
to authenticated
using (user_id = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists "audit_logs_select_admin" on public.audit_logs;
create policy "audit_logs_select_admin"
on public.audit_logs
for select
to authenticated
using (public.is_admin(auth.uid()));

-- ============================================================================
-- Optional seed (works only after at least one admin profile exists)
-- ============================================================================

insert into public.events (title, description, venue, starts_at, capacity, created_by)
select
  '新卒研修キックオフ',
  '研修の全体像と成果物を共有する導入イベントです。',
  '会議室A',
  timezone('utc'::text, now()) + interval '7 days',
  20,
  id
from public.profiles
where role = 'admin'
limit 1
on conflict do nothing;

-- ============================================================================
-- First admin example
-- ============================================================================
-- 1) Sign up from the app screen first.
-- 2) Then run the following in SQL Editor.
-- select public.promote_user_to_admin('your-admin@example.com');
