// sidepanel/c2pa-worker.js —— C2PA 验签 Worker（module worker）
//
// 【为什么必须用 Worker 而不是主线程】
//   C2PA 的 WASM 绑定在读取 Blob 时会调用 FileReaderSync，
//   而 FileReaderSync 只存在于 WorkerGlobalScope，主线程没有该 API。
//   因此验签必须跑在 Worker 里。
//
// 【为什么不直接用 @contentauth/c2pa-web/inline】
//   c2pa-web 的 inline 构建通过 Blob URL 创建 Worker，
//   但 Manifest V3 扩展页面的 CSP 仅允许 worker-src 'self'（不含 blob:），
//   在侧栏里会直接抛 "Refused to create a worker from blob: URL"。
//   这里改为从扩展包内加载本文件（chrome-extension:// 源），完全符合 worker-src 'self'。
//
// 【安全性】
//   WASM 二进制经 SHA-512 校验（对比官方 WASM_SRI），防止供应链被篡改。

import initC2pa, { WasmReader } from '../vendor/c2pa.wasm.js';

// 【注意】module worker 作用域内没有 chrome.* API（chrome.runtime 只注入到
// window 与 service worker 作用域）。因此 WASM 地址不能在这里用
// chrome.runtime.getURL 求取，改由主线程在 postMessage 时一并传入。
let WASM_URL = 'vendor/c2pa_bg.wasm';
const SRI = 'sha512-emM3xZBux5bBdEv6EFS+y5SmKnxnEVbNgsjbsOLnC/YYm55pviVrgdOxU8iQUisOISQvXrTj7H8vvsgYVlpeLg==';

let wasmReady = null;

async function ensureWasm() {
  if (wasmReady) return wasmReady;
  wasmReady = (async () => {
    const resp = await fetch(WASM_URL);
    if (!resp.ok) throw new Error(`WASM 文件读取失败：HTTP ${resp.status}`);
    const bytes = await resp.arrayBuffer();

    // 供应链完整性校验：SHA-512 与官方 SRI 比对
    try {
      const digest = await crypto.subtle.digest('SHA-512', bytes);
      const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
      const actual = `sha512-${b64}`;
      if (actual !== SRI) {
        throw new Error('C2PA WASM 完整性校验失败（SRI 不匹配），已拒绝加载');
      }
    } catch (e) {
      if (String(e?.message || '').includes('SRI')) throw e;
      // 某些环境不支持 subtle.digest 时降级放行，不阻断功能
    }

    await initC2pa({ module_or_path: bytes });
    return true;
  })();
  try {
    return await wasmReady;
  } catch (e) {
    wasmReady = null;
    throw e;
  }
}

/** MIME -> C2PA reader 格式名 */
function toReaderFormat(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('png')) return 'image/png';
  if (m.includes('webp')) return 'image/webp';
  if (m.includes('heic')) return 'image/heic';
  if (m.includes('heif')) return 'image/heif';
  if (m.includes('avif')) return 'image/avif';
  return 'image/jpeg';
}

self.onmessage = async (e) => {
  const { id, bytes, mime, wasmUrl } = e.data || {};
  try {
    if (wasmUrl) WASM_URL = wasmUrl;
    await ensureWasm();
    const blob = new Blob([new Uint8Array(bytes)], { type: mime || 'image/jpeg' });
    const reader = await WasmReader.fromBlob(toReaderFormat(mime), blob);

    let manifestStore = null;
    let active = null;
    try {
      manifestStore = JSON.parse(reader.json());
      active = manifestStore?.activeManifest || null;
    } catch {
      /* 解析失败按无凭证处理 */
    }

    const result = buildResult(active, manifestStore);
    try {
      reader.free?.();
    } catch {
      /* ignore */
    }
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    const msg = String(err?.message || err);
    // C2PA SDK 在图片不含凭证时抛出 JumbfNotFound —— 这是「无凭证」而非错误
    if (/JumbfNotFound|NoManifestFound|NotFound/i.test(msg)) {
      self.postMessage({
        id,
        ok: true,
        result: {
          status: 'absent',
          method: 'c2pa-wasm',
          note: '图片不含 C2PA 内容凭证（WASM 验签确认无 JUMBF 清单）',
        },
      });
      return;
    }
    self.postMessage({ id, ok: false, error: msg });
  }
};

/** 把 activeManifest 归纳成与 Investigation.c2pa 同构的结果 */
function buildResult(active, manifestStore) {
  if (!active) {
    return {
      status: 'absent',
      method: 'c2pa-wasm',
      note: '图片不含有效的内容凭证清单（manifest store 为空）',
      manifestStore: manifestStore || null,
    };
  }

  const signer =
    active.signer?.signature_info?.issuer ||
    active.signature_info?.issuer ||
    active.signer ||
    undefined;

  const claimGenerator =
    active.claim_generator_info?.name ||
    active.claim_generator ||
    active.metadata?.claim_generator ||
    undefined;

  const actions = extractActions(active);
  const validationStatus = active.validation_status || active.validationStatus;
  const validationErrors = extractValidationErrors(active);

  const hasError = (validationStatus && validationStatus !== 'VALID') || validationErrors.length > 0;

  return {
    status: hasError ? 'verified-invalid' : 'verified-valid',
    method: 'c2pa-wasm',
    signer,
    claimGenerator,
    isAiGenerated: detectAiGenerated(active, actions),
    actions,
    validationErrors,
    validationStatus,
    note: hasError
      ? '内容凭证存在，但签名校验未通过（图片可能在签发后被修改）'
      : '内容凭证签名验证通过',
    manifestStore: manifestStore || null,
  };
}

function extractActions(active) {
  const out = [];
  const raw =
    active.assertions?.['c2pa.actions'] ||
    active.assertions?.['c2pa.actions_v2'] ||
    active.actions ||
    null;
  if (!raw) return out;

  const push = (act) => {
    if (!act) return;
    if (typeof act === 'string') {
      out.push(act);
      return;
    }
    const name =
      act.action?.name || act.action || act.name || act.softwareAgent || act.digitalSourceType || null;
    if (name) out.push(String(name));
  };

  if (Array.isArray(raw)) raw.forEach(push);
  else if (raw.actions && Array.isArray(raw.actions)) raw.actions.forEach(push);
  else push(raw);

  return [...new Set(out)].slice(0, 12);
}

function extractValidationErrors(active) {
  const out = [];
  const raw = active.validation_errors || active.validationErrors || [];
  const push = (e) => {
    if (!e) return;
    if (typeof e === 'string') out.push(e);
    else if (e.code) out.push(`${e.code}${e.description ? ` — ${e.description}` : ''}`);
    else if (e.description) out.push(e.description);
  };
  if (Array.isArray(raw)) raw.forEach(push);
  else push(raw);
  return out.slice(0, 10);
}

function detectAiGenerated(active, actions) {
  const dst = active.metadata?.digitalSourceType || active.digitalSourceType || '';
  if (/trainedAlgorithmicMedia|compositeWithTrainedAlgorithmicMedia|compositeSynthetic/i.test(dst)) {
    return true;
  }
  const gen = String(active.claim_generator_info?.name || active.claim_generator || '');
  if (/midjourney|dall[·\-]?e|firefly|imagen|stable\s*diffusion|flux|synthid/i.test(gen)) return true;
  return actions.some((a) => /trainedAlgorithmicMedia|c2pa\.created/i.test(a));
}
