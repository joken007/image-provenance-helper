// background/service-worker.js —— 主控编排
//
// 职责：
//  * 注册右键菜单、同步打开 Side Panel（在任何 await 之前调用，保留用户手势）
//  * 五路并发取证编排，每完成一路即增量更新 storage.session，侧栏实时重绘
//  * 处理来自侧栏的其它消息（剪贴板、验签、人工补录、生成文案等）
//
// 严禁：
//  * 不在 await 之后调用 chrome.sidePanel.open()（会丢失用户手势）
//  * 不用全局变量保存状态（SW 空闲 30 秒会被挂起回收）

import { acquireImage } from './pick-image.js';
import { openSingleEngine, copyImageToClipboard } from './reverse-search.js';
import { runAutoVerify } from './auto-verify.js';
import { readMetadata } from './metadata.js';
import { scanC2paJumbf } from './c2pa-quick-scan.js';
import { waybackFirstSeen } from './timeline.js';
import { runAiDetection, manualDetection } from './detection.js';
import { evaluateSignals, canUseQuickTemplates } from './score.js';
import { saveSessionInvestigation, patchSessionInvestigation, persistInvestigation, loadSessionInvestigation, loadOptions, saveOptions, listHistory, loadHistoryItem, deleteHistoryItem } from './store.js';
import { generateVisionFacts, generateFactCheckDraft, verifyDraftUrls } from './llm.js';
import { runTextFactCheck } from './text-factcheck.js';
import { VERDICTS } from '../lib/constants.js';
import { AUTO_ENGINES, AUTO_ENGINE_BY_ID } from '../lib/engine-adapters.js';
import { newInvestigationId, safeHost, base64ToUint8, uint8ToBase64, sha256Hex } from '../lib/utils.js';
import { putImageBlob } from '../lib/idb-blob-cache.js';
import { readDimensions } from './pick-image.js';

// ---------- 安装与菜单 ----------

/** 统一的右键菜单注册（安装与浏览器启动时都要做一次） */
function registerContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'investigate-image',
      title: '使用「辟谣助手」核查此图片',
      contexts: ['image', 'page', 'frame'],
    });
    chrome.contextMenus.create({
      id: 'investigate-text',
      title: '使用「辟谣助手」核查这段文字',
      contexts: ['selection', 'page'],
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  // 点击工具栏图标直接打开 Side Panel，无需冗余的 popup
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  registerContextMenus();
});

// SW 可能在不重启浏览器的情况下被回收再唤醒，需补注册一次菜单
chrome.runtime.onStartup.addListener(() => {
  registerContextMenus();
});

// 也用 action 点击作为「核查当前页面主图」的入口
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  runInvestigationPipeline({
    tabId: tab.id,
    windowId: tab.windowId,
    frameId: 0,
    srcUrl: '',
    pageUrl: tab.url || '',
    pageTitle: tab.title || '',
    pickLargest: true,
  });
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});

  if (command === 'investigate-page-text') {
    runTextPipeline({ tabId: tab.id, windowId: tab.windowId, selectionText: '' });
    return;
  }
  if (command !== 'investigate-primary-image') return;

  runInvestigationPipeline({
    tabId: tab.id,
    windowId: tab.windowId,
    frameId: 0,
    srcUrl: '',
    pageUrl: tab.url || '',
    pageTitle: tab.title || '',
    pickLargest: true,
  });
});

// ---------- 右键菜单触发 ----------

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;

  // 文本核查
  if (info.menuItemId === 'investigate-text') {
    // 【关键】必须在任何 await 之前同步调用 sidePanel.open，否则丢失用户手势报错
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
    runTextPipeline({
      tabId: tab.id,
      windowId: tab.windowId,
      frameId: info.frameId ?? 0,
      selectionText: info.selectionText || '',
      pageUrl: info.pageUrl || tab.url || '',
      pageTitle: tab.title || '',
    });
    return;
  }

  if (info.menuItemId !== 'investigate-image') return;

  // 【关键】必须在任何 await 之前同步调用 sidePanel.open，否则丢失用户手势报错
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});

  runInvestigationPipeline({
    tabId: tab.id,
    windowId: tab.windowId,
    frameId: info.frameId ?? 0,
    srcUrl: info.srcUrl || '',
    pageUrl: info.pageUrl || tab.url || '',
    pageTitle: tab.title || '',
  });
});

