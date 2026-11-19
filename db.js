// IndexedDB の薄いラッパー
// stores:
//   meta   : 平文の起動情報（金庫=暗号化済み鍵、失敗回数など）  key = 文字列
//   kv     : 暗号化済みの設定・黒板・テンプレート            key = 文字列
//   photos : { id, createdAt, meta(暗号) }                     key = id
//   thumbs : { id, data(暗号) }                                key = id
//   images : { id, data(暗号) }                                key = id

let DB_NAME = 'kokuban-cam';
const DB_VERSION = 2;
let dbp = null;

// 初めに認証した利用者が旧版の写真庫を引き継ぐ。別の利用者には個別の写真庫を開く。
export async function selectVault(uid) {
  const db = await openDb();
  const tx = db.transaction('meta', 'readwrite');
  const done = txDone(tx);
  const store = tx.objectStore('meta');
  const req = store.get('owner');
  req.onsuccess = () => { if (!req.result) store.put(uid, 'owner'); };
  await done;
  if (req.result && req.result !== uid) {
    db.close(); dbp = null; DB_NAME = 'kokuban-cam:' + uid;
  }
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function openDb() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    let blocked = false;
    r.onblocked = () => {
      blocked = true; dbp = null;
      reject(new Error('別の画面で旧版の写真庫が開いています。そちらを閉じてから、もう一度ログインしてください。'));
    };
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('photos')) {
        const s = db.createObjectStore('photos', { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('thumbs')) db.createObjectStore('thumbs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts', { keyPath: 'id' });
    };
    r.onsuccess = () => {
      if (blocked) { r.result.close(); return; }
      r.result.onversionchange = () => { r.result.close(); dbp = null; };
      resolve(r.result);
    };
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

export async function get(store, key) {
  const db = await openDb();
  return reqP(db.transaction(store).objectStore(store).get(key));
}

export async function put(store, value, key) {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value, key);
  return txDone(tx);
}

export async function createPhotoVault(vault) {
  const db = await openDb();
  const tx = db.transaction('meta', 'readwrite');
  const meta = tx.objectStore('meta');
  meta.add(vault, 'vault');
  meta.put({fails:0, until:0, wipeAt:0}, 'sec');
  await txDone(tx);
}

export async function del(store, key) {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  return txDone(tx);
}

export async function getAll(store) {
  const db = await openDb();
  return reqP(db.transaction(store).objectStore(store).getAll());
}

export async function draftIds() {
  const db = await openDb();
  return reqP(db.transaction('drafts').objectStore('drafts').getAllKeys());
}

export async function putDraft(draft) {
  const db = await openDb();
  const tx = db.transaction('drafts', 'readwrite', {durability:'strict'});
  tx.objectStore('drafts').add(draft);
  await txDone(tx);
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

// 写真1枚を3つのストアへまとめて保存（途中失敗なら全部取り消し）
export async function putPhoto(rec, thumb, image, fromDraft = false) {
  const db = await openDb();
  const stores = ['photos', 'thumbs', 'images'];
  if (fromDraft) stores.push('drafts');
  const tx = db.transaction(stores, 'readwrite', {durability:'strict'});
  let written = false;
  function write() {
    tx.objectStore('photos').put(rec);
    tx.objectStore('thumbs').put(thumb);
    tx.objectStore('images').put(image);
    written = true;
  }
  if (fromDraft) {
    const drafts = tx.objectStore('drafts');
    const r = drafts.getKey(rec.id);
    r.onsuccess = () => { if (r.result) { write(); drafts.delete(rec.id); } };
  } else write();
  await txDone(tx);
  return written;
}

export async function deletePhotos(ids) {
  const db = await openDb();
  const tx = db.transaction(['photos', 'thumbs', 'images'], 'readwrite');
  for (const id of ids) {
    tx.objectStore('photos').delete(id);
    tx.objectStore('thumbs').delete(id);
    tx.objectStore('images').delete(id);
  }
  return txDone(tx);
}

export async function hasPhoto(id) {
  return !!(await get('photos', id));
}

export async function wipeAll() {
  const db = await openDb();
  const stores = Array.from(db.objectStoreNames);
  const tx = db.transaction(stores, 'readwrite');
  const meta = tx.objectStore('meta');
  const owner = meta.get('owner');
  owner.onsuccess = () => {
    for (const name of stores) tx.objectStore(name).clear();
    if (owner.result) meta.put(owner.result, 'owner');
  };
  await txDone(tx);
}
