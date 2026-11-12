// 工事黒板カメラ 本体
import * as db from './db.js';
import { createVault, openVault, rewrapVault, encryptBytes, decryptBytes, encryptJson, decryptJson, sha256Hex,
  sealWithPassword, openWithPassword, randomBytes } from './crypto.js';
import { defaultBoard, renderBoard, measureBoard, stepNumber, boardText, newFieldId, formatDate } from './board.js';
import { addJpegMeta } from './jpegmeta.js';
import { ZipWriter, readZip } from './zip.js';

const VERSION = '1.0.0';
const $ = (id) => document.getElementById(id);

const DEFAULT_SETTINGS = {
  size: 1600, quality: 0.92, burstMs: 1000, quickField: 'sokuten', dateMode: 'ad', sound: true,
  lockAfter: 60, burstOn: false, autoInc: false,
};

const S = {
  key: null,
  board: null,
  presets: [],
  recents: {},
  settings: { ...DEFAULT_SETTINGS },
  activePreset: null,
  photos: [], // { id, createdAt, meta }（新しい順）
  photosLoaded: false,
  stream: null, track: null,
  queue: Promise.resolve(), pending: 0,
  urls: new Set(),
  lastActive: Date.now(), hiddenAt: 0,
  galSelect: false, selected: new Set(), galList: [], viewIndex: 0,
  edStructure: false,
  frame: null,
};

// ---------- 小物 ----------
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
  if (S.track) S.track.enabled = id === 'screen-camera';
  if (id === 'screen-camera') {
    requestAnimationFrame(layoutFrame);
    if (S.key && !S.stream) startCamera();
  }
}

let toastTimer;
function toast(msg, ms = 2200) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

function busy(text) {
  $('busy-text').textContent = text || '処理中…';
  $('busy').hidden = !text;
}

// 汎用ダイアログ。buttons: [{label, value, primary, danger, onClick}]
// onClick はクリック処理の中で同期的に呼ぶ（iPhoneの共有シートに必要）
function modal({ title, body, buttons, inputs }) {
  return new Promise((resolve) => {
    $('modal-title').textContent = title || '';
    const b = $('modal-body');
    b.replaceChildren();
    if (typeof body === 'string') body.split('\n').forEach((ln) => b.append(h('p', { text: ln })));
    else if (body) b.append(body);
    const fields = (inputs || []).map((inp) => {
      const el = h('input', { type: inp.type || 'text', placeholder: inp.placeholder || '', value: inp.value || '', autocomplete: 'off' });
      b.append(h('label', { class: 'field' }, inp.label || '', el));
      return el;
    });
    const bb = $('modal-buttons');
    bb.replaceChildren();
    for (const btn of buttons || [{ label: 'OK', value: true, primary: true }]) {
      bb.append(h('button', {
        class: 'btn wide' + (btn.primary ? ' primary' : '') + (btn.danger ? ' danger' : ''),
        text: btn.label,
        onclick: () => {
          const vals = fields.map((f) => f.value);
          let r;
          if (btn.onClick) r = btn.onClick(vals);
          if (btn.keepOpen) return;
          $('modal').hidden = true;
          Promise.resolve(r).catch(() => {}).finally(() => resolve(inputs ? { value: btn.value, vals } : btn.value));
        },
      }));
    }
    $('modal').hidden = false;
    if (fields[0]) setTimeout(() => fields[0].focus(), 50);
  });
}
const alertBox = (title, body) => modal({ title, body, buttons: [{ label: 'OK', value: true, primary: true }] });
const confirmBox = (title, body, okLabel = 'OK', danger = false) =>
  modal({ title, body, buttons: [{ label: okLabel, value: true, primary: !danger, danger }, { label: 'キャンセル', value: false }] });

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
const z2 = (n) => String(n).padStart(2, '0');
function dayKey(t) { const d = new Date(t); return `${d.getFullYear()}-${z2(d.getMonth() + 1)}-${z2(d.getDate())}`; }
function dateTimeStr(t) { const d = new Date(t); return `${d.getFullYear()}/${z2(d.getMonth() + 1)}/${z2(d.getDate())} ${z2(d.getHours())}:${z2(d.getMinutes())}:${z2(d.getSeconds())}`; }
function newId() { return 'p' + Date.now().toString(36) + Array.from(randomBytes(4), (b) => b.toString(16).padStart(2, '0')).join(''); }
function trackUrl(u) { S.urls.add(u); return u; }

// ---------- 状態の保存（暗号化） ----------
let saveTimer;
function saveState(now = false) {
  clearTimeout(saveTimer);
  const doSave = async () => {
    if (!S.key) return;
    const box = await encryptJson(S.key, {
      board: S.board, presets: S.presets, recents: S.recents, settings: S.settings, activePreset: S.activePreset,
    }, 'kv:state');
    await db.put('kv', box, 'state');
  };
  if (now) return doSave();
  saveTimer = setTimeout(() => doSave().catch((e) => console.error(e)), 400);
}

async function loadState() {
  const box = await db.get('kv', 'state');
  const st = box ? await decryptJson(S.key, box, 'kv:state') : {};
  S.board = st.board || defaultBoard();
  if (!S.board.pos) S.board.pos = defaultBoard().pos;
  S.presets = st.presets || [];
  S.recents = st.recents || {};
  S.settings = { ...DEFAULT_SETTINGS, ...(st.settings || {}) };
  S.activePreset = st.activePreset || null;
}

// ---------- 初回設定・ロック ----------
async function getSec() { return (await db.get('meta', 'sec')) || { fails: 0, until: 0, wipeAt: 0 }; }

async function doSetup() {
  const p1 = $('setup-pass').value, p2 = $('setup-pass2').value;
  if (p1.length < 6) return ($('setup-msg').textContent = '6文字以上にしてください');
  if (p1 !== p2) return ($('setup-msg').textContent = '2回の入力が一致しません');
  busy('暗号鍵を作成中…');
  try {
    const { vault, key } = await createVault(p1);
    await db.put('meta', vault, 'vault');
    await db.put('meta', { fails: 0, until: 0, wipeAt: 0 }, 'sec');
    S.key = key;
    $('setup-pass').value = $('setup-pass2').value = '';
    await loadState();
    await saveState(true);
    try { await navigator.storage?.persist?.(); } catch {}
    await afterUnlock();
  } catch (e) {
    $('setup-msg').textContent = '作成に失敗しました: ' + e.message;
  } finally { busy(); }
}

async function doUnlock() {
  const pass = $('lock-pass').value;
  const msg = $('lock-msg');
  const sec = await getSec();
  if (Date.now() < sec.until) {
    msg.textContent = `あと ${Math.ceil((sec.until - Date.now()) / 1000)} 秒待ってから入力してください`;
    return;
  }
  const vault = await db.get('meta', 'vault');
  busy('確認中…');
  try {
    const { key, dekRaw } = await openVault(vault, pass);
    dekRaw.fill(0);
    S.key = key;
    sec.fails = 0; sec.until = 0;
    await db.put('meta', sec, 'sec');
    $('lock-pass').value = '';
    msg.textContent = '';
    await loadState();
    await afterUnlock();
  } catch (e) {
    if (S.key) { busy(); console.error(e); msg.textContent = '読み込みエラー: ' + e.message; return; }
    sec.fails++;
    if (sec.wipeAt && sec.fails >= sec.wipeAt) {
      await db.wipeAll();
      busy();
      await alertBox('データを消去しました', `パスコードを${sec.wipeAt}回間違えたため、設定どおり全データを消去しました。`);
      location.reload();
      return;
    }
    if (sec.fails >= 5) sec.until = Date.now() + Math.min(15 * 60, 5 * 2 ** (sec.fails - 5)) * 1000;
    await db.put('meta', sec, 'sec');
    msg.textContent = `パスコードが違います（${sec.fails}回目）` + (sec.wipeAt ? ` ／ ${sec.wipeAt}回で全消去` : '');
  } finally { busy(); }
}