// ---------- 主流程 ----------

async function runInvestigationPipeline(ctx) {
  const id = newInvestigationId();
  const now = new Date().toISOString();

  // 【文图一体】若当前会话已有文本核查结果，带到新的图像核查里，
  // 这样同一条社交内容的「文字证据」与「图像证据」能在侧栏同屏对照。
  const prev = await loadSessionInvestigation();
  const carriedTextCheck = prev?.textCheck || null;

  let inv = {
    id,
    schemaVersion: 3,
    status: 'collecting',
    kind: carriedTextCheck ? 'both' : 'image',
    createdAt: now,
    updatedAt: now,
    image: {
      originalUrl: ctx.srcUrl,
      normalizedUrl: ctx.srcUrl,
      canDirectLink: false,
      pageUrl: ctx.pageUrl,
      pageTitle: ctx.pageTitle,
      pageSite: safeHost(ctx.pageUrl),
      width: 0,
      height: 0,
      mime: 'image/jpeg',
      sha256: '',
      acquiredVia: 'page-context',
    },
    engines: [],
    exif: { present: false, rawTagCount: 0 },
    c2pa: { status: 'absent', method: 'jumbf-scan', note: '正在扫描...' },
    detection: [],
    timeline: {},
    signals: [],
    systemSuggestion: VERDICTS.UNDETERMINED,
    manual: { verdict: null, confidence: null, claimText: ctx.pageTitle || '', notes: '' },
  };

  if (carriedTextCheck) inv.textCheck = carriedTextCheck;

  // 1) 先写入 collecting 初始状态，侧栏打开即刻读到骨架，零消息丢失
  await saveSessionInvestigation(inv);

  try {
    // 2) 取图与原图归一化
    const imgResult = await acquireImage(ctx);
    inv.image = { ...inv.image, ...imgResult.meta };

    // 先给每个引擎放一个占位卡片，侧栏立刻能看到「谁在跑」
    inv.engines = await prepareEngineSlots();
    inv.autoVerify = { status: 'pending', note: '等待本地取证完成' };
    await saveSessionInvestigation(inv);

    // 3) 本地取证并发（全部是本地或轻量网络操作，秒级完成）
    const [exif, c2paQuick, pageTimeline, imageTimeline, detection] = await Promise.all([
      readMetadata(imgResult.bytesBase64),
      Promise.resolve(scanC2paJumbf(imgResult.bytesBase64)),
      waybackFirstSeen(inv.image.pageUrl, 'page'),
      inv.image.canDirectLink
        ? waybackFirstSeen(inv.image.normalizedUrl, 'image')
        : Promise.resolve(null),
      imgResult.bytesBase64 ? runAiDetection(imgResult.bytesBase64, inv.image.mime) : Promise.resolve([]),
    ]);

    inv.exif = exif;
    inv.c2pa = c2paQuick;
    inv.timeline = { page: pageTimeline, image: imageTimeline };
    inv.detection = detection || [];
    inv.status = 'ready';
    inv.autoVerify = {
      status: 'running',
      startedAt: new Date().toISOString(),
      note: '正在后台自动反搜（页面不可见，完成即关闭）',
    };

    // 4) 计算信号强度与默认倾向
    const scored = evaluateSignals(inv);
    inv.signals = scored.signals;
    inv.systemSuggestion = scored.suggestion;
    inv.updatedAt = new Date().toISOString();

    await saveSessionInvestigation(inv);
    await persistInvestigation(inv);

    // 5) 全自动反搜：不阻塞主流程，后台跑，每完成一个引擎即时刷新
    startAutoVerify(inv.id, inv.image, imgResult.bytesBase64);
  } catch (e) {
    inv.status = 'failed';
    inv.error = String(e?.message || e);
    inv.updatedAt = new Date().toISOString();
    await saveSessionInvestigation(inv);
  }
}

/**
 * 文本事实核查主流程
 *
 * 【与图像链路的关系】
 *   共用同一个会话记录：先核查文字、再核查同一条内容的配图，两份证据在侧栏同屏展示，
 *   构成「文图一体」的证据链。反过来（先图后文）同样成立。
 *
 * 【为什么要 fire-and-forget】
 *   文本核查要走「拆解 → 多次联网检索 → 逐条判定 → 汇总」，耗时可达一两分钟。
 *   不能占住右键菜单的调用栈，否则浏览器会认为用户手势失效、侧栏也打不开。
 *   因此后台跑，每完成一个阶段就增量回写 storage.session，侧栏实时刷新。
 */
