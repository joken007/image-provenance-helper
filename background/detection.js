// background/detection.js —— 像素级 AI 生成概率检测（仅作辅助线索，绝不可单独定性）
//
// 为什么只算弱信号：主流服务（Sightengine / Hive）准确率 84%–94%，
// 对后期修图或特定画风有 5%–15% 误报，无法承担定性责任。

import { loadOptions } from './store.js';

/**
 * 调用配置的检测服务
 * @param {string} bytesBase64 图片字节
 * @param {string} mime
 */
export async function runAiDetection(bytesBase64, mime = 'image/jpeg') {
  const options = await loadOptions();
  const provider = options.detectionProvider || 'none';

  if (provider === 'none') {
    return [];
  }

  const dataUrl = `data:${mime};base64,${bytesBase64}`;

  try {
    if (provider === 'sightengine') {
      const key = options.sightengineApiKey;
      if (!key) throw new Error('未配置 Sightengine API Key');
      const resp = await fetch(
        `https://api.sightengine.com/4.0/check.json?models=ai-generated&api_key=${encodeURIComponent(key)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: dataUrl }),
        }
      );
      if (!resp.ok) throw new Error(`Sightengine 返回 HTTP ${resp.status}`);
      const data = await resp.json();
      const score =
        data?.ai_generated?.ai_generated_confidence ??
        data?.results?.[0]?.ai_generated?.ai_generated_confidence ??
        null;
      const label =
        typeof score === 'number' ? (score >= 0.5 ? 'ai' : 'real') : 'uncertain';
      return [
        {
          provider: 'sightengine',
          aiScore: typeof score === 'number' ? score : null,
          label,
          checkedAt: new Date().toISOString(),
        },
      ];
    }

    if (provider === 'hive') {
      const key = options.sightengineApiKey; // 复用同一配置槽位存 Hive key
      if (!key) throw new Error('未配置 Hive API Key');
      const resp = await fetch('https://api.thehive.ai/api/v2/task/sync', {
        method: 'POST',
        headers: { Authorization: `Token ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          media: dataUrl,
          media_type: 'image',
          model: 'ai-generated',
        }),
      });
      if (!resp.ok) throw new Error(`Hive 返回 HTTP ${resp.status}`);
      const data = await resp.json();
      const score =
        data?.output?.[0]?.ai_generated?.score ??
        data?.status?.response?.output?.[0]?.ai_generated?.score ??
        null;
      const label =
        typeof score === 'number' ? (score >= 0.5 ? 'ai' : 'real') : 'uncertain';
      return [
        {
          provider: 'hive',
          aiScore: typeof score === 'number' ? score : null,
          label,
          checkedAt: new Date().toISOString(),
        },
      ];
    }
  } catch (e) {
    return [
      {
        provider,
        aiScore: null,
        label: 'uncertain',
        checkedAt: new Date().toISOString(),
        error: String(e?.message || e),
      },
    ];
  }

  return [];
}

/** 人工回填检测结果 */
export function manualDetection(score, label) {
  return [
    {
      provider: 'manual',
      aiScore: typeof score === 'number' ? score : null,
      label: label || 'uncertain',
      checkedAt: new Date().toISOString(),
    },
  ];
}
