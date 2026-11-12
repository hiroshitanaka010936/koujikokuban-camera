// デジタル工事黒板：既定値・描画・文字操作

export const FONT = '"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP","Noto Sans CJK JP",system-ui,sans-serif';

let seq = 0;
export function newFieldId() {
  return 'f' + Date.now().toString(36) + (seq++).toString(36);
}

export function defaultBoard() {
  return {
    fields: [
      { id: 'kouji', label: '工事名', value: '', type: 'text', show: true },
      { id: 'koushu', label: '工種', value: '', type: 'text', show: true },
      { id: 'shubetsu', label: '種別', value: '', type: 'text', show: true },
      { id: 'saibetsu', label: '細別', value: '', type: 'text', show: true },
      { id: 'sokuten', label: '測点', value: 'No.1', type: 'text', show: true },
      { id: 'date', label: '撮影日', value: '', type: 'date', show: true },
      { id: 'sekou', label: '施工者', value: '', type: 'text', show: true },
      { id: 'bikou', label: '備考', value: '', type: 'multiline', show: true },
    ],
    style: { color: 'green', opacity: 1 },
    // 写真に対する位置（割合）。縦向き写真 p / 横向き写真 l で別々に記憶
    pos: { p: { x: 0.03, y: 0.66, w: 0.5 }, l: { x: 0.02, y: 0.55, w: 0.36 } },
  };
}

const THEMES = {
  green: { bg: '#1d4d33', frame: '#8a6a3d', text: '#ffffff', line: 'rgba(255,255,255,0.8)', label: '#e8f3ea' },
  black: { bg: '#161616', frame: '#5a5a5a', text: '#ffffff', line: 'rgba(255,255,255,0.75)', label: '#dddddd' },
  white: { bg: '#fbfbf7', frame: '#2b2b2b', text: '#111111', line: '#333333', label: '#222222' },
};

export function formatDate(d, mode) {
  const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
  if (mode === 'reiwa') {
    const r = y - 2018;
    return `令和${r === 1 ? '元' : r}年${m}月${day}日`;
  }
  return `${y}/${String(m).padStart(2, '0')}/${String(day).padStart(2, '0')}`;
}

function visibleRows(board) {
  return board.fields.filter((f) => f.show !== false);
}

function rowLines(f) {
  if (f.type !== 'multiline') return 1;
  const n = (f.value || '').split('\n').length;
  return Math.min(4, Math.max(1, n));
}

// 黒板の高さ（幅 w のとき）
export function measureBoard(board, w) {
  const rh = w * 0.095;
  const frame = w * 0.018;
  let h = frame * 2;
  for (const f of visibleRows(board)) {
    const lines = rowLines(f);
    h += lines === 1 ? rh : rh * 0.2 + lines * rh * 0.72;
  }
  return Math.max(h, frame * 2 + rh);
}

function fitText(ctx, text, maxW, size, weight) {
  let s = size;
  ctx.font = `${weight} ${s}px ${FONT}`;
  while (ctx.measureText(text).width > maxW && s > size * 0.5) {
    s *= 0.92;
    ctx.font = `${weight} ${s}px ${FONT}`;
  }
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

// ctx 上の (x,y) に幅 w で黒板を描く。when = 撮影日時(Date)、dateMode = 'ad' | 'reiwa'
export function renderBoard(ctx, board, x, y, w, when, dateMode) {
  const th = THEMES[board.style?.color] || THEMES.green;
  const h = measureBoard(board, w);
  const frame = w * 0.018;
  const rh = w * 0.095;
  const lw = w * 0.25;
  const fs = rh * 0.5;

  ctx.save();
  ctx.textBaseline = 'middle';
  // 外枠
  ctx.globalAlpha = board.style?.opacity ?? 1;
  ctx.fillStyle = th.frame;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = th.bg;
  ctx.fillRect(x + frame, y + frame, w - frame * 2, h - frame * 2);
  ctx.globalAlpha = 1;

  const ix = x + frame, iw = w - frame * 2;
  let cy = y + frame;
  const rows = visibleRows(board);
  ctx.strokeStyle = th.line;
  ctx.lineWidth = Math.max(1, w * 0.0035);

  rows.forEach((f, i) => {
    const lines = rowLines(f);
    const hRow = lines === 1 ? rh : rh * 0.2 + lines * rh * 0.72;
    // 罫線
    if (i > 0) {
      ctx.beginPath();
      ctx.moveTo(ix, cy);
      ctx.lineTo(ix + iw, cy);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(ix + lw, cy);
    ctx.lineTo(ix + lw, cy + hRow);
    ctx.stroke();

    // 項目名
    ctx.fillStyle = th.label;
    ctx.textAlign = 'center';
    const lab = fitText(ctx, f.label || '', lw - fs * 0.6, fs * 0.92, '600');
    ctx.fillText(lab, ix + lw / 2, cy + (lines === 1 ? hRow / 2 : rh * 0.46));

    // 値
    ctx.fillStyle = th.text;
    ctx.textAlign = 'left';
    const vx = ix + lw + fs * 0.4;
    const vw = iw - lw - fs * 0.8;
    if (f.type === 'date') {
      const t = fitText(ctx, formatDate(when || new Date(), dateMode), vw, fs, '600');
      ctx.fillText(t, vx, cy + hRow / 2);
    } else if (lines === 1) {
      const t = fitText(ctx, (f.value || '').replace(/\n/g, ' '), vw, fs, '600');
      ctx.fillText(t, vx, cy + hRow / 2);
    } else {
      const ls = (f.value || '').split('\n').slice(0, 4);
      ls.forEach((ln, k) => {
        const t = fitText(ctx, ln, vw, fs * 0.9, '500');
        ctx.fillText(t, vx, cy + rh * 0.1 + rh * 0.72 * (k + 0.5));
      });
    }
    cy += hRow;
  });
  ctx.restore();
  return h;
}

// 文字列中の「番号」を ±delta する（No.12 → No.13、001 → 002 のように桁数維持）
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

// 写真台帳・ファイル名用：黒板の文字情報だけ取り出す
export function boardText(board, when, dateMode) {
  return visibleRows(board).map((f) => ({
    label: f.label,
    value: f.type === 'date' ? formatDate(when, dateMode) : f.value || '',
  }));
}
