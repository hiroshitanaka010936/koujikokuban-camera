// デジタル工事黒板：既定値・描画・文字操作
// 寸法はすべて見本画像（写真 1800×1350、黒板 600×450）から実測した値を
// 「黒板の幅 = 600」を基準とした割合で持っている。

export const FONT = '"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP","Noto Sans CJK JP",system-ui,sans-serif';
export const BOARD_VERSION = 2;
export const BOARD_ASPECT = 450 / 600; // 黒板は 4:3
export const MAX_ROWS = 6;

const U = 1 / 600; // 見本の 1px（黒板幅に対する割合）
const G = {
  inset: 8.5 * U,    // 黒板の端から白枠までの余白
  line: 3 * U,       // 罫線の太さ（見本は2px＋にじみ）
  row: 61 * U,       // 1行の高さ
  labelW: 134 * U,   // 項目名の列の右端
  fs: 32 * U,        // 項目名・内容の文字サイズ
  valX: 151 * U,     // 内容の書き出し位置
  footFs: 23 * U,    // 下段（会社名・日付）の文字サイズ
  footX: 25 * U,     // 会社名の書き出し位置
  footR: 576 * U,    // 日付の右端
  footY: 415.5 * U,  // 下段の文字の中心高さ
  freeFs: 26 * U,    // 自由記入欄の文字サイズ
};
const COLOR = { bg: '#0e5a34', line: '#f2fffd', text: '#ffffff' };
const WEIGHT = '600';

let seq = 0;
export function newFieldId() {
  return 'f' + Date.now().toString(36) + (seq++).toString(36);
}

// 項目の種類
//  text     : 罫線つきの行（項目名｜内容）
//  multiline: 下の広い欄に書く自由記入
//  company  : 左下の会社名
//  date     : 右下の撮影日（自動）
export const FIELD_TYPES = [
  ['text', '行（項目名＋内容）'],
  ['multiline', '下の欄に自由記入'],
  ['company', '左下（会社名など）'],
  ['date', '右下（撮影日・自動）'],
];

export function defaultBoard() {
  return {
    v: BOARD_VERSION,
    fields: [
      { id: 'kouji', label: '工事名', value: '', type: 'text', show: true },
      { id: 'basho', label: '工事場所', value: '', type: 'text', show: true },
      { id: 'youso', label: '要素', value: '', type: 'text', show: true },
      { id: 'bikou', label: '備考', value: '', type: 'multiline', show: true },
      { id: 'company', label: '会社名', value: '', type: 'company', show: true },
      { id: 'date', label: '撮影日', value: '', type: 'date', show: true },
    ],
    // anchor: bl=左下(見本どおり) br=右下 tl=左上 tr=右上 free=自由（x,y は写真に対する割合）
    pos: { anchor: 'bl', x: 0, y: 0 },
  };
}

// 旧形式の黒板を新形式へ（入力済みの文字はできるだけ引き継ぐ）
export function migrateBoard(b) {
  if (b && b.v === BOARD_VERSION) return b;
  const nb = defaultBoard();
  if (b && Array.isArray(b.fields)) {
    const val = (id) => b.fields.find((f) => f.id === id)?.value || '';
    nb.fields.find((f) => f.id === 'kouji').value = val('kouji');
    nb.fields.find((f) => f.id === 'company').value = val('sekou');
    nb.fields.find((f) => f.id === 'bikou').value = val('bikou');
  }
  return nb;
}

// 写真の大きさから黒板の幅を求める（黒板の高さ = 写真の短辺の 1/3）
export function boardWidthFor(photoW, photoH) {
  return Math.min(photoW, photoH) / 3 / BOARD_ASPECT;
}

// 写真の中での黒板の左上座標
export function boardRect(board, photoW, photoH) {
  const w = boardWidthFor(photoW, photoH);
  const h = w * BOARD_ASPECT;
  const p = board.pos || { anchor: 'bl' };
  let x, y;
  switch (p.anchor) {
    case 'br': x = photoW - w; y = photoH - h; break;
    case 'tl': x = 0; y = 0; break;
    case 'tr': x = photoW - w; y = 0; break;
    case 'free':
      x = Math.min(Math.max(0, (p.x || 0) * photoW), photoW - w);
      y = Math.min(Math.max(0, (p.y || 0) * photoH), photoH - h);
      break;
    default: x = 0; y = photoH - h; // 左下
  }
  return { x, y, w, h };
}

export function measureBoard(board, w) {
  return w * BOARD_ASPECT;
}

export function formatDate(d, mode) {
  const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
  if (mode === 'reiwa') {
    const r = y - 2018;
    return `令和${r === 1 ? '元' : r}年${m}月${day}日`;
  }
  return `${y}/${String(m).padStart(2, '0')}/${String(day).padStart(2, '0')}`;
}

const shown = (board) => board.fields.filter((f) => f.show !== false);
export function rowFields(board) { return shown(board).filter((f) => f.type === 'text').slice(0, MAX_ROWS); }

