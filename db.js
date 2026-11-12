// IndexedDB の薄いラッパー
// stores:
//   meta   : 平文の起動情報（金庫=暗号化済み鍵、失敗回数など）  key = 文字列
//   kv     : 暗号化済みの設定・黒板・テンプレート            key = 文字列
//   photos : { id, createdAt, meta(暗号) }                     key = id
//   thumbs : { id, data(暗号) }                                key = id
//   images : { id, data(暗号) }                                key = id

const DB_NAME = 'kokuban-cam';
const DB_VERSION = 1;
let dbp = null;

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
    };
    r.onsuccess = () => resolve(r.result);
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

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

// 写真1枚を3つのストアへまとめて保存（途中失敗なら全部取り消し）
export async function putPhoto(rec, thumb, image) {
  const db = await openDb();
  const tx = db.transaction(['photos', 'thumbs', 'images'], 'readwrite');
  tx.objectStore('photos').put(rec);
  tx.objectStore('thumbs').put(thumb);
  tx.objectStore('images').put(image);
  return txDone(tx);
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
  if (dbp) {
    (await dbp).close();
    dbp = null;
  }
  await new Promise((resolve, reject) => {
    const r = indexedDB.deleteDatabase(DB_NAME);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
    r.onblocked = () => resolve();
  });
}
