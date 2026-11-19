// 利用認証だけをSupabaseに送る。カメラ本体は利用許可を確認してから読み込む。
const PROJECT = 'https://wufbvfumsrwkgxsztuea.supabase.co';
const PUBLIC_KEY = 'sb_publishable_IDnv0PEI1gDYZqy8s00bjA_P3wmRkfA';
const MAX_AGE = 30 * 86400000;
const PREFIX = 'kokuban-access-v1:' + new URL('.', import.meta.url).pathname;
const $ = id => document.getElementById(id);
let dbPromise, activeUser, monotonicEnd = 0, wallEnd = 0, timer, deadlineTimer, checking, stopping = false;

function database() {
  if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
    const r = indexedDB.open(PREFIX, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('auth');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbPromise;
}
async function record(action, key, value) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('auth', action === 'get' ? 'readonly' : 'readwrite');
    const s = tx.objectStore('auth');
    const req = action === 'put' ? s.put(value, key) : s[action](key);
    tx.oncomplete = () => resolve(req.result);
    tx.onabort = () => reject(tx.error || new Error('認証情報を保存できません'));
  });
}
async function vaultKey() {
  let key = await record('get', 'key');
  if (!key) {
    key = await crypto.subtle.generateKey({name:'AES-GCM', length:256}, false, ['encrypt','decrypt']);
    await record('put', 'key', key);
  }
  return key;
}
async function readSession() {
  const sealed = await record('get', 'session');
  if (!sealed) return null;
  try {
    const raw = await crypto.subtle.decrypt({name:'AES-GCM', iv:sealed.iv}, await vaultKey(), sealed.ct);
    return JSON.parse(new TextDecoder().decode(raw));
  } catch { await record('delete', 'session'); return null; }
}
async function saveSession(session) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const raw = new TextEncoder().encode(JSON.stringify(session));
  const ct = await crypto.subtle.encrypt({name:'AES-GCM', iv}, await vaultKey(), raw);
  await record('put', 'session', {iv, ct});
}
class HttpError extends Error {
  constructor(status) { super('認証サーバーからの応答 ' + status); this.status = status; }
}
class OfflineError extends Error {}
async function post(path, body, token) {
  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(), 8000);
  try {
    const headers = {apikey:PUBLIC_KEY, 'Content-Type':'application/json'};
    if (token) headers.Authorization = 'Bearer ' + token;
    let r;
    try {
      r = await fetch(PROJECT + path, {method:'POST', body:JSON.stringify(body), headers,
        cache:'no-store', credentials:'omit', redirect:'error', referrerPolicy:'no-referrer', signal:ctl.signal});
    } catch { throw new OfflineError(); }
    if (!r.ok) throw new HttpError(r.status);
    return await r.json();
  } finally { clearTimeout(timeout); }
}
function transient(e) {
  return e instanceof OfflineError || e.name === 'AbortError' || e.status === 408 || e.status === 429 || e.status >= 500;
}
function remaining(s) {
  if (!s || !Number.isFinite(s.until) || !Number.isFinite(s.at) || !Number.isFinite(s.wall)) return 0;
  const now = Date.now();
  if (now + 1000 < s.wall || now + 1000 < (s.seen || 0)) return 0;
  return Math.min(MAX_AGE, s.until - s.at) - Math.max(0, now - s.wall);
}
function useTokens(s, t) {
  if (!t.user?.id || !t.access_token || !t.refresh_token || (s.uid && t.user.id !== s.uid)) throw new Error('認証結果が正しくありません');
  Object.assign(s, {uid:t.user.id, access:t.access_token, refresh:t.refresh_token});
}
function gate(message) {
  $('workspace').hidden = true;
  $('account-gate').hidden = false;
  $('account-message').textContent = message;
}
async function evaluate(credentials) {
  let s = credentials ? {} : await readSession();
  if (!credentials && !remainingValid(s)) {
    if (s) await record('delete', 'session');
    return {message:s ? '利用期限または端末の時刻を確認し、オンラインで再認証してください。' : '登録済みのメールアドレスとパスワードでログインしてください。'};
  }
  try {
    if (!navigator.onLine) throw new OfflineError();
    if (credentials) useTokens(s, await post('/auth/v1/token?grant_type=password', credentials));
    const status = () => post('/rest/v1/rpc/kokuban_check_access', {}, s.access);
    let g;
    try { g = await status(); } catch (e) {
      if (credentials || e.status !== 401) throw e;
      useTokens(s, await post('/auth/v1/token?grant_type=refresh_token', {refresh_token:s.refresh}));
      await saveSession(s);
      g = await status();
    }
    const at = g.now_s * 1000, until = g.until_s * 1000;
    if (g.allowed !== true || g.user_id !== s.uid || !Number.isSafeInteger(at) || !Number.isSafeInteger(until) ||
        until <= at || until - at > MAX_AGE + 5000) {
      await record('delete', 'session');
      return {message:'利用が停止されているか、利用期限が切れています。'};
    }
    Object.assign(s, {at, until:credentials ? until : Math.min(s.until, until), wall:Date.now(), seen:Date.now()});
  } catch (e) {
    if (!transient(e)) {
      await record('delete', 'session');
      return {message:credentials ? 'ログインできません。入力内容と利用許可を確認してください。' : '認証が無効です。再度ログインしてください。'};
    }
    if (credentials || !remainingValid(s)) return {message:'初回・期限後の認証にはインターネット接続が必要です。'};
    s.seen = Math.max(s.seen || 0, Date.now());
  }
  await saveSession(s);
  return {session:s};
}
function remainingValid(s) { return remaining(s) > 0; }