async function runTextPipeline(ctx) {
  const now = new Date().toISOString();

  // 1) 取帖文正文上下文
  const post = await fetchPostContext(ctx);

  // 2) 准备会话：有会话就复用（文图一体），没有就新建
  let inv = await loadSessionInvestigation();
  if (!inv) {
    inv = {
      id: newInvestigationId(),
      schemaVersion: 3,
      status: 'collecting',
      kind: 'text',
      createdAt: now,
      updatedAt: now,
      image: {
        originalUrl: '',
        normalizedUrl: '',
        canDirectLink: false,
        pageUrl: ctx.pageUrl || '',
        pageTitle: ctx.pageTitle || '',
        pageSite: safeHost(ctx.pageUrl || ''),
        width: 0,
        height: 0,
        mime: 'image/jpeg',
        sha256: '',
        acquiredVia: 'text-check',
      },
      engines: [],
      exif: { present: false, rawTagCount: 0 },
      c2pa: { status: 'absent', method: 'jumbf-scan', note: '文本核查不涉及内容凭证' },
      detection: [],
      timeline: {},
      signals: [],
      systemSuggestion: VERDICTS.UNDETERMINED,
      manual: { verdict: null, confidence: null, claimText: '', notes: '' },
    };
  } else {
    inv.kind = inv.kind === 'image' ? 'both' : inv.kind || 'text';
  }

  inv.textCheck = {
    status: post?.ok ? 'running' : 'failed',
    stage: post?.ok ? 'starting' : 'failed',
    note: post?.ok ? '正在准备联网取证…' : post?.error || '未能读取页面内容',
    startedAt: now,
    source: post?.ok
      ? {
          platform: post.platform?.name || post.platform || '',
          platformId: post.platform?.id || '',
          url: post.url || '',
          title: post.pageTitle || post.title || '',
          author: post.author || '',
          publishedAt: post.publishedAt || '',
          text: post.text || '',
          strategy: post.strategy || '',
          note: post.note || '',
          images: post.images || [],
        }
      : null,
    claims: [],
    queries: [],
    sources: [],
    groups: [],
    results: [],
    report: null,
    blockedSources: [],
    factCheck: { available: false, note: '', hits: [] },
    failures: [],
    updatedAt: now,
  };

  await saveSessionInvestigation(inv);

  if (!post?.ok) {
    inv.textCheck.finishedAt = new Date().toISOString();
    await saveSessionInvestigation(inv);
    return;
  }

  // 3) 后台跑四段管线，进度实时回写
  const invId = inv.id;
  runTextFactCheck(post, async (state) => {
    const cur = await loadSessionInvestigation();
    if (!cur || cur.id !== invId) return;
    await saveSessionInvestigation({
      ...cur,
      textCheck: state,
      updatedAt: new Date().toISOString(),
    });
  });
}

/**
 * 从目标标签页取帖文正文
 *
 * 【为什么要现场注入一次内容脚本】
 *   扩展装好之后，用户已经打开的页面里并没有 content/text-probe.js（内容脚本只在加载时注入）。
 *   此时直接 sendMessage 会报 "Receiving end does not exist"。
 *   所以先试一次，失败就把脚本注入进去再试。
 */
async function fetchPostContext(ctx) {
  let post = null;

  try {
    post = await chrome.tabs.sendMessage(ctx.tabId, { type: 'probe:get-post-context' });
  } catch {
    post = null;
  }

  if (!post) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: ctx.tabId, allFrames: false },
        files: ['content/text-probe.js'],
      });
      post = await chrome.tabs.sendMessage(ctx.tabId, { type: 'probe:get-post-context' });
    } catch {
      post = null;
    }
  }

  if (!post || post.ok === false) {
    return {
      ok: false,
      error:
        (post && post.error) ||
        '无法读取页面内容：当前页面可能禁止扩展访问，或没有可核查的文本。请尝试框选要核查的那段文字后重试。',
    };
  }

  // 用户框选的文字优先于自动抽取的正文 —— 这才是「某一条社群内容」的精确指向
  const sel = String(ctx.selectionText || '').trim();
  if (sel.length >= 8) {
    return {
      ...post,
      ok: true,
      strategy: 'selection',
      text: sel.slice(0, 6000),
      selection: sel.slice(0, 6000),
      note: '使用你框选的文字作为核查对象',
    };
  }

  return { ...post, ok: true };
}

