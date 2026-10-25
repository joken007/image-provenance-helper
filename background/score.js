// background/score.js —— 信号定性与防误判评分器
//
// 三条铁律（写死在本文件）：
//  1. 给证据分级，不打百分比总分；
//  2. 无强信号时，推荐结论强制锁定为 'undetermined'（无法判断）；
//  3. 缺失 EXIF 不构成造假证据（社交平台转存默认清空元数据）。

import { AIGC_SOFTWARE_RE, EDIT_SOFTWARE_RE, IPTC_AI_SOURCE_RE } from './metadata.js';
import { VERDICTS } from '../lib/constants.js';

/**
 * 计算全部信号与默认倾向
 * @param {object} inv
 * @returns {{signals: Array, suggestion: string}}
 */
export function evaluateSignals(inv) {
  const signals = [];

  // ---------- 1. AIGC 确定性元数据信号 ----------
  const chunk = inv.exif?.aigcChunk;
  if (chunk?.detected) {
    const genName = {
      'stable-diffusion': 'Stable Diffusion (WebUI / Forge)',
      comfyui: 'ComfyUI',
      novelai: 'NovelAI',
      midjourney: 'Midjourney',
      other: 'AI 生成器',
    }[chunk.generator] || 'AI 生成器';
    signals.push({
      id: 'sig_png_aigc',
      layer: 'aigc-meta',
      strength: 'strong',
      direction: 'supports-fake',
      text: `PNG 文件内嵌 ${genName} 生成参数（文本块键名：${chunk.rawKey}），确定该图为 AI 生成。`,
      detail: chunk.promptSnippet,
    });
  }

  const dst = inv.exif?.digitalSourceType;
  if (dst && IPTC_AI_SOURCE_RE.test(dst)) {
    signals.push({
      id: 'sig_iptc_aigc',
      layer: 'aigc-meta',
      strength: 'strong',
      direction: 'supports-fake',
      text: `IPTC DigitalSourceType 字段明确声明该图为生成式 AI 合成媒体（${dst}）。`,
    });
  }

  // ---------- 2. EXIF 软件与相机信息 ----------
  if (inv.exif?.present) {
    const software = inv.exif.software || '';
    if (software && AIGC_SOFTWARE_RE.test(software)) {
      signals.push({
        id: 'sig_exif_ai_sw',
        layer: 'exif',
        strength: 'strong',
        direction: 'supports-fake',
        text: `元数据 Software/CreatorTool 字段标记为 AI 工具：${software}。`,
      });
    } else if (software && EDIT_SOFTWARE_RE.test(software)) {
      signals.push({
        id: 'sig_exif_edit_sw',
        layer: 'exif',
        strength: 'strong',
        direction: 'supports-fake',
        text: `元数据显示该图曾由图像编辑软件（${software}）导出保存，存在后期处理或合成可能。`,
      });
    } else if (inv.exif.make && inv.exif.model) {
      signals.push({
        id: 'sig_exif_camera',
        layer: 'exif',
        strength: 'weak',
        direction: 'supports-authentic',
        text: `包含相机拍摄元数据（${inv.exif.make} ${inv.exif.model}，拍摄时间 ${
          inv.exif.dateTimeOriginal || '未记录'
        }）。注意：EXIF 可被伪造，需结合反搜交叉核实。`,
      });
    } else {
      // 有元数据但不含相机信息：属于「有数据但无指向性」，不得让信号列表为空
      signals.push({
        id: 'sig_exif_neutral',
        layer: 'exif',
        strength: 'unknown',
        direction: 'neutral',
        text: inv.exif.software
          ? `图片含 ${inv.exif.rawTagCount} 项元数据标签，但未包含可识别的相机机型信息。`
          : `图片含 ${inv.exif.rawTagCount} 项元数据标签（无相机机型、无 AI/编辑软件标记），不构成任何倾向性判断。`,
      });
    }
  } else {
    signals.push({
      id: 'sig_exif_absent',
      layer: 'exif',
      strength: 'unknown',
      direction: 'neutral',
      text: '当前图片不含 EXIF 元数据。社交平台（微信/微博/小红书/X）转存默认清空 EXIF，缺失元数据不构成造假证据。',
    });
  }

  // ---------- 3. C2PA 内容凭证信号 ----------
  if (inv.c2pa?.status === 'verified-valid') {
    if (inv.c2pa.isAiGenerated) {
      signals.push({
        id: 'sig_c2pa_ai',
        layer: 'c2pa',
        strength: 'strong',
        direction: 'supports-fake',
        text: `C2PA 加密签名验证通过，签发方（${inv.c2pa.signer || '未知'}）声明该图由 AI 工具（${
          inv.c2pa.claimGenerator || '未知'
        }）生成。`,
      });
    } else {
      signals.push({
        id: 'sig_c2pa_camera',
        layer: 'c2pa',
        strength: 'strong',
        direction: 'supports-authentic',
        text: `C2PA 内容凭证签名有效（签发方：${inv.c2pa.signer || '未知'}），未发现签名后篡改。`,
      });
    }
  } else if (inv.c2pa?.status === 'verified-invalid') {
    signals.push({
      id: 'sig_c2pa_tampered',
      layer: 'c2pa',
      strength: 'strong',
      direction: 'supports-fake',
      text: '检测到 C2PA 内容凭证，但哈希校验失败，说明图片在签发后曾被二次修改。',
      detail: (inv.c2pa.validationErrors || []).join('；'),
    });
  } else if (inv.c2pa?.status === 'present-unverified') {
    signals.push({
      id: 'sig_c2pa_present',
      layer: 'c2pa',
      strength: 'unknown',
      direction: 'neutral',
      text: '检测到 C2PA 凭证容器但未完成验签，请在下方点击「验签」按钮确认签名有效性。',
    });
  }

  // ---------- 4. 反向搜图人工补录的最早出处信号 ----------
  for (const eng of inv.engines || []) {
    if (eng.earliestSeenUrl && eng.earliestSeenDate) {
      signals.push({
        id: `sig_rev_${eng.id}`,
        layer: 'reverse',
        strength: 'strong',
        direction: 'supports-fake',
        text: `通过 ${eng.name} 检索到该图早在 ${eng.earliestSeenDate} 已出现在公开网页（${
          eng.earliestSeenContext || '早期记录'
        }）。`,
        sourceUrl: eng.earliestSeenUrl,
      });
    }
  }

  // ---------- 5. Wayback 时间线信号 ----------
  if (inv.timeline?.image?.firstSeen) {
    signals.push({
      id: 'sig_wb_image',
      layer: 'timeline',
      strength: 'weak',
      direction: 'neutral',
      text: `Wayback Machine 首次收录该图片 URL 的时间为 ${String(inv.timeline.image.firstSeen).slice(0, 10)}。`,
      sourceUrl: inv.timeline.image.snapshotUrl,
    });
  }
  if (inv.timeline?.page?.firstSeen) {
    signals.push({
      id: 'sig_wb_page',
      layer: 'timeline',
      strength: 'weak',
      direction: 'neutral',
      text: `Wayback Machine 首次收录该来源页面的时间为 ${String(inv.timeline.page.firstSeen).slice(0, 10)}。`,
      sourceUrl: inv.timeline.page.snapshotUrl,
    });
  }

  // ---------- 6. 像素级 AI 检测服务（仅弱信号） ----------
  for (const det of inv.detection || []) {
    if (typeof det.aiScore === 'number') {
      signals.push({
        id: `sig_det_${det.provider}`,
        layer: 'detect',
        strength: 'weak',
        direction: det.aiScore >= 0.7 ? 'supports-fake' : 'neutral',
        text: `像素级检测（${det.provider}）给出 AI 生成概率 ${(det.aiScore * 100).toFixed(
          0
        )}%（存在 5%–15% 误报率，仅作辅助参考）。`,
      });
    }
  }

  // ---------- 硬性定性规则 ----------
  const strong = signals.filter((s) => s.strength === 'strong');
  const strongIds = new Set(strong.map((s) => s.id));

  let suggestion = VERDICTS.UNDETERMINED;
  if (strong.some((s) => s.layer === 'reverse')) {
    suggestion = VERDICTS.OLD_REUSE;
  } else if (strong.some((s) => s.layer === 'aigc-meta') || strongIds.has('sig_c2pa_ai') || strongIds.has('sig_exif_ai_sw')) {
    suggestion = VERDICTS.AI;
  } else if (strongIds.has('sig_exif_edit_sw') || strongIds.has('sig_c2pa_tampered')) {
    suggestion = VERDICTS.MANIPULATED;
  } else if (strongIds.has('sig_c2pa_camera')) {
    suggestion = VERDICTS.AUTHENTIC;
  }

  return { signals, suggestion };
}

/** 是否允许启用「一键生成辟谣图文」快捷模板（无强信号时锁定） */
export function canUseQuickTemplates(inv) {
  const strong = (inv.signals || []).filter((s) => s.strength === 'strong');
  return strong.length > 0;
}
