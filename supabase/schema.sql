-- Event Manager C + Supabase schema
-- Run this in the Supabase SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'New User',
  role text not null default 'user' check (role in ('user', 'admin')),
  created_at timestamptz not null default timezone('utc'::text, now())
);

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
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

create index if not exists idx_events_starts_at on public.events (starts_at);
create index if not exists idx_registrations_event_id on public.registrations (event_id);
create index if not exists idx_registrations_user_id on public.registrations (user_id);
create index if not exists idx_audit_logs_created_at on public.audit_logs (created_at desc);

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

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1), 'New User')
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute procedure public.handle_new_user();

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc'::text, now());
  return new;
end;
$$;

drop trigger if exists trg_events_set_updated_at on public.events;
create trigger trg_events_set_updated_at
  before update on public.events
  for each row
  execute procedure public.set_updated_at();

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

alter table public.profiles enable row level security;
alter table public.events enable row level security;
alter table public.registrations enable row level security;
alter table public.audit_logs enable row level security;

drop policy if exists "authenticated users can read profiles" on public.profiles;
create policy "authenticated users can read profiles"
on public.profiles
for select
to authenticated
using (true);

drop policy if exists "users can update own profile" on public.profiles;
create policy "users can update own profile"
on public.profiles
for update
to authenticated
using (auth.uid() = id)
with check (auth.uid() = id and role = (select role from public.profiles where id = auth.uid()));

drop policy if exists "authenticated users can read events" on public.events;
create policy "authenticated users can read events"
on public.events
for select
to authenticated
using (true);

drop policy if exists "admins can insert events" on public.events;
create policy "admins can insert events"
on public.events
for insert
to authenticated
with check (public.is_admin(auth.uid()) and created_by = auth.uid());

drop policy if exists "admins can update events" on public.events;
create policy "admins can update events"
on public.events
for update
to authenticated
using (public.is_admin(auth.uid()))
with check (public.is_admin(auth.uid()));

drop policy if exists "admins can delete events" on public.events;
create policy "admins can delete events"
on public.events
for delete
to authenticated
using (public.is_admin(auth.uid()));

drop policy if exists "users can read own registrations" on public.registrations;
create policy "users can read own registrations"
on public.registrations
for select
to authenticated
using (auth.uid() = user_id or public.is_admin(auth.uid()));

drop policy if exists "admins can read audit logs" on public.audit_logs;
create policy "admins can read audit logs"
on public.audit_logs
for select
to authenticated
using (public.is_admin(auth.uid()));

-- Profiles
-- Events
-- Registrations: reads allowed, writes only through RPC functions.
-- Audit logs
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

  select capacity into current_capacity
  from public.events
  where id = p_event;

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

-- 管理者昇格例
-- update public.profiles
-- set role = 'admin'
-- where id = (select id from auth.users where email = 'your-admin@example.com');
