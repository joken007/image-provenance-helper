// sidepanel/c2pa-verifier.js —— C2PA 验签调度器（主线程侧）
//
// 本文件只负责：把图片字节交给 Worker、等待结果、做好超时与错误兜底。
// 真正的 WASM 验签在 sidepanel/c2pa-worker.js 中执行。
//
// 【架构说明 —— 这是对原文档 v1.0 的两处修正】
//   1. 原文档用 @contentauth/c2pa-web/inline，它通过 Blob URL 创建 Worker。
//      MV3 扩展页面 CSP 只允许 worker-src 'self'，blob: 会被直接拒绝
//      （Refused to create a worker from blob: URL）。
//      修正：改为从扩展包内加载真实 worker 文件（chrome-extension:// 源），符合 CSP。
//   2. C2PA 的 WASM 绑定读取 Blob 时需要 FileReaderSync，
//      该 API 只存在于 WorkerGlobalScope，主线程没有。
//      修正：验签必须放在 Worker 内，主线程只做调度。
//   两点叠加的结论：既不能用 blob Worker，也放不了主线程，只能用扩展内真实 Worker。

const WORKER_TIMEOUT_MS = 60000;

let worker = null;
let seq = 0;
const pending = new Map();

/** 惰性创建验签 Worker */
function getWorker() {
  if (worker) return worker;

  worker = new Worker(chrome.runtime.getURL('sidepanel/c2pa-worker.js'), { type: 'module' });

  worker.onmessage = (e) => {
    const { id, ok, result, error } = e.data || {};
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (ok) entry.resolve(result);
    else entry.reject(new Error(error || '验签失败'));
  };

  worker.onerror = (e) => {
    // Worker 整体崩溃：让所有等待中的请求失败，避免永久挂起
    const err = new Error(e?.message || 'C2PA 验签 Worker 异常');
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    pending.clear();
    worker = null;
  };

  return worker;
}

/**
 * 对图片执行 C2PA 验签
 * @param {Blob} blob 图片字节
 * @param {string} mime MIME
 * @returns {Promise<object>} 与 Investigation.c2pa 同构的结果
 */
export async function verifyC2pa(blob, mime) {
  if (!blob) {
    return { status: 'error', method: 'c2pa-wasm', note: '图片字节不可用，无法验签' };
  }

  const id = ++seq;

  let bytes;
  try {
    bytes = await blob.arrayBuffer();
  } catch (e) {
    return {
      status: 'error',
      method: 'c2pa-wasm',
      note: `读取图片字节失败：${e?.message || e}`,
    };
  }

  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('C2PA 验签超时（60 秒）'));
      }, WORKER_TIMEOUT_MS);

      pending.set(id, { resolve, reject, timer });

      const w = getWorker();
      // 转移 ArrayBuffer 以避免结构化克隆拷贝大文件
      // wasmUrl 必须由主线程传入：module worker 作用域内没有 chrome.runtime API
      w.postMessage(
        {
          id,
          bytes,
          mime: mime || blob.type || 'image/jpeg',
          wasmUrl: chrome.runtime.getURL('vendor/c2pa_bg.wasm'),
        },
        [bytes]
      );
    });

    return result;
  } catch (e) {
    return {
      status: 'error',
      method: 'c2pa-wasm',
      note: `C2PA 验签失败：${e?.message || e}。可点击「在线验证」到 contentcredentials.org 交叉核对。`,
    };
  }
}

/** 探测验签模块能否在本机正常工作（用于选项页自检） */
export async function selfTest() {
  try {
    // 用一个 1x1 的最小 PNG 走一遍完整链路
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
      0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54,
      0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01,
      0x0d, 0x0a, 0x2d, 0xb4,
      0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    const blob = new Blob([pngBytes], { type: 'image/png' });
    const r = await verifyC2pa(blob, 'image/png');
    if (r.status === 'error') {
      return { ok: false, note: r.note };
    }
    return { ok: true, note: 'C2PA WASM 验签模块工作正常（测试样本无内容凭证，符合预期）' };
  } catch (e) {
    return { ok: false, note: `C2PA WASM 自检失败：${e?.message || e}` };
  }
}