/**
 * 生成引擎占位卡片（让侧栏立刻看到有哪些引擎在跑）
 * 只列出配置里启用的引擎，避免出现一堆永远「排队中」的死卡片。
 */
async function prepareEngineSlots() {
  let enabled;
  try {
    const options = await loadOptions();
    enabled = options.autoEngines || options.enabledEngines;
  } catch {
    enabled = null;
  }
  const list = Array.isArray(enabled) && enabled.length ? enabled : AUTO_ENGINES.map((e) => e.id);
  return AUTO_ENGINES.filter((e) => list.includes(e.id)).map((e) => ({
    id: e.id,
    name: e.name,
    autoStatus: 'queued',
    autoNote: '排队中',
    matchCount: 0,
  }));
}

/**
 * 后台启动全自动反搜（fire-and-forget）
 *
 * 【为什么不怕 SW 被回收】
 *   执行器每 1.2 秒调用一次 chrome.scripting.executeScript，
 *   这些 API 调用会持续重置 Service Worker 的 30 秒空闲计时器，
 *   因此长任务期间 SW 不会被终止。
 */
function startAutoVerify(invId, image, bytesBase64) {
  (async () => {
    try {
      const payload = await compressForSearch(bytesBase64, image.mime);

      await runAutoVerify(image, payload.base64, payload.mime, async (partial) => {
        // 每完成一个引擎就增量落盘，侧栏通过 storage.session.onChanged 实时重绘
        const cur = await loadSessionInvestigation();
        if (!cur || cur.id !== invId) return;

        const merged = applyEngineResults(cur, partial);
        const scored = evaluateSignals(merged);
        await saveSessionInvestigation({
          ...merged,
          signals: scored.signals,
          systemSuggestion: scored.suggestion,
          updatedAt: new Date().toISOString(),
        });
      });

      // 全部结束
      const finalInv = await loadSessionInvestigation();
      if (finalInv && finalInv.id === invId) {
        // 【关键增强】反搜结果里往往没有日期（SauceNAO 这类画廊站尤其如此）。
        // 因此对命中的站点自动反查 Wayback 首次收录时间——这一步也全自动，
        // 是「旧图挪用」能判出来的主要依据。
        const enriched = await enrichWithArchive(finalInv);

        const scored = evaluateSignals(enriched);
        const done = {
          ...enriched,
          signals: scored.signals,
          systemSuggestion: scored.suggestion,
          autoVerify: {
            ...(enriched.autoVerify || {}),
            status: 'done',
            finishedAt: new Date().toISOString(),
            note: '自动反搜完成，所有临时页面已关闭',
          },
          updatedAt: new Date().toISOString(),
        };
        await saveSessionInvestigation(done);
        await persistInvestigation(done);
      }
    } catch (e) {
      const cur = await loadSessionInvestigation();
      if (cur && cur.id === invId) {
        await saveSessionInvestigation({
          ...cur,
          autoVerify: {
            ...(cur.autoVerify || {}),
            status: 'failed',
            note: `自动反搜失败：${e?.message || e}`,
            finishedAt: new Date().toISOString(),
          },
          updatedAt: new Date().toISOString(),
        });
      }
    }
  })();
}

/** 把部分引擎结果合并回 inv.engines */
function applyEngineResults(inv, partial) {
  const byId = new Map((partial || []).map((r) => [r.id, r]));
  const engines = (inv.engines || []).map((e) => (byId.has(e.id) ? { ...e, ...byId.get(e.id) } : e));
  // 补齐可能漏掉的引擎
  for (const r of partial || []) {
    if (!engines.some((e) => e.id === r.id)) engines.push(r);
  }
  return { ...inv, engines };
}

