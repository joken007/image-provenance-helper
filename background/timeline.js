// background/timeline.js —— Wayback Machine 首次收录时间线
//
// 为什么要「去噪归一化」：实际网页里的 URL 往往带 utm_source / spm / imageView2 等参数，
// 精确匹配会返回 0 条记录。归一化后再查，命中率显著提升。

import { WAYBACK_CDX } from '../lib/constants.js';
import { normalizeForArchive } from '../lib/utils.js';

/**
 * 查询 Wayback CDX，获取某个 URL 的首次收录时间
 * @param {string} rawUrl 原始 URL
 * @param {'image'|'page'} kind 用途标记
 */
export async function waybackFirstSeen(rawUrl, kind = 'page') {
  if (!rawUrl) {
    return { firstSeen: undefined, snapshotUrl: undefined, sampleCount: 0, error: 'URL 为空' };
  }

  const normalized = normalizeForArchive(rawUrl);
  const query = new URL(WAYBACK_CDX);
  query.searchParams.set('url', normalized);
  query.searchParams.set('output', 'json');
  query.searchParams.set('fl', 'timestamp,original,statuscode');
  query.searchParams.set('filter', 'statuscode:200');
  query.searchParams.set('collapse', 'digest');
  query.searchParams.set('limit', '5');

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const resp = await fetch(query.toString(), { signal: controller.signal });
    clearTimeout(timer);

    if (!resp.ok) {
      return {
        firstSeen: undefined,
        snapshotUrl: undefined,
        sampleCount: 0,
        error: `CDX 接口返回 HTTP ${resp.status}`,
      };
    }

    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return {
        firstSeen: undefined,
        snapshotUrl: undefined,
        sampleCount: 0,
        error: 'CDX 返回非 JSON 内容',
      };
    }

    if (!Array.isArray(data) || data.length < 2) {
      return {
        firstSeen: undefined,
        snapshotUrl: undefined,
        sampleCount: 0,
        error: '该 URL 未被 Wayback 收录',
      };
    }

    // 第 0 行是表头
    const rows = data.slice(1);
    const earliest = rows[0];
    const ts = earliest?.[0];
    const original = earliest?.[1];

    return {
      firstSeen: ts ? formatTimestamp(ts) : undefined,
      snapshotUrl: ts && original ? `https://web.archive.org/web/${ts}/${original}` : undefined,
      sampleCount: rows.length,
      normalizedUrl: normalized,
      kind,
    };
  } catch (e) {
    return {
      firstSeen: undefined,
      snapshotUrl: undefined,
      sampleCount: 0,
      error: `时间线查询失败：${e?.message || e}`,
    };
  }
}

/** Wayback 时间戳 20240102030405 -> ISO 串 */
function formatTimestamp(ts) {
  const s = String(ts);
  if (s.length < 14) return s;
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(
    10,
    12
  )}:${s.slice(12, 14)}Z`;
  return iso;
}
