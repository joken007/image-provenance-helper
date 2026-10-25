// options/options.js —— 扩展设置页

import { AUTO_ENGINES } from '../lib/engine-adapters.js';

const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', async () => {
  await load();

  $('btn-save').addEventListener('click', save);
  $('btn-test-c2pa').addEventListener('click', testC2pa);
});

async function load() {
  const res = await send({ type: 'inv:get-options' });
  const o = res?.options || {};
  $('llmBaseUrl').value = o.llmBaseUrl || '';
  $('llmApiKey').value = o.llmApiKey || '';
  $('llmVisionModel').value = o.llmVisionModel || '';
  $('llmTextModel').value = o.llmTextModel || '';
  $('detectionProvider').value = o.detectionProvider || 'none';
  $('sightengineApiKey').value = o.sightengineApiKey || '';
  $('watermark').value = o.watermark || '';
  $('autoOpenEngines').checked = o.autoOpenEngines !== false;

  const enabled = new Set(o.autoEngines || o.enabledEngines || AUTO_ENGINES.map((e) => e.id));
  $('engine-checks').innerHTML = AUTO_ENGINES.map(
    (e) =>
      `<label><input type="checkbox" data-engine="${e.id}" ${
        enabled.has(e.id) ? 'checked' : ''
      } /> ${e.name}</label>`
  ).join('');
}

async function save() {
  const enabledEngines = [...document.querySelectorAll('[data-engine]')]
    .filter((c) => c.checked)
    .map((c) => c.dataset.engine);

  const patch = {
    llmBaseUrl: $('llmBaseUrl').value.trim(),
    llmApiKey: $('llmApiKey').value.trim(),
    llmVisionModel: $('llmVisionModel').value.trim(),
    llmTextModel: $('llmTextModel').value.trim(),
    detectionProvider: $('detectionProvider').value,
    sightengineApiKey: $('sightengineApiKey').value.trim(),
    watermark: $('watermark').value.trim(),
    autoOpenEngines: $('autoOpenEngines').checked,
    autoEngines: enabledEngines,
    enabledEngines, // 兼容旧字段
  };

  const res = await send({ type: 'inv:save-options', patch });
  if (res?.ok) {
    show('ok', '设置已保存');
  } else {
    show('err', res?.error || '保存失败');
  }
  setTimeout(() => show('', ''), 3000);
}

async function testC2pa() {
  show('', '正在初始化 WASM 验签模块…');
  try {
    const { selfTest } = await import('../sidepanel/c2pa-verifier.js');
    const r = await selfTest();
    show(r.ok ? 'ok' : 'err', r.note);
  } catch (e) {
    show('err', `自检失败：${e?.message || e}`);
  }
}

function show(kind, text) {
  const el = $('tip');
  el.className = kind;
  el.textContent = text;
}

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(res || {});
    });
  });
}