/**
 * 对反搜命中的站点反查 Wayback 首次收录时间（全自动，无需人工）
 *
 * 【为什么必须做这一步】
 *   反向搜图引擎（SauceNAO / Bing / 百度）多数只返回"哪里出现过这张图"，
 *   不返回时间。而判定「旧图挪用」的核心恰恰是时间——谁更早。
 *   Wayback 的首次收录时间是可自动获取、且相对可信的时间锚点。
 *
 * 【严谨性】
 *   首次收录时间只代表"爬虫最早索引到该页面的时间"，可能晚于真实发布日。
 *   因此它作为强信号时，必须配合"多站点命中"一起看；单条命中只算弱信号。
 */
async function enrichWithArchive(inv) {
  try {
    // 收集反搜命中的候选链接（按引擎结果顺序，优先带年份的）
    const candidates = [];
    for (const e of inv.engines || []) {
      for (const it of e.items || []) {
        for (const l of it.links || []) {
          if (l?.url && /^https?:\/\//i.test(l.url)) candidates.push(l.url);
        }
      }
    }
    const uniq = [...new Set(candidates)];
    if (!uniq.length) return inv;

    // 含年份的 URL 往往就是文章/归档页，优先查它们
    uniq.sort((a, b) => {
      const ay = /20\d{2}/.test(a) ? 1 : 0;
      const by = /20\d{2}/.test(b) ? 1 : 0;
      return by - ay;
    });
    const targets = uniq.slice(0, 5);

    // 限并发 3，避免 Wayback 限流
    const hits = [];
    for (let i = 0; i < targets.length; i += 3) {
      const batch = targets.slice(i, i + 3);
      const rs = await Promise.all(
        batch.map((u) => waybackFirstSeen(u, 'page').catch(() => null))
      );
      rs.forEach((r, idx) => {
        if (r?.firstSeen) hits.push({ url: batch[idx], firstSeen: r.firstSeen, snapshotUrl: r.snapshotUrl });
      });
    }

    if (!hits.length) {
      return {
        ...inv,
        archiveProbe: { checked: targets.length, hits: 0, note: '命中站点均未被 Wayback 收录' },
      };
    }

    hits.sort((a, b) => String(a.firstSeen).localeCompare(String(b.firstSeen)));
    const earliest = hits[0];

    // 把最早归档时间挂到对应引擎上，让评分器能产出强信号
    let attached = false;
    const engines = (inv.engines || []).map((e) => {
      if (attached) return e;
      const has = (e.items || []).some((it) =>
        (it.links || []).some((l) => l?.url === earliest.url)
      );
      if (!has) return e;
      attached = true;
      return {
        ...e,
        earliestSeenDate: e.earliestSeenDate || String(earliest.firstSeen).slice(0, 10),
        earliestSeenUrl: e.earliestSeenUrl || earliest.snapshotUrl || earliest.url,
        earliestSeenContext: `该出处经 Wayback 确认最早收录于 ${String(earliest.firstSeen).slice(0, 10)}`,
        archiveVerified: true,
      };
    });

    return {
      ...inv,
      engines,
      archiveProbe: {
        checked: targets.length,
        hits: hits.length,
        earliestFirstSeen: String(earliest.firstSeen).slice(0, 10),
        earliestUrl: earliest.url,
        snapshotUrl: earliest.snapshotUrl,
        samples: hits.slice(0, 5).map((h) => ({ url: h.url, firstSeen: String(h.firstSeen).slice(0, 10) })),
      },
    };
  } catch (e) {
    return { ...inv, archiveProbe: { error: String(e?.message || e) } };
  }
}

/**
 * 压缩图片用于反搜上传
 * 搜索用不上超高分辨率，压到长边 1200 能显著加快上传并降低被限流概率
 */
async function compressForSearch(bytesBase64, mime, maxEdge = 1200) {
  if (!bytesBase64) return { base64: '', mime: mime || 'image/jpeg' };
  try {
    const bytes = base64ToUint8(bytesBase64);
    const blob = new Blob([bytes], { type: mime || 'image/jpeg' });

    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
    // 已经足够小就不重编码
    if (scale >= 1 && bytes.length < 700 * 1024) {
      bmp.close?.();
      return { base64: bytesBase64, mime: mime || 'image/jpeg' };
    }

    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    bmp.close?.();

    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.86 });
    const buf = new Uint8Array(await out.arrayBuffer());
    return { base64: uint8ToBase64(buf), mime: 'image/jpeg' };
  } catch {
    // 压缩失败就用原图，宁可慢也别丢功能
    return { base64: bytesBase64, mime: mime || 'image/jpeg' };
  }
}

