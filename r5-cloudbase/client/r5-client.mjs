/* R5 browser bridge v0.1 — no admin API keys or parental passwords.
 * Inject an already authenticated CloudBase rdb() from the hosting application.
 * Same module can be imported by little-racing-v2 after authentication is set up.
 * Does NOT clear/overwrite any V6 or racing localStorage keys.
 */
export const R5_FAMILY = 'little-growth-family-001';
export const R5_ENV = 'normal-goose-d5g4qyzr8bb389a4a';

function unwrap(result) {
  if (!result) throw new Error('R5_EMPTY_RESPONSE');
  if (result.error) throw new Error(String(result.error.message || result.error));
  const data = result.data === undefined ? result : result.data;
  if (Array.isArray(data)) {
    if (data.length !== 1) throw new Error('R5_UNEXPECTED_RESULT');
    return data[0];
  }
  if (typeof data !== 'object' || data === null) throw new Error('R5_INVALID_JSON');
  return data;
}
export function makeR5Client(db, familyId = R5_FAMILY) {
  if (!db || typeof db.rpc !== 'function') throw new Error('R5_RDB_REQUIRED');
  if (!familyId || typeof familyId !== 'string') throw new Error('R5_FAMILY_REQUIRED');
  async function invoke(name, params) {
    // SDK attaches the authenticated end-user token. Never fall back to admin keys.
    return unwrap(await db.rpc(name, { p_family_id: familyId, ...params }));
  }
  return Object.freeze({
    publishToday: ({dayIndex, noTasks = false}) => {
      if (!Number.isInteger(dayIndex) || dayIndex < 1 || dayIndex > 30 ||
          typeof noTasks !== 'boolean') throw new Error('R5_INVALID_DAY');
      return invoke('r5_publish_today', {
        p_day_index: dayIndex, p_no_tasks: noTasks
      });
    },
    status: () => invoke('r5_status', {}),
    start: () => invoke('r5_game_action', { p_action: 'start' }),
    tick: () => invoke('r5_game_action', { p_action: 'tick' }),
    stop: () => invoke('r5_game_action', { p_action: 'stop' }),
    parentUpdate: ({enabled, dailySeconds = 1800, bonusSeconds = 0}) => {
      if (typeof enabled !== 'boolean' || !Number.isInteger(dailySeconds) ||
          !Number.isInteger(bonusSeconds)) throw new Error('R5_INVALID_SETTINGS');
      return invoke('r5_parent_update', {
        p_enabled: enabled, p_daily_seconds: dailySeconds, p_bonus_seconds: bonusSeconds
      });
    }
  });
}

/** Call enter() on the FIRST frame of the racing homepage, not race start.
 * Call leave() on in-game exit/home navigation. Heartbeats cover racing,
 * story and free roam equally. Fail closed if connection/auth fails.
 */
export function createR5GameClock(client, {onState = () => {}, onDenied = () => {}, onError = () => {}} = {}) {
  let timer = null, active = false, busy = false;
  const emit = state => {
    onState(state);
    if (!state.allowed || state.remaining_seconds <= 0 || !state.active) {
      active = false;
      if (timer !== null) { clearInterval(timer); timer = null; }
      if (!state.allowed || state.remaining_seconds <= 0) onDenied(state);
    }
    return state;
  };
  async function call(action) {
    if (busy) return;
    busy = true;
    try { return emit(await client[action]()); }
    catch (e) {
      active = false;
      if (timer !== null) { clearInterval(timer); timer = null; }
      onError(e);
      onDenied({allowed:false,reason:'NETWORK_OR_AUTH_UNAVAILABLE',remaining_seconds:0});
      throw e;
    } finally { busy = false; }
  }
  async function enter() {
    const state = await call('start');
    if (state && state.allowed && state.active && state.remaining_seconds > 0) {
      active = true;
      if (timer === null) timer = setInterval(() => { if (active) call('tick').catch(() => {}); }, 10000);
    }
    return state;
  }
  async function leave() {
    active = false;
    if (timer !== null) { clearInterval(timer); timer = null; }
    return call('stop');
  }
  function onVisibility() {
    if (typeof document === 'undefined') return;
    if (document.hidden) leave().catch(() => {});
    else enter().catch(() => {});
  }
  function attachLifecycle() {
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
  }
  function onPageHide() { leave().catch(() => {}); }
  function dispose() {
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide);
    if (timer !== null) { clearInterval(timer); timer = null; }
    active = false;
  }
  return Object.freeze({enter,leave,dispose,attachLifecycle});
}