async function block(message) {
  clearTimeout(timer);
  clearTimeout(deadlineTimer);
  gate(message);
  if (activeUser && !stopping) {
    stopping = true;
    activeUser = null;
    const camera = await import('./app.js');
    try { await camera.suspendCamera(); } finally { location.reload(); }
  }
}
function armDeadline() {
  clearTimeout(deadlineTimer);
  const ms = Math.min(wallEnd - Date.now(), monotonicEnd - performance.now());
  if (ms > 0) deadlineTimer = setTimeout(armDeadline, Math.min(86400000, Math.max(1, ms)));
  else block('利用期限が切れました。再認証してください。');
}
async function check(credentials) {
  if (stopping || checking) return checking;
  checking = (async () => {
    $('account-submit').disabled = true;
    try {
      if (!navigator.locks) throw new Error('このSafariでは認証情報を安全に更新できません。iOSを更新してください。');
      const result = await navigator.locks.request(PREFIX, () => evaluate(credentials));
      if (stopping) return;
      if (!result.session) return await block(result.message);
      const s = result.session, ms = remaining(s);
      if (ms <= 0 || (activeUser && activeUser !== s.uid)) return await block('利用者または利用期限が変わりました。');
      wallEnd = Date.now() + ms;
      // 同じページを開いている間は、端末の時計を戻しても利用期限を延長しない。
      const limit = performance.now() + ms;
      monotonicEnd = activeUser ? Math.min(monotonicEnd, limit) : limit;
      if (performance.now() >= monotonicEnd) return await block('再認証が必要です。');
      if (!activeUser) {
        const camera = await import('./app.js');
        await camera.startApp(s.uid, canUse);
        activeUser = s.uid;
        if (!canUse()) return await block('再認証が必要です。');
        $('account-gate').hidden = true;
        $('workspace').hidden = false;
        window.dispatchEvent(new Event('resize'));
      }
      $('account-expiry').textContent = new Date(s.until).toLocaleString('ja-JP');
      armDeadline();
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!canUse()) block('利用期限が切れました。再認証してください。');
        else check();
      }, Math.min(60000, Math.max(1, monotonicEnd - performance.now()), Math.max(1, wallEnd - Date.now())));
    } catch (e) {
      await block(e.message || '認証状態を確認できませんでした。');
    } finally { checking = null; $('account-submit').disabled = false; }
  })();
  return checking;
}
function canUse() { return !!activeUser && !stopping && Date.now() < wallEnd && performance.now() < monotonicEnd; }
$('account-form').addEventListener('submit', e => {
  e.preventDefault();
  const password = $('account-password').value;
  $('account-password').value = '';
  $('account-message').textContent = '利用許可を確認しています…';
  check({email:$('account-email').value.trim(), password});
});
window.addEventListener('online', () => check());
window.addEventListener('pageshow', () => check());
document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js', {updateViaCache:'none'}).catch(() => {});
check();
