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
import { openReverseSearches, openSingleEngine, copyImageToClipboard } from './reverse-search.js';
import { readMetadata } from './metadata.js';
import { scanC2paJumbf } from './c2pa-quick-scan.js';
import { waybackFirstSeen } from './timeline.js';
import { runAiDetection, manualDetection } from './detection.js';
import { evaluateSignals, canUseQuickTemplates } from './score.js';
import { saveSessionInvestigation, patchSessionInvestigation, persistInvestigation, loadSessionInvestigation, loadOptions, saveOptions, listHistory, loadHistoryItem, deleteHistoryItem } from './store.js';
import { generateVisionFacts, generateFactCheckDraft, verifyDraftUrls } from './llm.js';
import { VERDICTS } from '../lib/constants.js';
import { newInvestigationId, safeHost, base64ToUint8, sha256Hex } from '../lib/utils.js';
import { putImageBlob } from '../lib/idb-blob-cache.js';
import { readDimensions } from './pick-image.js';

// ---------- 安装与菜单 ----------

chrome.runtime.onInstalled.addListener(() => {
  // 点击工具栏图标直接打开 Side Panel，无需冗余的 popup
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'investigate-image',
      title: '使用「辟谣助手」核查此图片',
      contexts: ['image', 'page', 'frame'],
    });
  });
});

// SW 可能在不重启浏览器的情况下被回收再唤醒，需补注册一次菜单
chrome.runtime.onStartup.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'investigate-image',
      title: '使用「辟谣助手」核查此图片',
      contexts: ['image', 'page', 'frame'],
    });
  });
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
  if (command !== 'investigate-primary-image') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
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

// ---------- 右键菜单触发 ----------

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'investigate-image' || !tab?.id) return;

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

  let inv = {
    id,
    schemaVersion: 2,
    status: 'collecting',
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

  // 1) 先写入 collecting 初始状态，侧栏打开即刻读到骨架，零消息丢失
  await saveSessionInvestigation(inv);

  try {
    // 2) 取图与原图归一化
    const imgResult = await acquireImage(ctx);
    inv.image = { ...inv.image, ...imgResult.meta };
    await saveSessionInvestigation(inv);

    // 3) 五路并发取证
    const [engines, exif, c2paQuick, pageTimeline, imageTimeline, detection] = await Promise.all([
      openReverseSearches(inv.image, ctx.windowId),
      readMetadata(imgResult.bytesBase64),
      Promise.resolve(scanC2paJumbf(imgResult.bytesBase64)),
      waybackFirstSeen(inv.image.pageUrl, 'page'),
      inv.image.canDirectLink
        ? waybackFirstSeen(inv.image.normalizedUrl, 'image')
        : Promise.resolve(null),
      imgResult.bytesBase64 ? runAiDetection(imgResult.bytesBase64, inv.image.mime) : Promise.resolve([]),
    ]);

    inv.engines = engines;
    inv.exif = exif;
    inv.c2pa = c2paQuick;
    inv.timeline = { page: pageTimeline, image: imageTimeline };
    inv.detection = detection || [];
    inv.status = 'ready';

    // 4) 计算信号强度与默认倾向
    const scored = evaluateSignals(inv);
    inv.signals = scored.signals;
    inv.systemSuggestion = scored.suggestion;
    inv.updatedAt = new Date().toISOString();

    await saveSessionInvestigation(inv);
    await persistInvestigation(inv);
  } catch (e) {
    inv.status = 'failed';
    inv.error = String(e?.message || e);
    inv.updatedAt = new Date().toISOString();
    await saveSessionInvestigation(inv);
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

    // 手动上传的图片同样需要反搜：本地图片没有公网 URL，
    // 因此只准备引擎入口（不自动开标签页，避免打扰），
    // 由用户在侧栏复制图片后自行到引擎首页按 Ctrl+V 检索
    inv.engines = await openReverseSearches(inv.image, undefined, false);

    inv.status = 'ready';

    const scored = evaluateSignals(inv);
    inv.signals = scored.signals;
    inv.systemSuggestion = scored.suggestion;
    inv.updatedAt = new Date().toISOString();

    await saveSessionInvestigation(inv);
    await persistInvestigation(inv);
    return { inv };
  } catch (e) {
    inv.status = 'failed';
    inv.error = String(e?.message || e);
    await saveSessionInvestigation(inv);
    return { inv };
  }
}
