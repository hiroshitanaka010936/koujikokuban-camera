// JPEG に撮影日時(EXIF)と黒板情報(XMP, UTF-8)を書き込む
// 写真管理ソフト・台帳ソフトで撮影日時と黒板の文字を読めるようにするため

const enc = new TextEncoder();

function ascii(s) {
  const b = new Uint8Array(s.length + 1);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0x7f;
  return b; // 末尾 NUL
}
function u16(n) { return new Uint8Array([n & 0xff, (n >> 8) & 0xff]); }
function u32(n) { return new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]); }

const T = { ASCII: 2, SHORT: 3, LONG: 4, UNDEFINED: 7 };

function ifdSize(entries) {
  let data = 0;
  for (const e of entries) if (e.data.length > 4) data += e.data.length + (e.data.length & 1);
  return 2 + entries.length * 12 + 4 + data;
}

function writeIfd(out, offset, entries) {
  entries.sort((a, b) => a.tag - b.tag);
  const dv = new DataView(out.buffer);
  let p = offset;
  dv.setUint16(p, entries.length, true); p += 2;
  let dataPos = offset + 2 + entries.length * 12 + 4;
  for (const e of entries) {
    dv.setUint16(p, e.tag, true);
    dv.setUint16(p + 2, e.type, true);
    dv.setUint32(p + 4, e.count, true);
    if (e.data.length <= 4) {
      out.set(e.data, p + 8);
    } else {
      dv.setUint32(p + 8, dataPos, true);
      out.set(e.data, dataPos);
      dataPos += e.data.length + (e.data.length & 1);
    }
    p += 12;
  }
  dv.setUint32(p, 0, true); // 次のIFDなし
}

function exifDate(d) {
  const z = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}:${z(d.getMonth() + 1)}:${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
}
function tzOffset(d) {
  const m = -d.getTimezoneOffset();
  const s = m >= 0 ? '+' : '-';
  const a = Math.abs(m);
  return `${s}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

function buildExif(when, width, height) {
  const dt = ascii(exifDate(when));
  const ifd0 = [
    { tag: 0x0131, type: T.ASCII, count: 0, data: ascii('KokubanCam') },
    { tag: 0x0132, type: T.ASCII, count: 0, data: dt },
    { tag: 0x8769, type: T.LONG, count: 1, data: u32(0) }, // ExifIFD へのポインタ（後で設定）
  ];
  const exif = [
    { tag: 0x9000, type: T.UNDEFINED, count: 4, data: enc.encode('0232') },
    { tag: 0x9003, type: T.ASCII, count: 0, data: dt },
    { tag: 0x9004, type: T.ASCII, count: 0, data: dt },
    { tag: 0x9011, type: T.ASCII, count: 0, data: ascii(tzOffset(when)) },
    { tag: 0xa002, type: T.LONG, count: 1, data: u32(width) },
    { tag: 0xa003, type: T.LONG, count: 1, data: u32(height) },
  ];
  for (const e of [...ifd0, ...exif]) if (e.type === T.ASCII) e.count = e.data.length;
  const off0 = 8;
  const offExif = off0 + ifdSize(ifd0);
  ifd0.find((e) => e.tag === 0x8769).data = u32(offExif);
  const tiff = new Uint8Array(offExif + ifdSize(exif));
  tiff.set([0x49, 0x49, 0x2a, 0x00]); // "II*\0" リトルエンディアン
  tiff.set(u32(off0), 4);
  writeIfd(tiff, off0, ifd0);
  writeIfd(tiff, offExif, exif);
  return segment(0xe1, [enc.encode('Exif\0\0'), tiff]);
}

function xmlEsc(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

function isoLocal(d) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}${tzOffset(d)}`;
}

function buildXmp(when, rows) {
  const desc = rows.map((r) => `${r.label}: ${r.value}`).join('\n');
  const items = rows.map((r) => `<rdf:li rdf:parseType="Resource"><kb:label>${xmlEsc(r.label)}</kb:label><kb:value>${xmlEsc(r.value)}</kb:value></rdf:li>`).join('');
  const xml = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:kb="urn:kokubancam:ns:1.0/">
<xmp:CreateDate>${isoLocal(when)}</xmp:CreateDate>
<xmp:CreatorTool>KokubanCam</xmp:CreatorTool>
<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xmlEsc(desc)}</rdf:li></rdf:Alt></dc:description>
<kb:Board><rdf:Seq>${items}</rdf:Seq></kb:Board>
</rdf:Description></rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;
  return segment(0xe1, [enc.encode('http://ns.adobe.com/xap/1.0/\0'), enc.encode(xml)]);
}

function segment(marker, parts) {
  const len = parts.reduce((a, p) => a + p.length, 0) + 2;
  if (len > 65535) throw new Error('メタデータが大きすぎます');
  const out = new Uint8Array(len + 2);
  out[0] = 0xff; out[1] = marker; out[2] = len >> 8; out[3] = len & 0xff;
  let p = 4;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}

// jpeg: Uint8Array（canvas.toBlob の結果）。戻り値: 新しい Uint8Array
export function addJpegMeta(jpeg, { when, width, height, rows }) {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('JPEGではありません');
  let i = 2;
  // 先頭の APP0/APP1 などを取り除く（JFIF など）
  while (i + 4 < jpeg.length && jpeg[i] === 0xff && jpeg[i + 1] >= 0xe0 && jpeg[i + 1] <= 0xef) {
    i += 2 + ((jpeg[i + 2] << 8) | jpeg[i + 3]);
  }
  let xmp;
  try { xmp = buildXmp(when, rows); } catch { xmp = new Uint8Array(0); }
  const exif = buildExif(when, width, height);
  const rest = jpeg.subarray(i);
  const out = new Uint8Array(2 + exif.length + xmp.length + rest.length);
  out[0] = 0xff; out[1] = 0xd8;
  out.set(exif, 2);
  out.set(xmp, 2 + exif.length);
  out.set(rest, 2 + exif.length + xmp.length);
  return out;
}