async function afterUnlock() {
  S.lastActive = Date.now();
  applySettingsToUi();
  renderPresetBar();
  updateQuick();
  show('screen-camera');
  loadPhotos().catch((e) => console.error(e));
}

async function lock() {
  if (!S.key) return;
  show('screen-lock');
  $('editor').hidden = true;
  $('modal').hidden = true;
  stopBurst();
  stopCamera();
  try { await S.queue; } catch {}
  await saveState(true).catch(() => {});
  S.key = null;
  S.photos = []; S.photosLoaded = false; S.board = null; S.presets = []; S.recents = {};
  S.selected.clear(); S.galList = [];
  for (const u of S.urls) URL.revokeObjectURL(u);
  S.urls.clear();
  $('gal-grid').replaceChildren();
  $('vw-img').removeAttribute('src');
  $('vw-info').replaceChildren();
  $('last-thumb').removeAttribute('src');
  $('ed-fields').replaceChildren();
  $('vf-result').replaceChildren();
}

// ---------- カメラ ----------
let cameraStarting = null;
function startCamera() {
  if (S.stream) { S.track.enabled = !$('screen-camera').hidden; return Promise.resolve(); }
  if (!cameraStarting) cameraStarting = startCameraInner().finally(() => { cameraStarting = null; });
  return cameraStarting;
}

async function startCameraInner() {
  const msg = $('cam-msg');
  if (!navigator.mediaDevices?.getUserMedia) {
    msg.hidden = false;
    msg.textContent = 'このブラウザではカメラを使えません。iPhoneのSafariで開き、ホーム画面に追加してから起動してください。';
    return;
  }
  try {
    S.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 4032 }, height: { ideal: 3024 } },
    });
  } catch (e) {
    msg.hidden = false;
    msg.textContent = 'カメラを起動できません。「設定」アプリ → Safari → カメラ を「許可」にするか、表示された確認で「許可」を押してください。（' + e.name + '）';
    return;
  }
  if (!S.key) { stopCamera(); return; }
  msg.hidden = true;
  const v = $('video');
  v.srcObject = S.stream;
  S.track = S.stream.getVideoTracks()[0];
  try { await v.play(); } catch {}
  const caps = S.track.getCapabilities?.() || {};
  const zoom = $('zoom');
  if (caps.zoom && caps.zoom.max > caps.zoom.min) {
    zoom.min = caps.zoom.min; zoom.max = Math.min(caps.zoom.max, 10); zoom.step = caps.zoom.step || 0.1;
    zoom.value = S.track.getSettings?.().zoom || caps.zoom.min;
    zoom.hidden = false;
  } else zoom.hidden = true;
  $('btn-torch').hidden = !caps.torch;
  layoutFrame();
}

function stopCamera() {
  if (S.stream) for (const t of S.stream.getTracks()) t.stop();
  S.stream = null; S.track = null;
  $('video').srcObject = null;
}

function photoOrient(w, hgt) { return w >= hgt ? 'l' : 'p'; }

function clampPos(pos, aspect) {
  // aspect = 写真の高さ / 幅
  pos.w = Math.min(1, Math.max(0.15, pos.w));
  const hFrac = measureBoard(S.board, pos.w) / aspect;
  pos.x = Math.min(1 - pos.w, Math.max(0, pos.x));
  pos.y = Math.min(Math.max(0, 1 - hFrac), Math.max(0, pos.y));
  return pos;
}

function layoutFrame() {
  const v = $('video');
  const vw = v.videoWidth, vh = v.videoHeight;
  const stage = $('stage');
  const sw = stage.clientWidth, sh = stage.clientHeight;
  // 映像が来ていない間は 4:3 で仮表示（黒板の位置を確認できるように）
  const iw = vw || (sw > sh ? 4 : 3), ih = vh || (sw > sh ? 3 : 4);
  const s = Math.min(sw / iw, sh / ih);
  const dw = iw * s, dh = ih * s;
  const f = $('frame');
  f.style.left = (sw - dw) / 2 + 'px';
  f.style.top = (sh - dh) / 2 + 'px';
  f.style.width = dw + 'px';
  f.style.height = dh + 'px';
  S.frame = { w: dw, h: dh, orient: photoOrient(iw, ih) };
  drawOverlay();
}

function curPos() {
  const o = S.frame?.orient || 'p';
  if (!S.board.pos[o]) S.board.pos[o] = defaultBoard().pos[o];
  return S.board.pos[o];
}

function drawOverlay() {
  if (!S.board || !S.frame) return;
  const { w: fw, h: fh } = S.frame;
  const pos = clampPos(curPos(), fh / fw);
  const bw = pos.w * fw;
  const bh = measureBoard(S.board, bw);
  const c = $('board-canvas');
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  c.style.left = pos.x * fw + 'px';
  c.style.top = pos.y * fh + 'px';
  c.style.width = bw + 'px';
  c.style.height = bh + 'px';
  c.width = Math.round(bw * dpr);
  c.height = Math.round(bh * dpr);
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  renderBoard(ctx, S.board, 0, 0, bw, new Date(), S.settings.dateMode);
  const hd = $('board-handle');
  hd.style.left = pos.x * fw + bw + 'px';
  hd.style.top = pos.y * fh + bh + 'px';
}

// 黒板のドラッグ移動・タップで編集
function setupBoardDrag() {
  const c = $('board-canvas');
  let st = null;
  c.addEventListener('pointerdown', (e) => {
    c.setPointerCapture(e.pointerId);
    const pos = curPos();
    st = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y, t: Date.now(), moved: false };
  });
  c.addEventListener('pointermove', (e) => {
    if (!st) return;
    const dx = e.clientX - st.x, dy = e.clientY - st.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) st.moved = true;
    if (!st.moved) return;
    const pos = curPos();
    pos.x = st.px + dx / S.frame.w;
    pos.y = st.py + dy / S.frame.h;
    drawOverlay();
  });
  const end = () => {
    if (!st) return;
    if (!st.moved && Date.now() - st.t < 500) openEditor();
    else saveState();
    st = null;
  };
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', () => { st = null; saveState(); });

  const hd = $('board-handle');
  let rs = null;
  hd.addEventListener('pointerdown', (e) => {
    hd.setPointerCapture(e.pointerId);
    rs = { x: e.clientX, w: curPos().w };
  });
  hd.addEventListener('pointermove', (e) => {
    if (!rs) return;
    const pos = curPos();
    pos.w = rs.w + (e.clientX - rs.x) / S.frame.w;
    drawOverlay();
  });
  const rend = () => { if (rs) { rs = null; saveState(); } };
  hd.addEventListener('pointerup', rend);
  hd.addEventListener('pointercancel', rend);
}

// ---------- 撮影 ----------
let audioCtx;
function shutterSound() {
  if (!S.settings.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const n = audioCtx.sampleRate * 0.06;
    const buf = audioCtx.createBuffer(1, n, audioCtx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3);
    const src = audioCtx.createBufferSource();
    const g = audioCtx.createGain();
    g.gain.value = 0.5;
    src.buffer = buf;
    src.connect(g).connect(audioCtx.destination);
    src.start();
  } catch {}
}

