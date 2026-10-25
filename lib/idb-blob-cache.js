// lib/idb-blob-cache.js —— 图片二进制 LRU 临时缓存（IndexedDB）
//
// 设计要点：
//  1. 以图片 sha256 为主键直接存原生 Blob（比 Base64 小 33%，且不占 chrome.storage 配额）；
//  2. 仅保留最近 MAX_BLOBS 张，超出按 createdAt 自动淘汰；
//  3. Service Worker 与 Side Panel 处于同一扩展源，可共享同一个数据库。

import { MAX_BLOBS } from './constants.js';

const DB_NAME = 'ImageProvenanceBlobDB';
const DB_VERSION = 1;
const STORE_NAME = 'blobs';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'sha256' });
        store.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB 被其它标签页占用，请关闭侧栏后重试'));
  });
  return dbPromise;
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务被中止'));
  });
}

export async function putImageBlob(sha256, blob) {
  if (!sha256 || !blob) throw new Error('putImageBlob: 缺少 sha256 或 blob');
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).put({ sha256, blob, createdAt: Date.now(), size: blob.size });
  await txDone(tx);
  await pruneOldBlobs(db);
  return true;
}

export async function getImageBlob(sha256) {
  if (!sha256) return null;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(sha256);
    req.onsuccess = () => resolve(req.result?.blob || null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteImageBlob(sha256) {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).delete(sha256);
  await txDone(tx);
}

async function pruneOldBlobs(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const idx = store.index('createdAt');
    // 'prev' 方向游标 = 按 createdAt 从新到旧
    const req = idx.openCursor(null, 'prev');
    let count = 0;
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) return;
      count += 1;
      if (count > MAX_BLOBS) store.delete(cursor.primaryKey);
      cursor.continue();
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

/** 列出缓存中所有图片的元信息（不含字节） */
export async function listImageBlobs() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () =>
      resolve(
        (req.result || [])
          .map(({ sha256, createdAt, size }) => ({ sha256, createdAt, size }))
          .sort((a, b) => b.createdAt - a.createdAt)
      );
    req.onerror = () => reject(req.error);
  });
}

export async function clearImageBlobs() {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).clear();
  await txDone(tx);
}
