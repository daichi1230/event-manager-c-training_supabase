import { useEffect, useMemo, useState } from 'react';
import { supabase } from './lib/supabase';

const EMPTY_EVENT_FORM = {
  id: null,
  title: '',
  description: '',
  venue: '',
  starts_at: '',
  capacity: 20,
};

const TABS_USER = ['events', 'my-events'];
const TABS_ADMIN = ['events', 'dashboard', 'audit'];

function formatDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  return new Intl.DateTimeFormat('ja-JP', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function formatForInput(value) {
  if (!value) return '';
  const date = new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toCsv(rows) {
  const escape = (value) => {
    const text = value == null ? '' : String(value);
    const sanitized = text.replace(/"/g, '""');
    return `"${sanitized}"`;
  };
  return rows.map((row) => row.map(escape).join(',')).join('\n');
}

function downloadCsv(filename, rows) {
  const csv = toCsv(rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function App() {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [profilesById, setProfilesById] = useState({});
  const [events, setEvents] = useState([]);
  const [registrations, setRegistrations] = useState([]);
  const [auditLogs, setAuditLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState('events');
  const [search, setSearch] = useState('');
  const [authMode, setAuthMode] = useState('signin');
  const [authForm, setAuthForm] = useState({
    email: '',
    password: '',
    displayName: '',
  });
  const [eventForm, setEventForm] = useState(EMPTY_EVENT_FORM);
  const [selectedEventId, setSelectedEventId] = useState(null);
  const [message, setMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const selectedEvent = useMemo(
    () => events.find((event) => event.id === selectedEventId) ?? events[0] ?? null,
    [events, selectedEventId],
  );

  const myRegistrationEventIds = useMemo(
    () => new Set(registrations.map((registration) => registration.event_id)),
    [registrations],
  );

  const registrationCountByEvent = useMemo(() => {
    const countMap = new Map();
    for (const registration of registrations) {
      countMap.set(registration.event_id, (countMap.get(registration.event_id) ?? 0) + 1);
    }
    return countMap;
  }, [registrations]);

  const visibleTabs = profile?.role === 'admin' ? TABS_ADMIN : TABS_USER;

  const filteredEvents = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return events.filter((event) => {
      if (!keyword) return true;
      const haystack = [event.title, event.description, event.venue].join(' ').toLowerCase();
      return haystack.includes(keyword);
    });
  }, [events, search]);

  const upcomingEvents = useMemo(
    () => events.filter((event) => new Date(event.starts_at).getTime() >= Date.now()),
    [events],
  );

  const dashboardStats = useMemo(() => {
    const totalEvents = events.length;
    const totalRegistrations = registrations.length;
    const upcomingCount = upcomingEvents.length;
    const fullCount = events.filter(
      (event) => (registrationCountByEvent.get(event.id) ?? 0) >= event.capacity,
    ).length;
    return { totalEvents, totalRegistrations, upcomingCount, fullCount };
  }, [events, registrations, upcomingEvents, registrationCountByEvent]);

  useEffect(() => {
    let mounted = true;

    async function bootstrap() {
      setLoading(true);
      const { data, error } = await supabase.auth.getSession();
      if (error) {
        setErrorMessage(error.message);
      }
      if (mounted) {
        setSession(data.session ?? null);
      }
      setLoading(false);
    }

    bootstrap();

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession ?? null);
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!session?.user) {
      setProfile(null);
      setProfilesById({});
      setEvents([]);
      setRegistrations([]);
      setAuditLogs([]);
      setActiveTab('events');
      setSelectedEventId(null);
      return;
    }

    async function loadData() {
      setLoading(true);
      setErrorMessage('');

      const userId = session.user.id;

      const { data: myProfile, error: profileError } = await supabase
        .from('profiles')
        .select('id, display_name, role, created_at')
        .eq('id', userId)
        .single();

      if (profileError) {
        setErrorMessage(profileError.message);
        setLoading(false);
        return;
      }

      setProfile(myProfile);

      const [{ data: allProfiles, error: profilesError }, { data: allEvents, error: eventsError }] = await Promise.all([
        supabase.from('profiles').select('id, display_name, role').order('display_name'),
        supabase.from('events').select('*').order('starts_at', { ascending: true }),
      ]);

      if (profilesError) {
        setErrorMessage(profilesError.message);
        setLoading(false);
        return;
      }
      if (eventsError) {
        setErrorMessage(eventsError.message);
        setLoading(false);
        return;
      }

      const profileMap = Object.fromEntries(allProfiles.map((item) => [item.id, item]));
      setProfilesById(profileMap);
      setEvents(allEvents);

      const registrationsQuery = myProfile.role === 'admin'
        ? supabase
            .from('registrations')
            .select('id, event_id, user_id, created_at')
            .order('created_at', { ascending: false })
        : supabase
            .from('registrations')
            .select('id, event_id, user_id, created_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

      const { data: registrationRows, error: registrationsError } = await registrationsQuery;
      if (registrationsError) {
        setErrorMessage(registrationsError.message);
        setLoading(false);
        return;
      }
      setRegistrations(registrationRows);

      if (myProfile.role === 'admin') {
        const { data: logs, error: logsError } = await supabase
          .from('audit_logs')
          .select('id, actor_id, entity_type, entity_id, action, payload, created_at')
          .order('created_at', { ascending: false })
          .limit(200);

        if (logsError) {
          setErrorMessage(logsError.message);
          setLoading(false);
          return;
        }
        setAuditLogs(logs);
        setActiveTab((current) => (TABS_ADMIN.includes(current) ? current : 'events'));
      } else {
        setAuditLogs([]);
        setActiveTab((current) => (TABS_USER.includes(current) ? current : 'events'));
      }

      setSelectedEventId((current) => current ?? allEvents[0]?.id ?? null);
      setLoading(false);
    }

    loadData();
  }, [session]);

  async function refreshData() {
    if (!session?.user) return;
    setLoading(true);
    try {
      const userId = session.user.id;
      const { data: profileRow, error: profileError } = await supabase
        .from('profiles')
        .select('id, display_name, role, created_at')
        .eq('id', userId)
        .single();
      if (profileError) throw profileError;
      setProfile(profileRow);

      const [{ data: allProfiles, error: profilesError }, { data: allEvents, error: eventsError }] = await Promise.all([
        supabase.from('profiles').select('id, display_name, role').order('display_name'),
        supabase.from('events').select('*').order('starts_at', { ascending: true }),
      ]);
      if (profilesError) throw profilesError;
      if (eventsError) throw eventsError;

      setProfilesById(Object.fromEntries(allProfiles.map((item) => [item.id, item])));
      setEvents(allEvents);

      const registrationsQuery = profileRow.role === 'admin'
        ? supabase.from('registrations').select('id, event_id, user_id, created_at').order('created_at', { ascending: false })
        : supabase.from('registrations').select('id, event_id, user_id, created_at').eq('user_id', userId).order('created_at', { ascending: false });
      const { data: registrationRows, error: registrationsError } = await registrationsQuery;
      if (registrationsError) throw registrationsError;
      setRegistrations(registrationRows);

      if (profileRow.role === 'admin') {
        const { data: logs, error: logsError } = await supabase
          .from('audit_logs')
          .select('id, actor_id, entity_type, entity_id, action, payload, created_at')
          .order('created_at', { ascending: false })
          .limit(200);
        if (logsError) throw logsError;
        setAuditLogs(logs);
      }
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();
    setSaving(true);
    setErrorMessage('');
    setMessage('');

    try {
      if (authMode === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({
          email: authForm.email.trim(),
          password: authForm.password,
        });
        if (error) throw error;
        setMessage('ログインしました。');
      } else {
        const { error } = await supabase.auth.signUp({
          email: authForm.email.trim(),
          password: authForm.password,
          options: {
            data: {
              display_name: authForm.displayName.trim(),
            },
          },
        });
        if (error) throw error;
        setMessage('サインアップしました。メール確認が有効な場合は受信メールを確認してください。');
      }
      setAuthForm({ email: '', password: '', displayName: '' });
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleSignOut() {
    const { error } = await supabase.auth.signOut();
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    setMessage('ログアウトしました。');
  }

  function startCreateEvent() {
    setEventForm(EMPTY_EVENT_FORM);
  }

  function startEditEvent(eventItem) {
    setEventForm({
      id: eventItem.id,
      title: eventItem.title,
      description: eventItem.description ?? '',
      venue: eventItem.venue ?? '',
      starts_at: formatForInput(eventItem.starts_at),
      capacity: eventItem.capacity,
    });
  }

  async function saveEvent(event) {
    event.preventDefault();
    setSaving(true);
    setErrorMessage('');
    setMessage('');

    try {
      const payload = {
        title: eventForm.title.trim(),
        description: eventForm.description.trim(),
        venue: eventForm.venue.trim(),
        starts_at: new Date(eventForm.starts_at).toISOString(),
        capacity: Number(eventForm.capacity),
      };

      if (!payload.title) throw new Error('タイトルは必須です。');
      if (!payload.venue) throw new Error('会場は必須です。');
      if (!eventForm.starts_at) throw new Error('開催日時は必須です。');
      if (!Number.isInteger(payload.capacity) || payload.capacity <= 0) throw new Error('定員は1以上の整数にしてください。');

      if (eventForm.id) {
        const { error } = await supabase.from('events').update(payload).eq('id', eventForm.id);
        if (error) throw error;
        setMessage('イベントを更新しました。');
      } else {
        const { error } = await supabase.from('events').insert(payload);
        if (error) throw error;
        setMessage('イベントを作成しました。');
      }

      setEventForm(EMPTY_EVENT_FORM);
      await refreshData();
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setSaving(false);
    }
  }

  async function deleteEvent(eventId) {
    const ok = window.confirm('このイベントを削除します。参加登録も削除されます。');
    if (!ok) return;
    setSaving(true);
    setErrorMessage('');
    setMessage('');

    try {
      const { error } = await supabase.from('events').delete().eq('id', eventId);
      if (error) throw error;
      setMessage('イベントを削除しました。');
      await refreshData();
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setSaving(false);
    }
  }

  async function registerForEvent(eventId) {
    setSaving(true);
    setErrorMessage('');
    setMessage('');
    try {
      const { error } = await supabase.rpc('register_event', { p_event: eventId });
      if (error) throw error;
      setMessage('イベントに参加登録しました。');
      await refreshData();
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setSaving(false);
    }
  }

  async function cancelRegistration(eventId) {
    setSaving(true);
    setErrorMessage('');
    setMessage('');
    try {
      const { error } = await supabase.rpc('cancel_registration', { p_event: eventId });
      if (error) throw error;
      setMessage('参加登録を取り消しました。');
      await refreshData();
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setSaving(false);
    }
  }

  function exportAuditLogs() {
    const rows = [
      ['id', 'created_at', 'actor_id', 'actor_name', 'entity_type', 'entity_id', 'action', 'payload'],
      ...auditLogs.map((log) => [
        log.id,
        log.created_at,
        log.actor_id,
        profilesById[log.actor_id]?.display_name ?? '-',
        log.entity_type,
        log.entity_id,
        log.action,
        JSON.stringify(log.payload ?? {}),
      ]),
    ];
    downloadCsv('audit-logs.csv', rows);
  }

  const myEvents = useMemo(() => {
    if (profile?.role === 'admin') return [];
    const myIds = new Set(registrations.map((registration) => registration.event_id));
    return events.filter((event) => myIds.has(event.id));
  }, [events, registrations, profile]);

  if (!import.meta.env.VITE_SUPABASE_URL || !import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY) {
    return (
      <div className="app-shell centered-shell">
        <div className="card warning-card">
          <h1>Supabase の環境変数が未設定です</h1>
          <p>
            <code>.env.local</code> を作成し、 <code>VITE_SUPABASE_URL</code> と
            <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> を設定してください。
          </p>
          <pre className="code-block">VITE_SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co{`\n`}VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY</pre>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="app-shell centered-shell">
        <form className="card auth-card" onSubmit={handleAuthSubmit}>
          <div className="auth-header">
            <h1>Event Manager C + Supabase</h1>
            <p>本格動的版。認証、DB、RLS、監査ログ付きです。</p>
          </div>

          <div className="mode-switch">
            <button type="button" className={authMode === 'signin' ? 'active' : ''} onClick={() => setAuthMode('signin')}>
              ログイン
            </button>
            <button type="button" className={authMode === 'signup' ? 'active' : ''} onClick={() => setAuthMode('signup')}>
              サインアップ
            </button>
          </div>

          {authMode === 'signup' && (
            <label>
              表示名
              <input
                type="text"
                value={authForm.displayName}
                onChange={(e) => setAuthForm((current) => ({ ...current, displayName: e.target.value }))}
                placeholder="例: 山田 太郎"
                required
              />
            </label>
          )}

          <label>
            メールアドレス
            <input
              type="email"
              value={authForm.email}
              onChange={(e) => setAuthForm((current) => ({ ...current, email: e.target.value }))}
              placeholder="you@example.com"
              required
            />
          </label>

          <label>
            パスワード
            <input
              type="password"
              value={authForm.password}
              onChange={(e) => setAuthForm((current) => ({ ...current, password: e.target.value }))}
              placeholder="8文字以上を推奨"
              required
            />
          </label>

          {message && <p className="message success">{message}</p>}
          {errorMessage && <p className="message error">{errorMessage}</p>}

          <button type="submit" className="primary-button" disabled={saving}>
            {saving ? '処理中...' : authMode === 'signin' ? 'ログイン' : 'サインアップ'}
          </button>

          <div className="hint-box">
            <strong>管理者にする方法</strong>
            <p>README の SQL を実行して、自分のプロフィールを admin に更新してください。</p>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div>
          <h1>Event Manager C + Supabase</h1>
          <p>
            {profile?.display_name ?? session.user.email} さん / ロール: <strong>{profile?.role ?? 'loading'}</strong>
          </p>
        </div>
        <div className="top-bar-actions">
          <button type="button" className="secondary-button" onClick={refreshData} disabled={loading}>
            再読込
          </button>
          <button type="button" className="secondary-button" onClick={handleSignOut}>
            ログアウト
          </button>
        </div>
      </header>

      <div className="layout-grid">
        <aside className="sidebar card">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="イベント検索"
          />

          <nav className="nav-list">
            {visibleTabs.map((tab) => (
              <button
                key={tab}
                type="button"
                className={activeTab === tab ? 'active' : ''}
                onClick={() => setActiveTab(tab)}
              >
                {tab === 'events' && 'イベント一覧'}
                {tab === 'my-events' && 'マイイベント'}
                {tab === 'dashboard' && 'ダッシュボード'}
                {tab === 'audit' && '監査ログ'}
              </button>
            ))}
          </nav>

          <div className="mini-stats">
            <div>
              <span>イベント数</span>
              <strong>{events.length}</strong>
            </div>
            <div>
              <span>今後の予定</span>
              <strong>{upcomingEvents.length}</strong>
            </div>
            <div>
              <span>自分の参加</span>
              <strong>{myRegistrationEventIds.size}</strong>
            </div>
          </div>
        </aside>

        <main className="main-column">
          {message && <div className="message success card">{message}</div>}
          {errorMessage && <div className="message error card">{errorMessage}</div>}
          {loading && <div className="card">読み込み中です...</div>}

          {!loading && activeTab === 'events' && (
            <section className="section-grid">
              <div className="card list-card">
                <div className="card-header-row">
                  <h2>イベント一覧</h2>
                  {profile?.role === 'admin' && (
                    <button type="button" className="primary-button" onClick={startCreateEvent}>
                      新規作成
                    </button>
                  )}
                </div>
                <div className="event-list">
                  {filteredEvents.map((eventItem) => {
                    const registeredCount = registrationCountByEvent.get(eventItem.id) ?? 0;
                    const isRegistered = myRegistrationEventIds.has(eventItem.id);
                    const isFull = registeredCount >= eventItem.capacity;
                    return (
                      <button
                        key={eventItem.id}
                        type="button"
                        className={`event-list-item ${selectedEvent?.id === eventItem.id ? 'selected' : ''}`}
                        onClick={() => setSelectedEventId(eventItem.id)}
                      >
                        <div>
                          <strong>{eventItem.title}</strong>
                          <span>{formatDateTime(eventItem.starts_at)}</span>
                        </div>
                        <div className="pill-row">
                          <span className="pill">{registeredCount}/{eventItem.capacity}</span>
                          {isRegistered && <span className="pill success-pill">参加中</span>}
                          {isFull && <span className="pill warning-pill">満席</span>}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="card detail-card">
                {selectedEvent ? (
                  <>
                    <div className="card-header-row">
                      <div>
                        <h2>{selectedEvent.title}</h2>
                        <p>{formatDateTime(selectedEvent.starts_at)} / {selectedEvent.venue}</p>
                      </div>
                      <div className="pill-row">
                        <span className="pill">作成者 {profilesById[selectedEvent.created_by]?.display_name ?? '-'}</span>
                        <span className="pill">{registrationCountByEvent.get(selectedEvent.id) ?? 0}/{selectedEvent.capacity}</span>
                      </div>
                    </div>

                    <p className="description-block">{selectedEvent.description || '説明は未入力です。'}</p>

                    <div className="action-row">
                      {profile?.role === 'admin' ? (
                        <>
                          <button type="button" className="secondary-button" onClick={() => startEditEvent(selectedEvent)}>
                            編集
                          </button>
                          <button type="button" className="danger-button" onClick={() => deleteEvent(selectedEvent.id)} disabled={saving}>
                            削除
                          </button>
                        </>
                      ) : myRegistrationEventIds.has(selectedEvent.id) ? (
                        <button type="button" className="secondary-button" onClick={() => cancelRegistration(selectedEvent.id)} disabled={saving}>
                          参加取消
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="primary-button"
                          onClick={() => registerForEvent(selectedEvent.id)}
                          disabled={saving || (registrationCountByEvent.get(selectedEvent.id) ?? 0) >= selectedEvent.capacity}
                        >
                          参加する
                        </button>
                      )}
                    </div>
                  </>
                ) : (
                  <p>イベントがありません。</p>
                )}
              </div>

              {profile?.role === 'admin' && (
                <form className="card form-card" onSubmit={saveEvent}>
                  <div className="card-header-row">
                    <h2>{eventForm.id ? 'イベント編集' : 'イベント作成'}</h2>
                    {eventForm.id && (
                      <button type="button" className="secondary-button" onClick={startCreateEvent}>
                        新規作成に戻す
                      </button>
                    )}
                  </div>

                  <label>
                    タイトル
                    <input
                      type="text"
                      value={eventForm.title}
                      onChange={(e) => setEventForm((current) => ({ ...current, title: e.target.value }))}
                      required
                    />
                  </label>

                  <label>
                    説明
                    <textarea
                      rows="4"
                      value={eventForm.description}
                      onChange={(e) => setEventForm((current) => ({ ...current, description: e.target.value }))}
                    />
                  </label>

                  <label>
                    会場
                    <input
                      type="text"
                      value={eventForm.venue}
                      onChange={(e) => setEventForm((current) => ({ ...current, venue: e.target.value }))}
                      required
                    />
                  </label>

                  <div className="two-col-grid">
                    <label>
                      開催日時
                      <input
                        type="datetime-local"
                        value={eventForm.starts_at}
                        onChange={(e) => setEventForm((current) => ({ ...current, starts_at: e.target.value }))}
                        required
                      />
                    </label>
                    <label>
                      定員
                      <input
                        type="number"
                        min="1"
                        value={eventForm.capacity}
                        onChange={(e) => setEventForm((current) => ({ ...current, capacity: Number(e.target.value) }))}
                        required
                      />
                    </label>
                  </div>

                  <button type="submit" className="primary-button" disabled={saving}>
                    {saving ? '保存中...' : eventForm.id ? '更新する' : '作成する'}
                  </button>
                </form>
              )}
            </section>
          )}

          {!loading && activeTab === 'my-events' && profile?.role !== 'admin' && (
            <section className="card">
              <h2>マイイベント</h2>
              {myEvents.length === 0 ? (
                <p>まだ参加しているイベントはありません。</p>
              ) : (
                <div className="stack-list">
                  {myEvents.map((eventItem) => (
                    <div key={eventItem.id} className="stack-item">
                      <div>
                        <strong>{eventItem.title}</strong>
                        <p>{formatDateTime(eventItem.starts_at)} / {eventItem.venue}</p>
                      </div>
                      <button type="button" className="secondary-button" onClick={() => cancelRegistration(eventItem.id)} disabled={saving}>
                        取消
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {!loading && activeTab === 'dashboard' && profile?.role === 'admin' && (
            <section className="section-grid single-column">
              <div className="stats-grid">
                <div className="card stat-card"><span>総イベント</span><strong>{dashboardStats.totalEvents}</strong></div>
                <div className="card stat-card"><span>総参加登録</span><strong>{dashboardStats.totalRegistrations}</strong></div>
                <div className="card stat-card"><span>今後のイベント</span><strong>{dashboardStats.upcomingCount}</strong></div>
                <div className="card stat-card"><span>満席イベント</span><strong>{dashboardStats.fullCount}</strong></div>
              </div>

              <div className="card">
                <h2>イベント別の充足率</h2>
                <div className="stack-list">
                  {events.map((eventItem) => {
                    const count = registrationCountByEvent.get(eventItem.id) ?? 0;
                    const ratio = Math.min(100, Math.round((count / eventItem.capacity) * 100));
                    return (
                      <div key={eventItem.id} className="occupancy-row">
                        <div>
                          <strong>{eventItem.title}</strong>
                          <p>{formatDateTime(eventItem.starts_at)} / {eventItem.venue}</p>
                        </div>
                        <div className="occupancy-bar-wrap">
                          <div className="occupancy-bar" style={{ width: `${ratio}%` }} />
                        </div>
                        <span>{count}/{eventItem.capacity}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>
          )}

          {!loading && activeTab === 'audit' && profile?.role === 'admin' && (
            <section className="card">
              <div className="card-header-row">
                <h2>監査ログ</h2>
                <button type="button" className="secondary-button" onClick={exportAuditLogs}>
                  CSVエクスポート
                </button>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>日時</th>
                      <th>操作者</th>
                      <th>対象</th>
                      <th>アクション</th>
                      <th>内容</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditLogs.map((log) => (
                      <tr key={log.id}>
                        <td>{formatDateTime(log.created_at)}</td>
                        <td>{profilesById[log.actor_id]?.display_name ?? log.actor_id ?? '-'}</td>
                        <td>{log.entity_type}</td>
                        <td>{log.action}</td>
                        <td><code>{JSON.stringify(log.payload ?? {})}</code></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