function flash() {
  const f = $('flash');
  f.classList.add('on');
  requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove('on')));
}

function shoot() {
  const v = $('video');
  if (!S.key || !v.videoWidth || v.readyState < 2) { toast('カメラの準備ができていません'); return; }
  const when = new Date();
  const vw = v.videoWidth, vh = v.videoHeight;
  const maxEdge = Number(S.settings.size) || Math.max(vw, vh);
  const sc = Math.min(1, maxEdge / Math.max(vw, vh));
  const cw = Math.round(vw * sc), ch = Math.round(vh * sc);
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const ctx = c.getContext('2d');
  ctx.drawImage(v, 0, 0, cw, ch);
  const board = structuredClone(S.board);
  const o = photoOrient(cw, ch);
  const pos = clampPos({ ...(board.pos[o] || defaultBoard().pos[o]) }, ch / cw);
  renderBoard(ctx, board, pos.x * cw, pos.y * ch, pos.w * cw, when, S.settings.dateMode);
  flash();
  shutterSound();
  rememberRecents();
  S.pending++;
  updateQueue();
  const job = () => processCapture(c, board, when).catch((e) => {
    console.error(e);
    alertBox('保存できませんでした', (e && e.name === 'QuotaExceededError') ? 'iPhoneの空き容量が不足しています。写真を書き出して削除してください。' : String(e?.message || e));
  }).finally(() => { S.pending--; updateQueue(); });
  S.queue = S.queue.then(job, job);
  if (S.settings.autoInc) quickStep(1, true);
}

function updateQueue() {
  $('queue-indicator').hidden = S.pending <= 0;
  $('queue-n').textContent = S.pending;
}

function canvasToBlob(c, type, q) {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('画像の変換に失敗しました'))), type, q));
}

