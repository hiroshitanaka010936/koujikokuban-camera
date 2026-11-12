// 暗号化まわり（Web Crypto API のみ使用。外部ライブラリなし）
// ・パスコードから PBKDF2-SHA256 で鍵暗号鍵(KEK)を作る
// ・実データはランダムなデータ暗号鍵(DEK, AES-GCM 256bit)で暗号化
// ・DEK は KEK で包んで保存（パスコード変更時は包み直すだけ）

const subtle = crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const PBKDF2_ITERATIONS = 600000;

export function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

async function deriveKek(passcode, salt, iterations) {
  const base = await subtle.importKey('raw', enc.encode(passcode), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function importDek(raw) {
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// 新しい金庫（vault）を作成。戻り値: { vault(保存用), key(使用中のDEK) }
export async function createVault(passcode) {
  const salt = randomBytes(16);
  const kek = await deriveKek(passcode, salt, PBKDF2_ITERATIONS);
  const dekRaw = randomBytes(32);
  const iv = randomBytes(12);
  const wrapped = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode('vault-dek') }, kek, dekRaw);
  const key = await importDek(dekRaw);
  dekRaw.fill(0);
  return {
    vault: { v: 1, salt, iterations: PBKDF2_ITERATIONS, iv, wrapped },
    key,
  };
}

// パスコードで金庫を開ける。違えば例外。
export async function openVault(vault, passcode) {
  const kek = await deriveKek(passcode, vault.salt, vault.iterations);
  const dekRaw = new Uint8Array(
    await subtle.decrypt({ name: 'AES-GCM', iv: vault.iv, additionalData: enc.encode('vault-dek') }, kek, vault.wrapped)
  );
  const key = await importDek(dekRaw);
  return { key, dekRaw }; // dekRaw はパスコード変更のときだけ使い、使い終わったら fill(0)
}

export async function rewrapVault(dekRaw, newPasscode) {
  const salt = randomBytes(16);
  const kek = await deriveKek(newPasscode, salt, PBKDF2_ITERATIONS);
  const iv = randomBytes(12);
  const wrapped = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode('vault-dek') }, kek, dekRaw);
  return { v: 1, salt, iterations: PBKDF2_ITERATIONS, iv, wrapped };
}

// aad: 「どのレコードの何か」を暗号文に結び付け、入れ替え攻撃を防ぐ
export async function encryptBytes(key, bytes, aad) {
  const iv = randomBytes(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, bytes);
  return { iv, ct };
}

export async function decryptBytes(key, box, aad) {
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: box.iv, additionalData: enc.encode(aad) }, key, box.ct));
}

export async function encryptJson(key, obj, aad) {
  return encryptBytes(key, enc.encode(JSON.stringify(obj)), aad);
}

export async function decryptJson(key, box, aad) {
  return JSON.parse(dec.decode(await decryptBytes(key, box, aad)));
}

export async function sha256Hex(bytes) {
  const h = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
}

// バックアップファイル用：パスワードで丸ごと暗号化
// 形式: "KBK1"(4) | salt(16) | iv(12) | 暗号文
const MAGIC = enc.encode('KBK1');
export async function sealWithPassword(bytes, password) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const k = await deriveKek(password, salt, PBKDF2_ITERATIONS);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: MAGIC }, k, bytes));
  return new Blob([MAGIC, salt, iv, ct], { type: 'application/octet-stream' });
}

export async function openWithPassword(bytes, password) {
  const u = new Uint8Array(bytes);
  for (let i = 0; i < 4; i++) if (u[i] !== MAGIC[i]) throw new Error('バックアップファイルの形式が違います');
  const salt = u.slice(4, 20);
  const iv = u.slice(20, 32);
  const k = await deriveKek(password, salt, PBKDF2_ITERATIONS);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: MAGIC }, k, u.subarray(32)));
}