// ---------- 侧栏消息路由 ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const result = await handleMessage(msg);
      sendResponse({ ok: true, ...result });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true; // 保持消息通道开放以支持异步响应
});

async function handleMessage(msg) {
  switch (msg.type) {
    case 'inv:get-current': {
      const inv = await loadSessionInvestigation();
      return { inv };
    }

    case 'inv:get-options': {
      return { options: await loadOptions() };
    }

    case 'inv:save-options': {
      return { options: await saveOptions(msg.patch || {}) };
    }

    case 'inv:patch': {
      // 人工写入结论 / 证据回填 / 备注 / 闸门状态
      const inv = await loadSessionInvestigation();
      if (!inv) throw new Error('当前没有进行中的核查');

      const patch = {};
      if (msg.manual) patch.manual = { ...inv.manual, ...msg.manual };
      if (msg.article) patch.article = { ...(inv.article || {}), ...msg.article };
      if (msg.enginePatch) {
        patch.engines = inv.engines.map((e) =>
          e.id === msg.enginePatch.id ? { ...e, ...msg.enginePatch } : e
        );
      }
      if (msg.claimText !== undefined) {
        patch.manual = { ...inv.manual, claimText: msg.claimText };
      }

      const next = await patchSessionInvestigation(inv.id, patch);

      // 人工补录的最早出处属于强信号，需重新评分
      const scored = evaluateSignals(next);
      const scoredNext = {
        ...next,
        signals: scored.signals,
        systemSuggestion: scored.suggestion,
      };
      await saveSessionInvestigation(scoredNext);
      await persistInvestigation(scoredNext);
      return { inv: scoredNext, canQuick: canUseQuickTemplates(scoredNext) };
    }

    case 'inv:manual-drop': {
      // 用户手动拖入图片：建立一次新的核查会话
      return await handleManualDrop(msg.file);
    }

    case 'inv:manual-detection': {
      const inv = await loadSessionInvestigation();
      if (!inv) throw new Error('当前没有进行中的核查');
      const next = await patchSessionInvestigation(inv.id, {
        detection: manualDetection(msg.score, msg.label),
      });
      const scored = evaluateSignals(next);
      const scoredNext = { ...next, signals: scored.signals, systemSuggestion: scored.suggestion };
      await saveSessionInvestigation(scoredNext);
      await persistInvestigation(scoredNext);
      return { inv: scoredNext };
    }

    case 'engines:open-one': {
      const inv = await loadSessionInvestigation();
      if (!inv) throw new Error('当前没有进行中的核查');
      const r = await openSingleEngine(msg.engineId, inv.image, msg.useClipboard);
      return r;
    }

    case 'clipboard:write-image': {
      return await copyImageToClipboard(msg.base64, msg.mime || 'image/png');
    }

    case 'c2pa:save-result': {
      const inv = await loadSessionInvestigation();
      if (!inv) throw new Error('当前没有进行中的核查');
      const next = await patchSessionInvestigation(inv.id, { c2pa: msg.c2pa });
      const scored = evaluateSignals(next);
      const scoredNext = { ...next, signals: scored.signals, systemSuggestion: scored.suggestion };
      await saveSessionInvestigation(scoredNext);
      await persistInvestigation(scoredNext);
      return { inv: scoredNext };
    }

    case 'llm:generate-facts': {
      const inv = await loadSessionInvestigation();
      if (!inv) throw new Error('当前没有进行中的核查');
      const facts = await generateVisionFacts(inv, msg.imageBase64, msg.mime);
      const next = await patchSessionInvestigation(inv.id, {
        article: {
          ...(inv.article || {}),
          visionModel: msg.visionModel || '',
          facts,
          factsConfirmed: false,
          draft: null,
          draftConfirmed: false,
          blockedSources: [],
          generatedAt: new Date().toISOString(),
        },
      });
      await saveSessionInvestigation(next);
      return { inv: next };
    }

    case 'llm:generate-draft': {
      const inv = await loadSessionInvestigation();
      if (!inv) throw new Error('当前没有进行中的核查');
      const { draft, blockedSources } = await generateFactCheckDraft(inv);
      const next = await patchSessionInvestigation(inv.id, {
        article: {
          ...(inv.article || {}),
          textModel: (await loadOptions()).llmTextModel || '',
          draft,
          draftConfirmed: false,
          blockedSources,
          generatedAt: new Date().toISOString(),
        },
      });
      await saveSessionInvestigation(next);
      return { inv: next, blockedSources };
    }

    case 'llm:verify-urls': {
      const inv = await loadSessionInvestigation();
      if (!inv) throw new Error('当前没有进行中的核查');
      const { blockedSources, cleaned } = verifyDraftUrls(inv, msg.draft || inv.article?.draft);
      return { blockedSources, cleaned };
    }

    case 'text:check-active-tab': {
      // 侧栏按钮入口：对当前活动标签页发起文本核查
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('找不到当前标签页');
      await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
      runTextPipeline({
        tabId: tab.id,
        windowId: tab.windowId,
        selectionText: '',
        pageUrl: tab.url || '',
        pageTitle: tab.title || '',
      });
      return { ok: true };
    }

    case 'history:list': {
      return { history: await listHistory() };
    }

    case 'history:load': {
      return { inv: await loadHistoryItem(msg.id) };
    }

    case 'history:delete': {
      return { ok: await deleteHistoryItem(msg.id) };
    }

    default:
      throw new Error(`未知消息类型：${msg.type}`);
  }
}