function fileNameFor(rows, when, board) {
  const pick = (id) => board.fields.find((f) => f.id === id && f.show !== false)?.value || '';
  let parts = [pick('koushu'), pick('sokuten')].filter(Boolean);
  if (!parts.length) parts = rows.filter((r) => r.value).slice(0, 2).map((r) => r.value);
  const d = when;
  const stamp = `${d.getFullYear()}${z2(d.getMonth() + 1)}${z2(d.getDate())}_${z2(d.getHours())}${z2(d.getMinutes())}${z2(d.getSeconds())}`;
  const tail = parts.join('_').replace(/[\\/:*?"<>|\r\n\t]+/g, '_').replace(/\s+/g, '').slice(0, 40);
  return `${stamp}${tail ? '_' + tail : ''}.jpg`;
}

async function makeThumb(source, sw, sh) {
  const s = 360 / Math.max(sw, sh);
  const t = document.createElement('canvas');
  t.width = Math.max(1, Math.round(sw * s)); t.height = Math.max(1, Math.round(sh * s));
  t.getContext('2d').drawImage(source, 0, 0, t.width, t.height);
  const b = await canvasToBlob(t, 'image/jpeg', 0.72);
  t.width = t.height = 0;
  return new Uint8Array(await b.arrayBuffer());
}

async function storePhoto(id, when, bytes, thumb, meta) {
  if (!S.key) throw new Error('ロック中のため保存できません');
  const [m, t, i] = await Promise.all([
    encryptJson(S.key, meta, `${id}:meta`),
    encryptBytes(S.key, thumb, `${id}:thumb`),
    encryptBytes(S.key, bytes, `${id}:image`),
  ]);
  await db.putPhoto({ id, createdAt: when, meta: m }, { id, data: t }, { id, data: i });
}

async function processCapture(c, board, when) {
  const blob = await canvasToBlob(c, 'image/jpeg', Number(S.settings.quality));
  const thumb = await makeThumb(c, c.width, c.height);
  const rows = boardText(board, when, S.settings.dateMode);
  const bytes = addJpegMeta(new Uint8Array(await blob.arrayBuffer()), { when, width: c.width, height: c.height, rows });
  const hash = await sha256Hex(bytes);
  const id = newId();
  const meta = { id, createdAt: when.getTime(), w: c.width, h: c.height, rows, hash, size: bytes.length, name: fileNameFor(rows, when, board) };
  c.width = c.height = 0;
  await storePhoto(id, when.getTime(), bytes, thumb, meta);
  S.photos.unshift({ id, createdAt: meta.createdAt, meta });
  $('photo-count').textContent = S.photos.length;
  setLastThumb(thumb);
}

function setLastThumb(bytes) {
  const img = $('last-thumb');
  const old = img.getAttribute('src');
  if (old) { URL.revokeObjectURL(old); S.urls.delete(old); }
  img.src = trackUrl(URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' })));
}

let burstTimer = null;
function stopBurst() {
  clearInterval(burstTimer); burstTimer = null;
  $('shutter').classList.remove('pressed', 'burst');
}
function setupShutter() {
  const sh = $('shutter');
  sh.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    sh.setPointerCapture(e.pointerId);
    sh.classList.add('pressed');
    shoot();
    if (S.settings.burstOn) {
      stopBurst();
      sh.classList.add('pressed', 'burst');
      burstTimer = setInterval(shoot, Number(S.settings.burstMs) || 1000);
    }
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) sh.addEventListener(ev, stopBurst);
  sh.addEventListener('contextmenu', (e) => e.preventDefault());
  // Bluetoothリモコン等（Enter / Space キー）でも撮影
  document.addEventListener('keydown', (e) => {
    if ($('screen-camera').hidden || !$('editor').hidden || !$('modal').hidden) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'AudioVolumeUp' || e.key === 'AudioVolumeDown') { e.preventDefault(); shoot(); }
  });
}

// ---------- クイック変更（＋−） ----------
function quickField() {
  const f = S.board.fields.find((x) => x.id === S.settings.quickField && x.type !== 'date');
  return f || S.board.fields.find((x) => x.type === 'text');
}

function updateQuick() {
  const f = quickField();
  $('quick-label').textContent = f ? f.label : '—';
  const qi = $('quick-value');
  if (document.activeElement !== qi) qi.value = f ? f.value : '';
  qi.disabled = !f;
}

function quickStep(delta, silent) {
  const f = quickField();
  if (!f) return;
  const nv = stepNumber(f.value, delta);
  if (nv == null) { if (!silent) toast(`「${f.label}」に数字がありません`); return; }
  f.value = nv;
  S.activePreset = null;
  updateQuick();
  drawOverlay();
  renderPresetBar();
  saveState();
}

function rememberRecents() {
  for (const f of S.board.fields) {
    if (f.type === 'date' || !f.value) continue;
    const list = (S.recents[f.id] || []).filter((v) => v !== f.value);
    list.unshift(f.value);
    S.recents[f.id] = list.slice(0, 12);
  }
  saveState();
}

// ---------- テンプレート ----------
function renderPresetBar() {
  const bar = $('preset-bar');
  bar.replaceChildren();
  for (const p of S.presets) {
    bar.append(h('button', {
      class: 'chip' + (S.activePreset === p.id ? ' active' : ''),
      text: p.name,
      onclick: () => applyPreset(p),
    }));
  }
  if (!S.presets.length) bar.append(h('button', { class: 'chip', text: '＋ テンプレート', onclick: () => openEditor() }));
}

function applyPreset(p) {
  S.board.fields = structuredClone(p.fields);
  if (p.style) S.board.style = { ...p.style };
  S.activePreset = p.id;
  renderPresetBar();
  updateQuick();
  drawOverlay();
  if (!$('editor').hidden) renderEditor();
  saveState();
  toast(`「${p.name}」に切り替えました`);
}

async function savePreset() {
  const r = await modal({
    title: 'テンプレートとして保存',
    inputs: [{ label: '名前（例: 舗装工 出来形）', value: S.board.fields.find((f) => f.id === 'koushu')?.value || '' }],
    buttons: [{ label: '保存', value: true, primary: true }, { label: 'キャンセル', value: false }],
  });
  if (!r.value) return;
  const name = (r.vals[0] || '').trim() || `テンプレート${S.presets.length + 1}`;
  const p = { id: 't' + Date.now().toString(36), name, fields: structuredClone(S.board.fields), style: { ...S.board.style } };
  S.presets.push(p);
  S.activePreset = p.id;
  renderPresetBar();
  renderEditor();
  saveState();
  toast('保存しました');
}

// ---------- 黒板編集シート ----------
function openEditor() {
  stopBurst();
  S.edStructure = false;
  renderEditor();
  $('editor').hidden = false;
}

function closeEditor() {
  $('editor').hidden = true;
  updateQuick();
  drawOverlay();
  saveState();
}

function edChanged(rebuild) {
  S.activePreset = null;
  drawOverlay();
  drawEdPreview();
  updateQuick();
  renderPresetBar();
  if (rebuild) renderEditor();
  saveState();
}

function drawEdPreview() {
  const c = $('ed-preview');
  const w = Math.min(420, $('editor').clientWidth - 28 || 340);
  const hh = measureBoard(S.board, w);
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  c.style.width = w + 'px'; c.style.height = hh + 'px';
  c.width = Math.round(w * dpr); c.height = Math.round(hh * dpr);
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  renderBoard(ctx, S.board, 0, 0, w, new Date(), S.settings.dateMode);
}

function renderEditor() {
  const wrap = $('ed-fields');
  wrap.replaceChildren();
  $('ed-mode').textContent = S.edStructure ? '内容の入力に戻る' : '項目を編集';
  $('ed-structure-tools').hidden = !S.edStructure;
  $('ed-color').value = S.board.style?.color || 'green';
  $('ed-opacity').value = String(S.board.style?.opacity ?? 1);
  const fields = S.board.fields;

  fields.forEach((f, idx) => {
    const box = h('div', { class: 'ed-field' });
    if (S.edStructure) {
      const lab = h('input', { type: 'text', value: f.label, placeholder: '項目名', oninput: (e) => { f.label = e.target.value; edChanged(); } });
      const typ = h('select', { onchange: (e) => { f.type = e.target.value; edChanged(true); } },
        h('option', { value: 'text', text: '1行' }), h('option', { value: 'multiline', text: '複数行' }), h('option', { value: 'date', text: '撮影日(自動)' }));
      typ.value = f.type;
      const vis = h('input', { type: 'checkbox', checked: f.show !== false, onchange: (e) => { f.show = e.target.checked; edChanged(); } });
      box.append(
        h('div', { class: 'struct' }, lab, typ),
        h('div', { class: 'struct' },
          h('label', {}, vis, '黒板に表示'),
          h('span', { class: 'lbl' }),
          h('button', { text: '↑', disabled: idx === 0, onclick: () => { [fields[idx - 1], fields[idx]] = [fields[idx], fields[idx - 1]]; edChanged(true); } }),
          h('button', { text: '↓', disabled: idx === fields.length - 1, onclick: () => { [fields[idx + 1], fields[idx]] = [fields[idx], fields[idx + 1]]; edChanged(true); } }),
          h('button', { text: '削除', onclick: async () => {
            if (await confirmBox('項目を削除', `「${f.label}」を黒板から削除しますか？`, '削除', true)) { fields.splice(idx, 1); edChanged(true); }
          } }),
        ),
      );
    } else {
      if (f.show === false) return;
      const top = h('div', { class: 'ed-top' }, h('span', { class: 'lbl', text: f.label }));
      box.append(top);
      if (f.type === 'date') {
        box.append(h('div', { class: 'muted small-text', text: `撮影した日付が自動で入ります（例: ${formatDate(new Date(), S.settings.dateMode)}）` }));
      } else {
        const input = f.type === 'multiline'
          ? h('textarea', { class: 'val', value: f.value, rows: 3 })
          : h('input', { class: 'val', type: 'text', value: f.value, enterkeyhint: 'next' });
        input.addEventListener('input', () => { f.value = input.value; edChanged(); });
        const stepable = f.type === 'text' && (/\d/.test(f.value || '') || f.id === quickField()?.id);
        if (f.type === 'text') {
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); const all = [...wrap.querySelectorAll('.val')]; const n = all[all.indexOf(input) + 1]; n ? n.focus() : input.blur(); }
          });
          box.append(stepable ? h('div', { class: 'ed-row' }, input,
            h('button', { class: 'step-btn', text: '−', onclick: () => step(-1) }),
            h('button', { class: 'step-btn', text: '＋', onclick: () => step(1) })) : input);
        } else box.append(input);
        function step(d) {
          const nv = stepNumber(f.value, d);
          if (nv == null) return toast('数字がありません');
          f.value = input.value = nv; edChanged();
        }
        const rec = (S.recents[f.id] || []).filter((v) => v !== f.value);
        if (rec.length) {
          box.append(h('div', { class: 'recent' }, rec.map((v) => h('button', {
            text: v.replace(/\n/g, ' '),
            onclick: () => { f.value = input.value = v; edChanged(); },
          }))));
        }
      }
    }
    wrap.append(box);
  });

  // テンプレート一覧
  const pl = $('ed-presets');
  pl.replaceChildren();
  for (const p of S.presets) {
    pl.append(h('div', { class: 'preset-row' },
      h('span', { text: p.name + (S.activePreset === p.id ? '（使用中）' : '') }),
      h('button', { class: 'btn small', text: '使う', onclick: () => applyPreset(p) }),
      h('button', { class: 'btn small', text: '上書き', onclick: async () => {
        if (!(await confirmBox('上書き保存', `「${p.name}」を今の黒板の内容で上書きしますか？`))) return;
        p.fields = structuredClone(S.board.fields); p.style = { ...S.board.style }; S.activePreset = p.id;
        saveState(); renderPresetBar(); renderEditor(); toast('上書きしました');
      } }),
      h('button', { class: 'btn small danger', text: '削除', onclick: async () => {
        if (!(await confirmBox('テンプレート削除', `「${p.name}」を削除しますか？`, '削除', true))) return;
        S.presets = S.presets.filter((x) => x !== p);
        if (S.activePreset === p.id) S.activePreset = null;
        saveState(); renderPresetBar(); renderEditor();
      } }),
    ));
  }
  requestAnimationFrame(drawEdPreview);
}

function setupEditor() {
  $('btn-edit').addEventListener('click', openEditor);
  $('ed-close').addEventListener('click', closeEditor);
  $('ed-mode').addEventListener('click', () => { S.edStructure = !S.edStructure; renderEditor(); });
  $('ed-add').addEventListener('click', () => {
    S.board.fields.push({ id: newFieldId(), label: '新しい項目', value: '', type: 'text', show: true });
    edChanged(true);
  });
  $('ed-color').addEventListener('change', (e) => { S.board.style.color = e.target.value; edChanged(); });
  $('ed-opacity').addEventListener('change', (e) => { S.board.style.opacity = Number(e.target.value); edChanged(); });
  $('ed-save-preset').addEventListener('click', savePreset);
  $('ed-clear').addEventListener('click', async () => {
    if (!(await confirmBox('内容をクリア', '黒板の入力内容をすべて空にしますか？（項目はそのまま）'))) return;
    for (const f of S.board.fields) if (f.type !== 'date') f.value = '';
    edChanged(true);
  });
}

