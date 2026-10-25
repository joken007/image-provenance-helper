// background/metadata.js —— EXIF/IPTC/XMP 标准元数据 + PNG 文本块 AIGC 确定性扫描
//
// 两层取证：
//  A) 标准元数据（exifr）：设备、拍摄时间、编辑软件、IPTC AI 标准标记 DigitalSourceType
//  B) PNG tEXt / iTXt 块（零依赖手写扫描器）：直接读出 SD / ComfyUI / NovelAI 的生成参数
//     —— 命中即为 100% 确定性证据，不依赖任何联网 AI 检测。

import exifr from '../vendor/exifr.full.esm.mjs';
import { base64ToUint8 } from '../lib/utils.js';

/** AI 生成器签名（软件名 / 平台名） */
export const AIGC_SOFTWARE_RE =
  /midjourney|stable\s*diffusion|comfyui|novelai|dall[·\-]?e|firefly|imagen|synthid|\bflux\b|即梦|豆包|可灵|通义万相|wanx|qwen[- ]?image|seedream/i;

/** 图像编辑软件签名（后期篡改线索） */
export const EDIT_SOFTWARE_RE =
  /photoshop|lightroom|gimp|snapseed|meitu|美图|醒图|affinity|pixelmator|canva|paintshop|krita|figma/i;

/** IPTC 数字来源类型中的 AI 标记 */
export const IPTC_AI_SOURCE_RE =
  /trainedAlgorithmicMedia|compositeWithTrainedAlgorithmicMedia|compositeSynthetic/i;

/**
 * 解析图片元数据
 * @param {string|null} bytesBase64 图片字节的 base64；为 null 表示截图兜底，无原始元数据
 */
export async function readMetadata(bytesBase64) {
  if (!bytesBase64) {
    return {
      present: false,
      rawTagCount: 0,
      aigcChunk: { detected: false },
      error: '截图兜底模式，原始文件元数据不可用',
    };
  }

  let uint8;
  try {
    uint8 = base64ToUint8(bytesBase64);
  } catch (e) {
    return { present: false, rawTagCount: 0, aigcChunk: { detected: false }, error: `字节解码失败：${e?.message || e}` };
  }

  // 1) PNG 文本块扫描（精准捕获 SD / ComfyUI / NovelAI 原始生成信息）
  const aigcChunk = scanPngTextChunks(uint8);

  // 2) 标准 EXIF / IPTC / XMP 解析
  try {
    const data = await exifr.parse(uint8.buffer, {
      tiff: true,
      ifd0: true,
      exif: true,
      gps: true,
      iptc: true,
      xmp: true,
      icc: false,
      jfif: false,
      translateKeys: true,
      translateValues: true,
      reviveValues: true,
      mergeOutput: true,
    });

    if (!data && !aigcChunk.detected) {
      return { present: false, rawTagCount: 0, aigcChunk };
    }

    const d = data || {};
    const software =
      [d.Software, d.ProcessingSoftware, d.CreatorTool].filter(Boolean).join(' / ') || undefined;

    // IPTC DigitalSourceType 可能出现在多个位置（XMP 命名空间 / IPTC 段）
    const digitalSourceType =
      d.DigitalSourceType ||
      d.digitalSourceType ||
      d.digitalSourceTypeCi ||
      (d.XMP?.digitalSourceType ? String(d.XMP.digitalSourceType) : undefined);

    const hasGps = typeof d.latitude === 'number' && typeof d.longitude === 'number';

    return {
      present: Boolean(data),
      make: d.Make,
      model: d.Model,
      lens: d.LensModel || d.LensInfo || d.Lens,
      dateTimeOriginal: toIso(d.DateTimeOriginal || d.CreateDate || d.ModifyDate),
      software,
      creatorTool: d.CreatorTool,
      digitalSourceType: digitalSourceType ? String(digitalSourceType) : undefined,
      // 隐私脱敏：只保留小数点后 1 位（约 11 公里范围），不暴露精确到门的坐标
      gpsApprox: hasGps ? `${d.latitude.toFixed(1)}, ${d.longitude.toFixed(1)}` : undefined,
      iptc: {
        byline: d.By_line || d.Creator,
        copyright: d.Copyright || d.Rights,
        caption: d.Caption || d.Description || d.UserComment,
      },
      aigcChunk,
      rawTagCount: Object.keys(d).length,
    };
  } catch (e) {
    return {
      present: false,
      rawTagCount: 0,
      aigcChunk,
      error: `元数据解析失败：${e?.message || e}`,
    };
  }
}