function fitText(ctx, text, maxW, size) {
  let s = size;
  ctx.font = `${WEIGHT} ${s}px ${FONT}`;
  while (ctx.measureText(text).width > maxW && s > size * 0.45) {
    s *= 0.95;
    ctx.font = `${WEIGHT} ${s}px ${FONT}`;
  }
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

// ctx 上の (x,y) に幅 w で黒板を描く。when = 撮影日時、dateMode = 'ad' | 'reiwa'
export function renderBoard(ctx, board, x, y, w, when, dateMode) {
  const h = w * BOARD_ASPECT;
  const k = (v) => v * w;
  const rows = rowFields(board);
  const free = shown(board).find((f) => f.type === 'multiline');
  const company = shown(board).find((f) => f.type === 'company');
  const dateF = shown(board).find((f) => f.type === 'date');

  ctx.save();
  ctx.textBaseline = 'middle';
  // 地
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(x, y, w, h);
  // 白枠
  const lw = Math.max(1, k(G.line));
  const ins = k(G.inset);
  ctx.strokeStyle = COLOR.line;
  ctx.lineWidth = lw;
  ctx.strokeRect(x + ins + lw / 2, y + ins + lw / 2, w - 2 * ins - lw, h - 2 * ins - lw);

  // 行の罫線
  const top = y + ins + lw / 2;
  const rowH = k(G.row);
  ctx.beginPath();
  rows.forEach((_, i) => {
    const ly = top + rowH * (i + 1);
    ctx.moveTo(x + ins, ly);
    ctx.lineTo(x + w - ins, ly);
  });
  if (rows.length) {
    const lx = x + k(G.labelW) + lw / 2;
    ctx.moveTo(lx, top);
    ctx.lineTo(lx, top + rowH * rows.length);
  }
  ctx.stroke();

  // 行の文字
  ctx.fillStyle = COLOR.text;
  const labelCx = x + (ins + k(G.labelW)) / 2 + lw / 2;
  const labelMax = k(G.labelW) - ins - k(24 * U);
  const valX = x + k(G.valX);
  const valMax = x + w - ins - k(12 * U) - valX;
  rows.forEach((f, i) => {
    const cy = top + rowH * (i + 0.5);
    ctx.textAlign = 'center';
    ctx.fillText(fitText(ctx, f.label || '', labelMax, k(G.fs)), labelCx, cy);
    ctx.textAlign = 'left';
    ctx.fillText(fitText(ctx, (f.value || '').replace(/\n/g, ' '), valMax, k(G.fs)), valX, cy);
  });

  // 下段：日付（右）と会社名（左）
  const fy = y + k(G.footY);
  let dateLeft = x + w - ins;
  if (dateF) {
    const ds = formatDate(when || new Date(), dateMode);
    ctx.textAlign = 'right';
    const t = fitText(ctx, ds, k(260 * U), k(G.footFs));
    ctx.fillText(t, x + k(G.footR), fy);
    dateLeft = x + k(G.footR) - ctx.measureText(t).width - k(16 * U);
  }
  if (company && company.value) {
    ctx.textAlign = 'left';
    ctx.fillText(fitText(ctx, company.value.replace(/\n/g, ' '), dateLeft - (x + k(G.footX)), k(G.footFs)), x + k(G.footX), fy);
  }

  // 自由記入欄（行の下〜下段の上）
  if (free && free.value) {
    const areaTop = top + rowH * rows.length + k(14 * U);
    const areaBottom = fy - k(G.footFs) * 0.9;
    const lh = k(G.freeFs) * 1.35;
    const maxLines = Math.max(0, Math.floor((areaBottom - areaTop) / lh));
    ctx.textAlign = 'left';
    free.value.split('\n').slice(0, maxLines).forEach((ln, i) => {
      ctx.fillText(fitText(ctx, ln, w - 2 * ins - k(32 * U), k(G.freeFs)), x + k(G.footX), areaTop + lh * (i + 0.5));
    });
  }
  ctx.restore();
  return h;
}

// 文字列中の「番号」を ±delta する（No.12 → No.13、B-000 → B-001 のように桁数維持）
// 小数部（5.0 の 0 など）は対象外
export function stepNumber(s, delta) {
  const str = s || '';
  const re = /\d+/g;
  let m, target = null;
  while ((m = re.exec(str))) {
    const i = m.index;
    const fractional = i >= 2 && str[i - 1] === '.' && /\d/.test(str[i - 2]);
    if (!fractional) target = m;
  }
  if (!target) return null;
  const digits = target[0];
  const n = Math.max(0, parseInt(digits, 10) + delta);
  let out = String(n);
  if (digits.length > 1 && digits[0] === '0') out = out.padStart(digits.length, '0');
  return str.slice(0, target.index) + out + str.slice(target.index + digits.length);
}

// 写真台帳・メタデータ用：黒板の文字情報
export function boardText(board, when, dateMode) {
  return shown(board).map((f) => ({
    label: f.label,
    value: f.type === 'date' ? formatDate(when, dateMode) : f.value || '',
  }));
}