// ---------- 写真データ ----------
async function loadPhotos() {
  if (S.photosLoaded) return;
  const recs = await db.getAll('photos');
  const out = [];
  for (const r of recs) {
    try { out.push({ id: r.id, createdAt: r.createdAt, meta: await decryptJson(S.key, r.meta, `${r.id}:meta`) }); }
    catch (e) { console.warn('壊れたレコード', r.id, e); }
  }
  // 撮影中に増えた分と合わせる
  const known = new Set(out.map((p) => p.id));
  for (const p of S.photos) if (!known.has(p.id)) out.push(p);
  out.sort((a, b) => b.createdAt - a.createdAt);
  S.photos = out;
  S.photosLoaded = true;
  $('photo-count').textContent = out.length;
  if (out[0] && !$('last-thumb').getAttribute('src')) {
    const t = await getThumb(out[0].id).catch(() => null);
    if (t) setLastThumb(t);
  }
}

async function getThumb(id) {
  const r = await db.get('thumbs', id);
  return decryptBytes(S.key, r.data, `${id}:thumb`);
}
async function getImage(id) {
  const r = await db.get('images', id);
  return decryptBytes(S.key, r.data, `${id}:image`);
}

// ---------- 一覧 ----------
function norm(s) { return (s || '').normalize('NFKC').toLowerCase(); }

function filteredPhotos() {
  const day = $('gal-day').value;
  const words = norm($('gal-search').value).split(/\s+/).filter(Boolean);
  return S.photos.filter((p) => {
    if (day && day !== 'all' && dayKey(p.createdAt) !== day) return false;
    if (!words.length) return true;
    const text = norm(p.meta.rows.map((r) => r.value).join(' ') + ' ' + p.meta.name);
    return words.every((w) => text.includes(w));
  });
}

let thumbObserver;
async function openGallery() {
  stopBurst();
  show('screen-gallery');
  if (!S.photosLoaded) { busy('写真を読み込み中…'); try { await loadPhotos(); } finally { busy(); } }
  const sel = $('gal-day');
  const prev = sel.value;
  const days = [...new Set(S.photos.map((p) => dayKey(p.createdAt)))];
  sel.replaceChildren(h('option', { value: 'all', text: `すべての日（${S.photos.length}）` }),
    ...days.map((d) => h('option', { value: d, text: `${d.replace(/-/g, '/')}（${S.photos.filter((p) => dayKey(p.createdAt) === d).length}）` })));
  sel.value = days.includes(prev) ? prev : (days.includes(dayKey(Date.now())) ? dayKey(Date.now()) : 'all');
  renderGrid();
}

function renderGrid() {
  const grid = $('gal-grid');
  for (const img of grid.querySelectorAll('img[src]')) { URL.revokeObjectURL(img.src); S.urls.delete(img.src); }
  grid.replaceChildren();
  thumbObserver?.disconnect();
  thumbObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const tile = en.target;
      thumbObserver.unobserve(tile);
      getThumb(tile.dataset.id).then((b) => {
        if (!S.key) return;
        tile.querySelector('img').src = trackUrl(URL.createObjectURL(new Blob([b], { type: 'image/jpeg' })));
      }).catch(() => {});
    }
  }, { root: $('screen-gallery'), rootMargin: '400px' });

  const list = filteredPhotos();
  S.galList = list;
  $('gal-count').textContent = `${list.length}枚`;
  $('gal-empty').hidden = list.length > 0;
  let lastDay = null;
  list.forEach((p, i) => {
    const d = dayKey(p.createdAt);
    if (d !== lastDay) { grid.append(h('div', { class: 'day-head', text: d.replace(/-/g, '/') })); lastDay = d; }
    const cap = p.meta.rows.filter((r) => r.value).slice(1, 3).map((r) => r.value).join(' ');
    const tile = h('div', { class: 'tile' + (S.selected.has(p.id) ? ' sel' : ''), 'data-id': p.id },
      h('img', { alt: '' }), h('div', { class: 'cap', text: cap || new Date(p.createdAt).toLocaleTimeString('ja-JP') }));
    tile.addEventListener('click', () => {
      if (S.galSelect) {
        if (S.selected.has(p.id)) S.selected.delete(p.id); else S.selected.add(p.id);
        tile.classList.toggle('sel', S.selected.has(p.id));
        updateSelCount();
      } else openViewer(i);
    });
    grid.append(tile);
    thumbObserver.observe(tile);
  });
  updateSelCount();
}

function updateSelCount() {
  $('gal-selcount').textContent = `${S.selected.size}枚選択`;
  $('gal-actions').hidden = !S.galSelect;
  $('gal-select').textContent = S.galSelect ? '選択終了' : '選択';
}

function setupGallery() {
  $('btn-gallery').addEventListener('click', openGallery);
  $('gal-back').addEventListener('click', () => { S.galSelect = false; S.selected.clear(); show('screen-camera'); });
  $('gal-select').addEventListener('click', () => {
    S.galSelect = !S.galSelect;
    if (!S.galSelect) S.selected.clear();
    for (const t of $('gal-grid').querySelectorAll('.tile')) t.classList.toggle('sel', S.selected.has(t.dataset.id));
    updateSelCount();
  });
  $('gal-day').addEventListener('change', renderGrid);
  let st;
  $('gal-search').addEventListener('input', () => { clearTimeout(st); st = setTimeout(renderGrid, 250); });
  $('gal-all').addEventListener('click', () => {
    const all = S.galList.every((p) => S.selected.has(p.id));
    for (const p of S.galList) all ? S.selected.delete(p.id) : S.selected.add(p.id);
    for (const t of $('gal-grid').querySelectorAll('.tile')) t.classList.toggle('sel', S.selected.has(t.dataset.id));
    updateSelCount();
  });
  $('gal-export').addEventListener('click', () => {
    if (!S.selected.size) return toast('写真を選んでください');
    exportFlow(orderedIds([...S.selected]));
  });
  $('gal-delete').addEventListener('click', async () => {
    if (!S.selected.size) return toast('写真を選んでください');
    if (await deletePhotos([...S.selected])) { S.selected.clear(); openGallery(); }
  });
}

function orderedIds(ids) {
  const set = new Set(ids);
  return S.photos.filter((p) => set.has(p.id)).sort((a, b) => a.createdAt - b.createdAt).map((p) => p.id);
}

async function deletePhotos(ids) {
  const ok = await confirmBox('写真を削除', `${ids.length}枚の写真をこのアプリから完全に削除します。元に戻せません。\n書き出し済みか確認してください。`, '削除する', true);
  if (!ok) return false;
  const newest = S.photos[0]?.id;
  await db.deletePhotos(ids);
  const set = new Set(ids);
  S.photos = S.photos.filter((p) => !set.has(p.id));
  $('photo-count').textContent = S.photos.length;
  if (!S.photos.length) $('last-thumb').removeAttribute('src');
  else if (set.has(newest)) getThumb(S.photos[0].id).then(setLastThumb).catch(() => {});
  toast(`${ids.length}枚削除しました`);
  return true;
}

