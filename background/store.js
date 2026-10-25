// background/store.js —— 双层存储：session（当前会话内存态）+ local（历史记录 LRU）
//
// 关键设计：
//  * chrome.storage.session 存当前正在进行的 Investigation JSON（不含图片字节），
//    Side Panel 通过 storage.session.onChanged 毫秒级同步刷新，避免首开面板的消息竞态丢失。
//  * chrome.storage.local 存最近 500 条轻量索引 + 最近 200 条完整记录，防止 10MB 配额被撑爆。
//  * 图片原始字节一律不进入 chrome.storage，只存在 IndexedDB（见 lib/idb-blob-cache.js）。

import { STORAGE_KEYS, MAX_FULL_RECORDS, MAX_INDEX_RECORDS } from '../lib/constants.js';

/** 写入当前会话状态 */
export async function saveSessionInvestigation(inv) {
  await chrome.storage.session.set({
    [STORAGE_KEYS.SESSION_CURRENT]: inv.id,
    [STORAGE_KEYS.SESSION_INV(inv.id)]: inv,
  });
  return inv;
}

/** 读取当前会话状态 */
export async function loadSessionInvestigation() {
  const { [STORAGE_KEYS.SESSION_CURRENT]: id } = await chrome.storage.session.get(
    STORAGE_KEYS.SESSION_CURRENT
  );
  if (!id) return null;
  const key = STORAGE_KEYS.SESSION_INV(id);
  const bag = await chrome.storage.session.get(key);
  return bag[key] || null;
}

/** 局部更新当前会话状态（增量更新，避免整包重写） */
export async function patchSessionInvestigation(id, patch) {
  const key = STORAGE_KEYS.SESSION_INV(id);
  const bag = await chrome.storage.session.get(key);
  const current = bag[key];
  if (!current) return null;
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await chrome.storage.session.set({ [key]: next });
  return next;
}

/** 持久化到 local 并维护 LRU */
export async function persistInvestigation(inv) {
  const bag = await chrome.storage.local.get(STORAGE_KEYS.LOCAL_INDEX);
  const index = Array.isArray(bag[STORAGE_KEYS.LOCAL_INDEX]) ? bag[STORAGE_KEYS.LOCAL_INDEX] : [];

  const summary = {
    id: inv.id,
    createdAt: inv.createdAt,
    updatedAt: inv.updatedAt,
    pageSite: inv.image?.pageSite || '',
    pageTitle: inv.image?.pageTitle || '',
    verdict: inv.manual?.verdict || inv.systemSuggestion,
    headline: inv.article?.draft?.headline || (inv.image?.pageTitle || '').slice(0, 28),
    hasC2pa: inv.c2pa?.status?.startsWith('verified') || false,
    strongSignalCount: (inv.signals || []).filter((s) => s.strength === 'strong').length,
  };

  const filtered = index.filter((item) => item.id !== inv.id);
  filtered.unshift(summary);

  // 超出完整记录上限的旧条目，其完整 JSON 需要一并删除
  const keysToRemove = [];
  if (filtered.length > MAX_FULL_RECORDS) {
    for (const old of filtered.slice(MAX_FULL_RECORDS)) {
      keysToRemove.push(STORAGE_KEYS.LOCAL_INV(old.id));
    }
  }
  const trimmedIndex = filtered.slice(0, MAX_INDEX_RECORDS);

  await chrome.storage.local.set({
    [STORAGE_KEYS.LOCAL_INDEX]: trimmedIndex,
    [STORAGE_KEYS.LOCAL_INV(inv.id)]: inv,
  });

  if (keysToRemove.length) {
    await chrome.storage.local.remove(keysToRemove);
  }
  return summary;
}

/** 读取历史索引 */
export async function listHistory() {
  const bag = await chrome.storage.local.get(STORAGE_KEYS.LOCAL_INDEX);
  return Array.isArray(bag[STORAGE_KEYS.LOCAL_INDEX]) ? bag[STORAGE_KEYS.LOCAL_INDEX] : [];
}

/** 读取一条完整历史记录 */
export async function loadHistoryItem(id) {
  const bag = await chrome.storage.local.get(STORAGE_KEYS.LOCAL_INV(id));
  return bag[STORAGE_KEYS.LOCAL_INV(id)] || null;
}

/** 删除一条历史记录 */
export async function deleteHistoryItem(id) {
  const index = await listHistory();
  await chrome.storage.local.set({
    [STORAGE_KEYS.LOCAL_INDEX]: index.filter((i) => i.id !== id),
  });
  await chrome.storage.local.remove(STORAGE_KEYS.LOCAL_INV(id));
  return true;
}

/** 读取扩展配置 */
export async function loadOptions() {
  const bag = await chrome.storage.local.get(STORAGE_KEYS.OPTIONS);
  return { ...defaultOptions(), ...(bag[STORAGE_KEYS.OPTIONS] || {}) };
}

/** 保存扩展配置 */
export async function saveOptions(patch) {
  const current = await loadOptions();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [STORAGE_KEYS.OPTIONS]: next });
  return next;
}

export function defaultOptions() {
  return {
    // LLM（两段式辟谣生成）
    llmBaseUrl: '',
    llmApiKey: '',
    llmVisionModel: '',
    llmTextModel: '',
    // 像素级 AI 检测
    sightengineApiKey: '',
    detectionProvider: 'none', // none | sightengine | hive
    // 反搜引擎启用清单
    enabledEngines: ['google-lens', 'tineye', 'yandex', 'bing', 'baidu', 'saucenao'],
    // 其它
    watermark: '@图片溯源核查笔记',
    autoOpenEngines: true,
  };
}
