// =============================================================
// Supabase cloud sync — mirrors this dashboard's data to a single
// shared `user_data` table (columns: user_id, key, value, updated_at)
// so every device signed into the same dashboard sees the same data.
//
// Requires:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="sync.js" defer></script>
//
// Reads Supabase credentials from the 'settings-api' localStorage
// object ({ supabaseUrl, supabaseKey, ... }) set via the dashboard's
// Settings modal.
// =============================================================
(function () {
  'use strict';

  // Shared across every device — NOT per-device, so phone/laptop/etc.
  // all read and write the same rows and actually sync with each other.
  const USER_ID = 'daniel';

  // Exact localStorage keys to mirror.
  const SYNC_EXACT_KEYS = [
    'body-goal',
    'future-self-profile',
    'wochenplan-custom',
    'settings-api',
    'settings-notifications',
  ];
  // localStorage key prefixes to mirror (covers the date/id-suffixed
  // keys actually used across the dashboard's pages).
  const SYNC_KEY_PREFIXES = [
    'tasks-',            // tasks-{date}, tasks-all (main.html / tasks.html Kanban)
    'routines:',         // routines:items, routines:done:{date}
    'stack:',            // stack:items, stack:taken:{date}, stack:version, stack:low
    'future-self-',      // future-self-{date} daily brief cache
    'journal:',          // journal:{date}
    'journal-insights-', // journal-insights-{date}
    'weekly-review-',    // weekly-review-{ISO week}
    'ki-analyse-',       // ki-analyse-{date}
    'traumplan-',        // traumplan-3, traumplan-6, traumplan-12
  ];

  function matchesSyncKey(key) {
    if (!key) return false;
    if (SYNC_EXACT_KEYS.indexOf(key) !== -1) return true;
    for (let i = 0; i < SYNC_KEY_PREFIXES.length; i++) {
      if (key.indexOf(SYNC_KEY_PREFIXES[i]) === 0) return true;
    }
    return false;
  }
  function listSyncedKeys() {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (matchesSyncKey(k)) out.push(k);
    }
    return out;
  }

  /* ---------- sync dot ---------- */
  function setSyncDot(status) {
    const dot = document.getElementById('sync-dot');
    if (!dot) return;
    if (status === 'synced') {
      dot.style.background = '#22c55e';
      dot.style.animation = 'none';
    } else if (status === 'syncing') {
      dot.style.background = '#f5a623';
      dot.style.animation = 'pulse 1s infinite';
    } else {
      dot.style.background = '#ef4444';
      dot.style.animation = 'pulse 0.5s infinite';
    }
  }

  /* ---------- Supabase client ---------- */
  function getSupabaseClient() {
    let settings;
    try { settings = JSON.parse(localStorage.getItem('settings-api') || '{}'); } catch (e) { settings = {}; }
    if (!settings.supabaseUrl || !settings.supabaseKey) return null;
    if (typeof supabase === 'undefined') return null;
    if (window._sb) return window._sb;
    window._sb = supabase.createClient(
      settings.supabaseUrl,
      settings.supabaseKey,
      { auth: { persistSession: true, autoRefreshToken: true } }
    );
    return window._sb;
  }

  /* ---------- last-write-wins bookkeeping ----------
     Real localStorage values don't carry an `_updated` timestamp, so
     instead of trusting one, we record when THIS device last pushed
     successfully. On pull, a remote row only overwrites the local
     value if it was written (by some device) after that — i.e. it's
     genuinely newer than anything we've already synced. */
  const LAST_PUSH_KEY = 'sync-last-push-at';
  function getLastPushTime() { return Number(localStorage.getItem(LAST_PUSH_KEY)) || 0; }
  function setLastPushTime(ts) { try { localStorage.setItem(LAST_PUSH_KEY, String(ts)); } catch (e) {} }

  /* ---------- push: every 30 seconds ---------- */
  async function syncPush() {
    const sb = getSupabaseClient();
    if (!sb) return;
    setSyncDot('syncing');
    const now = new Date().toISOString();
    try {
      for (const key of listSyncedKeys()) {
        const value = localStorage.getItem(key);
        if (value === null) continue;
        await sb.from('user_data').upsert({
          user_id: USER_ID,
          key,
          value,
          updated_at: now,
        }, { onConflict: 'user_id,key' });
      }
      setLastPushTime(Date.now());
      setSyncDot('synced');
    } catch (e) {
      setSyncDot('offline');
    }
  }

  /* ---------- pull: on load ---------- */
  async function syncPull() {
    const sb = getSupabaseClient();
    if (!sb) return;
    const lastPush = getLastPushTime();
    try {
      const { data } = await sb
        .from('user_data')
        .select('*')
        .eq('user_id', USER_ID);
      if (!data) return;
      data.forEach((row) => {
        if (!matchesSyncKey(row.key)) return;
        const remoteTime = new Date(row.updated_at).getTime();
        if (remoteTime > lastPush) {
          localStorage.setItem(row.key, row.value);
        }
      });
    } catch (e) {}
  }

  /* ---------- realtime ---------- */
  function refreshCurrentPage() {
    window.location.reload();
  }
  function setupRealtime(sb) {
    sb.channel('sync')
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'user_data',
        filter: 'user_id=eq.' + USER_ID,
      }, (payload) => {
        if (!payload.new || !payload.new.key) return;
        const incoming = payload.new.value;
        const current = localStorage.getItem(payload.new.key);
        if (incoming === current) return; // already up to date (e.g. our own push echoing back)
        localStorage.setItem(payload.new.key, incoming);
        refreshCurrentPage();
      })
      .subscribe();
  }

  /* ---------- start ---------- */
  syncPull().then(() => {
    setInterval(syncPush, 30000);
  });

  const sbForRealtime = getSupabaseClient();
  if (sbForRealtime) setupRealtime(sbForRealtime);

  window.addEventListener('online', () => syncPush());
  window.addEventListener('offline', () => setSyncDot('offline'));
})();