// ---------- 1枚表示 ----------
async function openViewer(i) {
  S.viewIndex = i;
  show('screen-viewer');
  const p = S.galList[i];
  if (!p) return;
  $('vw-pos').textContent = `${i + 1} / ${S.galList.length}`;
  $('vw-prev').disabled = i === 0;
  $('vw-next').disabled = i >= S.galList.length - 1;
  const img = $('vw-img');
  const old = img.getAttribute('src');
  if (old) { URL.revokeObjectURL(old); S.urls.delete(old); }
  img.removeAttribute('src');
  const m = p.meta;
  const info = $('vw-info');
  info.replaceChildren(h('table', {},
    h('tr', {}, h('td', { text: '撮影日時' }), h('td', { text: dateTimeStr(m.createdAt) })),
    ...m.rows.map((r) => h('tr', {}, h('td', { text: r.label }), h('td', { text: r.value }))),
    h('tr', {}, h('td', { text: 'ファイル名' }), h('td', { text: m.name })),
    h('tr', {}, h('td', { text: 'サイズ' }), h('td', { text: `${m.w}×${m.h}px ／ ${fmtBytes(m.size)}` })),
    h('tr', {}, h('td', { text: '指紋(SHA-256)' }), h('td', { class: 'hash', text: m.hash })),
  ));
  try {
    const b = await getImage(p.id);
    if (S.viewIndex === i && S.key) img.src = trackUrl(URL.createObjectURL(new Blob([b], { type: 'image/jpeg' })));
  } catch (e) { toast('画像を開けません: ' + e.message); }
}

function setupViewer() {
  $('vw-back').addEventListener('click', () => {
    const img = $('vw-img'); const u = img.getAttribute('src');
    if (u) { URL.revokeObjectURL(u); S.urls.delete(u); img.removeAttribute('src'); }
    show('screen-gallery');
  });
  $('vw-prev').addEventListener('click', () => openViewer(S.viewIndex - 1));
  $('vw-next').addEventListener('click', () => openViewer(S.viewIndex + 1));
  $('vw-share').addEventListener('click', () => { const p = S.galList[S.viewIndex]; if (p) exportFlow([p.id]); });
  $('vw-delete').addEventListener('click', async () => {
    const p = S.galList[S.viewIndex];
    if (!p) return;
    if (await deletePhotos([p.id])) {
      S.galList.splice(S.viewIndex, 1);
      if (!S.galList.length) return openGallery();
      openViewer(Math.min(S.viewIndex, S.galList.length - 1));
    }
  });
  // 左右スワイプで前後
  let sx = null;
  $('vw-img').addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; }, { passive: true });
  $('vw-img').addEventListener('touchend', (e) => {
    if (sx == null) return;
    const dx = e.changedTouches[0].clientX - sx; sx = null;
    if (dx > 60 && S.viewIndex > 0) openViewer(S.viewIndex - 1);
    if (dx < -60 && S.viewIndex < S.galList.length - 1) openViewer(S.viewIndex + 1);
  });
}

// ---------- 書き出し ----------
const CHUNK = 100;

function chunks(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }
function stampNow() { const d = new Date(); return `${d.getFullYear()}${z2(d.getMonth() + 1)}${z2(d.getDate())}_${z2(d.getHours())}${z2(d.getMinutes())}`; }

function canShareFiles(files) {
  try { return !!(navigator.canShare && navigator.canShare({ files })); } catch { return false; }
}