/**
 * 手动拖入图片：建立一次新的核查会话
 * 与右键触发共用同一套取证流水线，只是图片来源换成本地文件。
 */
async function handleManualDrop(file) {
  const { bytesBase64, fileName, mime } = file || {};
  if (!bytesBase64) throw new Error('未提供图片数据');

  const id = newInvestigationId();
  const now = new Date().toISOString();

  let inv = {
    id,
    schemaVersion: 2,
    status: 'collecting',
    createdAt: now,
    updatedAt: now,
    image: {
      originalUrl: '',
      normalizedUrl: '',
      canDirectLink: false,
      pageUrl: '',
      pageTitle: fileName || '手动上传图片',
      pageSite: '本地文件',
      width: 0,
      height: 0,
      mime: mime || 'image/jpeg',
      sha256: '',
      acquiredVia: 'manual-drop',
    },
    engines: [],
    exif: { present: false, rawTagCount: 0 },
    c2pa: { status: 'absent', method: 'jumbf-scan', note: '正在扫描...' },
    detection: [],
    timeline: {},
    signals: [],
    systemSuggestion: VERDICTS.UNDETERMINED,
    manual: { verdict: null, confidence: null, claimText: '', notes: '' },
  };
  await saveSessionInvestigation(inv);

  try {
    const bytes = base64ToUint8(bytesBase64);
    const sha = await sha256Hex(bytes);
    await putImageBlob(sha, new Blob([bytes], { type: inv.image.mime }));

    const dims = await readDimensions(bytes, inv.image.mime);

    inv.image.sha256 = sha;
    inv.image.width = dims.width;
    inv.image.height = dims.height;
    inv.image.notes = '用户手动上传的图片';

    const [exif, c2paQuick] = await Promise.all([
      readMetadata(bytesBase64),
      Promise.resolve(scanC2paJumbf(bytesBase64)),
    ]);
    inv.exif = exif;
    inv.c2pa = c2paQuick;

    // 手动上传的图片同样走全自动反搜：本地图片没有公网地址，
    // 但 DataTransfer 上传不依赖 URL，因此照样能全自动跑完并自动关闭页面
    inv.engines = await prepareEngineSlots();
    inv.autoVerify = { status: 'pending', note: '等待本地取证完成' };

    inv.status = 'ready';

    const scored = evaluateSignals(inv);
    inv.signals = scored.signals;
    inv.systemSuggestion = scored.suggestion;
    inv.autoVerify = { status: 'running', startedAt: new Date().toISOString(), note: '正在后台自动反搜' };
    inv.updatedAt = new Date().toISOString();

    await saveSessionInvestigation(inv);
    await persistInvestigation(inv);

    // 手动上传的图片字节直接来自本地，无需再压缩取图
    startAutoVerify(inv.id, inv.image, bytesBase64);
    return { inv };
  } catch (e) {
    inv.status = 'failed';
    inv.error = String(e?.message || e);
    await saveSessionInvestigation(inv);
    return { inv };
  }
}