/**
 * 解析 PNG 文件中的 tEXt 与 iTXt 块（无第三方依赖）
 *
 * PNG 结构：8 字节魔数 + 若干 chunk，每个 chunk = 4 字节长度 + 4 字节类型 + 数据 + 4 字节 CRC
 * tEXt: keyword \0 text（Latin-1）
 * iTXt: keyword \0 compressionFlag compressionMethod languageTag \0 translatedKeyword \0 text（UTF-8）
 */
export function scanPngTextChunks(bytes) {
  // PNG 8 字节魔数：89 50 4E 47 0D 0A 1A 0A
  if (
    !bytes ||
    bytes.length < 32 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    bytes[4] !== 0x0d ||
    bytes[5] !== 0x0a ||
    bytes[6] !== 0x1a ||
    bytes[7] !== 0x0a
  ) {
    return { detected: false };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let offset = 8;

  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset, false);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7]
    );
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (length > bytes.length || dataEnd > bytes.length) break;

    if (type === 'tEXt' || type === 'iTXt') {
      const rawText = decoder.decode(
        bytes.subarray(dataStart, Math.min(dataEnd, dataStart + 8192))
      );
      const parsed = splitTextChunk(rawText, type);
      const key = parsed.key;
      const val = parsed.value.trim();

      if (key === 'parameters' && /Steps:\s*\d+/i.test(val)) {
        return {
          detected: true,
          generator: 'stable-diffusion',
          rawKey: 'parameters',
          promptSnippet: extractSdPrompt(val),
          rawValue: val.slice(0, 600),
        };
      }
      if ((key === 'prompt' || key === 'workflow') && /class_type|"nodes"\s*:/.test(val)) {
        return {
          detected: true,
          generator: 'comfyui',
          rawKey: key,
          promptSnippet: val.slice(0, 240),
          rawValue: val.slice(0, 600),
        };
      }
      if (key === 'Software' && /NovelAI/i.test(val)) {
        return {
          detected: true,
          generator: 'novelai',
          rawKey: 'Software',
          promptSnippet: val.slice(0, 240),
          rawValue: val.slice(0, 600),
        };
      }
      if (AIGC_SOFTWARE_RE.test(rawText)) {
        return {
          detected: true,
          generator: 'other',
          rawKey: key || type,
          promptSnippet: val.slice(0, 240),
          rawValue: val.slice(0, 600),
        };
      }
    }

    if (type === 'IEND') break;
    offset = dataEnd + 4; // 跳过 4 字节 CRC
  }
  return { detected: false };
}

/** 从 tEXt/iTXt 原始文本里切出 keyword 与 value */
function splitTextChunk(rawText, type) {
  const sep = rawText.indexOf('\0');
  if (sep < 0) return { key: '', value: '' };
  const key = rawText.slice(0, sep);
  if (type === 'tEXt') {
    return { key, value: rawText.slice(sep + 1) };
  }
  // iTXt: key \0 flag method lang \0 translated \0 text
  const rest = rawText.slice(sep + 1);
  // flag(1) + method(1)
  let i = 2;
  // language tag（以 \0 结尾）
  const langEnd = rest.indexOf('\0', i);
  if (langEnd < 0) return { key, value: '' };
  i = langEnd + 1;
  // translated keyword（以 \0 结尾）
  const transEnd = rest.indexOf('\0', i);
  if (transEnd < 0) return { key, value: '' };
  return { key, value: rest.slice(transEnd + 1) };
}

/** 从 SD 的 parameters 串里抽出正向 prompt（第一段） */
function extractSdPrompt(val) {
  const m = val.match(/Prompt:\s*([\s\S]*?)(?:\nNegative prompt:|$)/i);
  if (m) return m[1].trim().slice(0, 240);
  return val.slice(0, 240);
}

/** 把 Date 对象 / EXIF 字符串统一成 ISO 串 */
function toIso(v) {
  if (!v) return undefined;
  if (v instanceof Date) return isNaN(v.getTime()) ? undefined : v.toISOString();
  // EXIF 原生格式：2024:01:02 15:04:05
  const m = String(v).match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (m) {
    const d = new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6])
    );
    return isNaN(d.getTime()) ? String(v) : d.toISOString();
  }
  const d = new Date(v);
  return isNaN(d.getTime()) ? String(v) : d.toISOString();
}