function downloadFile(file) {
  const u = URL.createObjectURL(file);
  const a = h('a', { href: u, download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 60000);
}

// 準備できたファイルを渡す（共有シート or ダウンロード）
function deliver(files, title, note) {
  const total = files.reduce((a, f) => a + f.size, 0);
  const body = h('div', {},
    h('p', { text: `${files.length === 1 ? files[0].name : files.length + '個のファイル'}（${fmtBytes(total)}）` }),
    note ? h('p', { class: 'warn', text: note }) : null);
  const buttons = [];
  if (canShareFiles(files)) {
    buttons.push({ label: '共有・保存…（AirDrop／ファイル／写真など）', primary: true,
      onClick: () => navigator.share({ files }).catch((e) => { if (e.name !== 'AbortError') toast('共有できませんでした: ' + e.message); }) });
  }
  buttons.push({ label: files.length === 1 ? 'ダウンロード（ファイルAppへ）' : 'ダウンロード（1つずつ）', primary: !buttons.length,
    onClick: () => files.forEach((f, i) => setTimeout(() => downloadFile(f), i * 400)) });
  buttons.push({ label: '閉じる', value: false });
  return modal({ title, body, buttons });
}

async function exportFlow(ids) {
  const n = ids.length;
  const choice = await modal({
    title: `${n}枚を書き出し`,
    body: '書き出したファイルは、このアプリの暗号化の外に出ます。社外への誤送信に注意してください。',
    buttons: [
      { label: 'ZIPにまとめる（写真＋写真台帳CSV）', value: 'zip', primary: true },
      ...(n <= 30 ? [{ label: '画像のまま共有（写真Appへ保存など）', value: 'img' }] : []),
      { label: '暗号化バックアップ（.kbk・このアプリ専用）', value: 'kbk' },
      { label: 'キャンセル', value: null },
    ],
  });
  if (choice === 'zip') return exportZip(ids);
  if (choice === 'img') return exportImages(ids);
  if (choice === 'kbk') return exportBackup(ids);
}

function csvCell(v) { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

function buildCsv(metas, names) {
  const labels = [];
  for (const m of metas) for (const r of m.rows) if (!labels.includes(r.label)) labels.push(r.label);
  const lines = [['No', 'ファイル名', '撮影日時', ...labels, '幅', '高さ', 'SHA-256'].map(csvCell).join(',')];
  metas.forEach((m, i) => {
    const map = Object.fromEntries(m.rows.map((r) => [r.label, r.value]));
    lines.push([i + 1, names[i], dateTimeStr(m.createdAt), ...labels.map((l) => map[l] ?? ''), m.w, m.h, m.hash].map(csvCell).join(','));
  });
  return '﻿' + lines.join('\r\n') + '\r\n';
}

async function exportZip(ids) {
  const parts = chunks(ids, CHUNK);
  const byId = new Map(S.photos.map((p) => [p.id, p]));
  for (let k = 0; k < parts.length; k++) {
    busy(`ZIPを作成中… ${k + 1}/${parts.length}`);
    let file;
    try {
      const zw = new ZipWriter();
      const metas = [], names = [];
      for (const id of parts[k]) {
        const p = byId.get(id);
        const bytes = await getImage(id);
        names.push(zw.add(p.meta.name, bytes, new Date(p.createdAt)));
        metas.push(p.meta);
      }
      zw.add('写真台帳.csv', buildCsv(metas, names));
      const suffix = parts.length > 1 ? `_${k + 1}of${parts.length}` : '';
      file = new File([zw.toBlob()], `工事写真_${stampNow()}${suffix}.zip`, { type: 'application/zip' });
    } catch (e) { busy(); return alertBox('書き出しに失敗しました', e.message); }
    busy();
    await deliver([file], parts.length > 1 ? `ZIP ${k + 1}/${parts.length} の準備ができました` : 'ZIPの準備ができました',
      parts.length > 1 ? `100枚ずつ分けています。保存後「閉じる」で次へ進みます。` : null);
  }
}

async function exportImages(ids) {
  busy('画像を準備中…');
  const files = [];
  try {
    const used = new Set();
    for (const id of ids) {
      const p = S.photos.find((x) => x.id === id);
      let name = p.meta.name;
      for (let i = 2; used.has(name); i++) name = p.meta.name.replace(/\.jpg$/, `_${i}.jpg`);
      used.add(name);
      files.push(new File([await getImage(id)], name, { type: 'image/jpeg' }));
    }
  } catch (e) { busy(); return alertBox('準備に失敗しました', e.message); }
  busy();
  await deliver(files, '画像の準備ができました', '「写真」Appに保存すると、iCloud写真などで自動的に同期される場合があります。');
}

async function askNewPassword(title, note) {
  const r = await modal({
    title, body: note,
    inputs: [{ label: 'パスワード（8文字以上）', type: 'password' }, { label: 'もう一度', type: 'password' }],
    buttons: [{ label: 'OK', value: true, primary: true }, { label: 'キャンセル', value: false }],
  });
  if (!r.value) return null;
  if (r.vals[0].length < 8) { await alertBox('パスワード', '8文字以上にしてください'); return null; }
  if (r.vals[0] !== r.vals[1]) { await alertBox('パスワード', '2回の入力が一致しません'); return null; }
  return r.vals[0];
}

async function exportBackup(ids) {
  const pw = await askNewPassword('バックアップ用パスワード',
    '復元するときに必要です。忘れると復元できません。別の機器へ移す場合も、このパスワードを知っている人しか開けません。');
  if (!pw) return;
  const parts = chunks(ids, CHUNK);
  const byId = new Map(S.photos.map((p) => [p.id, p]));
  for (let k = 0; k < parts.length; k++) {
    busy(`暗号化バックアップを作成中… ${k + 1}/${parts.length}`);
    let file;
    try {
      const zw = new ZipWriter();
      zw.add('app.json', JSON.stringify({ v: 1, app: 'KokubanCam', presets: S.presets, board: S.board }));
      for (const id of parts[k]) {
        const p = byId.get(id);
        zw.add(`photos/${id}.jpg`, await getImage(id));
        zw.add(`photos/${id}.json`, JSON.stringify(p.meta));
      }
      const plain = new Uint8Array(await zw.toBlob().arrayBuffer());
      const sealed = await sealWithPassword(plain, pw);
      plain.fill(0);
      const suffix = parts.length > 1 ? `_${k + 1}of${parts.length}` : '';
      file = new File([sealed], `黒板カメラ_バックアップ_${stampNow()}${suffix}.kbk`, { type: 'application/octet-stream' });
    } catch (e) { busy(); return alertBox('バックアップに失敗しました', e.message); }
    busy();
    await deliver([file], parts.length > 1 ? `バックアップ ${k + 1}/${parts.length}` : 'バックアップの準備ができました',
      'この.kbkファイルは暗号化されています。「ファイル」App や社内PCへ保存してください。');
  }
}

async function restoreBackup(file) {
  const r = await modal({
    title: 'バックアップから復元', body: file.name,
    inputs: [{ label: 'バックアップ用パスワード', type: 'password' }],
    buttons: [{ label: '復元', value: true, primary: true }, { label: 'キャンセル', value: false }],
  });
  if (!r.value) return;
  busy('復号中…');
  let added = 0, skipped = 0, broken = 0;
  try {
    let plain;
    try { plain = await openWithPassword(await file.arrayBuffer(), r.vals[0]); }
    catch { busy(); return alertBox('復元できません', 'パスワードが違うか、ファイルが壊れています。'); }
    const entries = readZip(plain);
    const map = new Map(entries.map((e) => [e.name, e.data]));
    const app = map.get('app.json');
    if (app) {
      const a = JSON.parse(new TextDecoder().decode(app));
      for (const p of a.presets || []) if (!S.presets.some((x) => x.id === p.id)) S.presets.push(p);
      saveState(); renderPresetBar();
    }
    const metas = entries.filter((e) => /^photos\/.+\.json$/.test(e.name));
    let i = 0;
    for (const e of metas) {
      busy(`復元中… ${++i}/${metas.length}`);
      const meta = JSON.parse(new TextDecoder().decode(e.data));
      const jpg = map.get(`photos/${meta.id}.jpg`);
      if (!jpg) { broken++; continue; }
      if (await db.hasPhoto(meta.id)) { skipped++; continue; }
      if ((await sha256Hex(jpg)) !== meta.hash) { broken++; continue; } // 改ざん・破損は取り込まない
      const bmp = await createImageBitmap(new Blob([jpg], { type: 'image/jpeg' }));
      const thumb = await makeThumb(bmp, bmp.width, bmp.height);
      bmp.close?.();
      await storePhoto(meta.id, meta.createdAt, new Uint8Array(jpg), thumb, meta);
      S.photos.push({ id: meta.id, createdAt: meta.createdAt, meta });
      added++;
    }
    S.photos.sort((a, b) => b.createdAt - a.createdAt);
    $('photo-count').textContent = S.photos.length;
  } catch (e) { busy(); return alertBox('復元に失敗しました', e.message); }
  busy();
  await alertBox('復元しました', `追加 ${added}枚 ／ 既にあるため省略 ${skipped}枚` + (broken ? ` ／ 破損・不一致のため除外 ${broken}枚` : ''));
}

// ---------- 改ざんチェック ----------
async function verifyFiles(files) {
  const out = $('vf-result');
  out.replaceChildren();
  if (!S.photosLoaded) await loadPhotos();
  const byHash = new Map(S.photos.map((p) => [p.meta.hash, p]));
  busy('照合中…');
  try {
    for (const f of files) {
      const hash = await sha256Hex(new Uint8Array(await f.arrayBuffer()));
      const p = byHash.get(hash);
      out.append(p
        ? h('div', { class: 'vf-item ok' }, h('strong', { text: '✓ 一致（撮影時から変更なし）' }), h('div', { text: f.name }),
            h('div', { class: 'muted', text: `${dateTimeStr(p.createdAt)} ／ ${p.meta.rows.filter((r) => r.value).map((r) => r.value).slice(0, 3).join(' ')}` }))
        : h('div', { class: 'vf-item ng' }, h('strong', { text: '✗ 不一致・未登録' }), h('div', { text: f.name }),
            h('div', { class: 'muted', text: '撮影後に変更されたか、このiPhoneで撮影した写真ではありません。' })));
    }
  } finally { busy(); }
}

// ---------- 設定 ----------
function applySettingsToUi() {
  const s = S.settings;
  $('btn-burst').setAttribute('aria-pressed', String(!!s.burstOn));
  $('btn-burst').textContent = s.burstOn ? '連写 ON' : '連写 OFF';
  $('btn-auto').setAttribute('aria-pressed', String(!!s.autoInc));
  $('btn-auto').textContent = s.autoInc ? '自動+1 ON' : '自動+1 OFF';
}

async function openSettings() {
  stopBurst();
  const s = S.settings;
  $('st-size').value = String(s.size);
  $('st-quality').value = String(s.quality);
  $('st-burst').value = String(s.burstMs);
  $('st-date').value = s.dateMode;
  $('st-sound').checked = !!s.sound;
  $('st-lock').value = String(s.lockAfter);
  $('st-wipe').value = String((await getSec()).wipeAt || 0);
  const q = $('st-quick');
  q.replaceChildren(...S.board.fields.filter((f) => f.type !== 'date').map((f) => h('option', { value: f.id, text: f.label })));
  q.value = quickField()?.id || '';
  $('st-version').textContent = VERSION;
  show('screen-settings');
  const st = $('st-storage');
  st.textContent = `写真 ${S.photos.length}枚`;
  try {
    const est = await navigator.storage?.estimate?.();
    const persisted = await navigator.storage?.persisted?.();
    if (est) st.textContent += ` ／ 使用量 ${fmtBytes(est.usage || 0)}（上限目安 ${fmtBytes(est.quota || 0)}）`;
    st.textContent += persisted ? ' ／ 自動削除されない保存領域: 有効' : ' ／ 保存領域: 通常（ホーム画面から起動すると有効になります）';
  } catch {}
}

function setupSettings() {
  $('btn-settings').addEventListener('click', openSettings);
  $('st-back').addEventListener('click', () => { applySettingsToUi(); updateQuick(); drawOverlay(); show('screen-camera'); });
  const bind = (id, key, conv = (v) => v) => $(id).addEventListener('change', (e) => {
    S.settings[key] = conv(e.target.type === 'checkbox' ? e.target.checked : e.target.value);
    saveState();
  });
  bind('st-size', 'size', Number);
  bind('st-quality', 'quality', Number);
  bind('st-burst', 'burstMs', Number);
  bind('st-date', 'dateMode');
  bind('st-sound', 'sound');
  bind('st-lock', 'lockAfter', Number);
  bind('st-quick', 'quickField');
  $('st-wipe').addEventListener('change', async (e) => {
    const sec = await getSec(); sec.wipeAt = Number(e.target.value); await db.put('meta', sec, 'sec');
  });
  $('st-change-pass').addEventListener('click', changePasscode);
  $('st-verify').addEventListener('click', () => { $('vf-result').replaceChildren(); show('screen-verify'); });
  $('vf-back').addEventListener('click', () => show('screen-settings'));
  $('vf-files').addEventListener('change', (e) => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) verifyFiles(fs); });
  $('st-backup-all').addEventListener('click', async () => {
    if (!S.photosLoaded) await loadPhotos();
    if (!S.photos.length) return toast('写真がありません');
    exportBackup(orderedIds(S.photos.map((p) => p.id)));
  });
  $('st-restore').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) restoreBackup(f); });
  $('st-wipe-now').addEventListener('click', async () => {
    const r = await modal({
      title: 'すべてのデータを消去', body: '写真・黒板・テンプレート・パスコードをすべて消去します。元に戻せません。\n実行するには「消去」と入力してください。',
      inputs: [{ label: '' }], buttons: [{ label: '消去する', value: true, danger: true }, { label: 'キャンセル', value: false }],
    });
    if (!r.value || r.vals[0].trim() !== '消去') return;
    await lock();
    await db.wipeAll();
    location.reload();
  });
}

async function changePasscode() {
  const r = await modal({
    title: 'パスコードを変更',
    inputs: [{ label: '今のパスコード', type: 'password' }, { label: '新しいパスコード（6文字以上）', type: 'password' }, { label: '新しいパスコード（もう一度）', type: 'password' }],
    buttons: [{ label: '変更', value: true, primary: true }, { label: 'キャンセル', value: false }],
  });
  if (!r.value) return;
  const [cur, n1, n2] = r.vals;
  if (n1.length < 6) return alertBox('パスコード', '6文字以上にしてください');
  if (n1 !== n2) return alertBox('パスコード', '2回の入力が一致しません');
  busy('変更中…');
  try {
    const vault = await db.get('meta', 'vault');
    const { dekRaw } = await openVault(vault, cur);
    const nv = await rewrapVault(dekRaw, n1);
    dekRaw.fill(0);
    await db.put('meta', nv, 'vault');
    busy();
    toast('パスコードを変更しました');
  } catch {
    busy();
    alertBox('変更できません', '今のパスコードが違います');
  }
}

// ---------- 自動ロック ----------
function setupAutoLock() {
  const touch = () => { S.lastActive = Date.now(); };
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) document.addEventListener(ev, touch, { passive: true, capture: true });
  setInterval(() => {
    if (!S.key || burstTimer) return;
    const lim = S.settings.lockAfter;
    if (lim > 0 && Date.now() - S.lastActive > lim * 1000) lock();
  }, 5000);
  const cover = h('div', { class: 'modal', hidden: true }, h('div', { class: 'lock-icon', text: '🔒' }));
  cover.style.background = '#000';
  cover.style.zIndex = '100';
  document.body.append(cover);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cover.hidden = false; // App切替画面のサムネイルに写真を残さない
      S.hiddenAt = Date.now();
      stopBurst();
      if (S.key && S.settings.lockAfter === 0) lock();
      else stopCamera();
    } else {
      cover.hidden = true;
      if (!S.key) return;
      const lim = S.settings.lockAfter;
      if (Date.now() - S.hiddenAt > lim * 1000) lock();
      else { S.lastActive = Date.now(); if (!$('screen-camera').hidden) startCamera(); }
    }
  });
  $('btn-lock').addEventListener('click', lock);
}

// ---------- カメラ画面の操作 ----------
function setupCameraUi() {
  setupBoardDrag();
  setupShutter();
  $('quick-minus').addEventListener('click', () => quickStep(-1));
  $('quick-plus').addEventListener('click', () => quickStep(1));
  $('quick-value').addEventListener('input', (e) => {
    const f = quickField(); if (!f) return;
    f.value = e.target.value; S.activePreset = null; drawOverlay(); renderPresetBar(); saveState();
  });
  $('quick-value').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  $('btn-burst').addEventListener('click', () => {
    S.settings.burstOn = !S.settings.burstOn; applySettingsToUi(); saveState();
    toast(S.settings.burstOn ? `連写ON：シャッター長押しで${S.settings.burstMs / 1000}秒ごとに撮影` : '連写OFF');
  });
  $('btn-auto').addEventListener('click', () => {
    S.settings.autoInc = !S.settings.autoInc; applySettingsToUi(); saveState();
    toast(S.settings.autoInc ? `自動+1 ON：撮影ごとに「${quickField()?.label || ''}」の番号を+1` : '自動+1 OFF');
  });
  let torchOn = false;
  $('btn-torch').addEventListener('click', async () => {
    torchOn = !torchOn;
    try { await S.track.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch { torchOn = false; }
    $('btn-torch').setAttribute('aria-pressed', String(torchOn));
  });
  $('zoom').addEventListener('input', (e) => {
    S.track?.applyConstraints({ advanced: [{ zoom: Number(e.target.value) }] }).catch(() => {});
  });
  const v = $('video');
  v.addEventListener('loadedmetadata', layoutFrame);
  v.addEventListener('resize', layoutFrame);
  window.addEventListener('resize', () => requestAnimationFrame(layoutFrame));
  window.addEventListener('orientationchange', () => setTimeout(layoutFrame, 300));
}

// ---------- 起動 ----------
async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (!window.crypto?.subtle || !window.indexedDB) {
    document.body.textContent = 'このブラウザには対応していません。iPhoneのSafari（https のページ）で開いてください。';
    return;
  }
  $('setup-go').addEventListener('click', doSetup);
  $('setup-pass2').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSetup(); });
  $('lock-go').addEventListener('click', doUnlock);
  $('lock-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doUnlock(); });
  $('lock-forgot').addEventListener('click', async () => {
    const r = await modal({
      title: 'パスコードを忘れた場合',
      body: 'パスコードがないと写真を取り出す方法はありません（誰にも解除できない暗号化のため）。\n最初からやり直すには全データを消去します。写真・黒板・テンプレートはすべて失われます。\n実行するには「消去」と入力してください。',
      inputs: [{ label: '' }], buttons: [{ label: '全データを消去してやり直す', value: true, danger: true }, { label: 'キャンセル', value: false }],
    });
    if (!r.value || r.vals[0].trim() !== '消去') return;
    await db.wipeAll();
    location.reload();
  });
  setupCameraUi();
  setupEditor();
  setupGallery();
  setupViewer();
  setupSettings();
  setupAutoLock();
  const vault = await db.get('meta', 'vault');
  show(vault ? 'screen-lock' : 'screen-setup');
}

init();

// テスト用フック：手元のPCでの動作確認時だけ有効（本番の https サイトでは無効）
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') window.__kb = { S, shoot, lock, verifyFiles };
