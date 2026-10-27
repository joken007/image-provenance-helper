// sidepanel/panel.js —— 侧栏工作台主逻辑
//
// 职责：
//  * 通过 chrome.storage.session.onChanged 实时渲染证据卡（零消息丢失）
//  * 三道人工闸门：闸门 A 核对画面事实 → 闸门 B 逐句编辑文案 → 闸门 C 预览导出
//  * 剪贴板写入、引擎手动打开、C2PA 验签触发、Canvas 实时预览
//
// 注意：图片原始字节只在 IndexedDB 里，本文件不碰 chrome.storage 的图片数据。

import { ENGINES, VERDICT_LABEL, VERDICTS, C2PA_VERIFY_PAGE, TEXT_VERDICT_LABEL } from '../lib/constants.js';
import { getImageBlob } from '../lib/idb-blob-cache.js';
import { verifyC2pa } from './c2pa-verifier.js';
import { renderFactCheckCard, downloadCanvas } from './card-renderer.js';

const $ = (id) => document.getElementById(id);

const state = {
  inv: null,
  options: null,
  coverBlob: null,
  factEdits: null, // 闸门 A 的人工修正
  draftEdits: null, // 闸门 B 的人工编辑
};

// ---------- 初始化 ----------

document.addEventListener('DOMContentLoaded', async () => {
  bindStaticEvents();
  await loadOptions();

  const res = await send({ type: 'inv:get-current' });
  if (res?.inv) {
    state.inv = res.inv;
    render();
  } else {
    showEmpty();
  }

  // 实时同步：Service Worker 每更新一次 storage.session 就重绘
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session') return;
    for (const [key, change] of Object.entries(changes)) {
      if (key.startsWith('session:inv:') && change.newValue) {
        state.inv = change.newValue;
        render();
      }
    }
  });

  // 引擎状态变化（验证码探测）时刷新
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'engines:updated') {
      send({ type: 'inv:get-current' }).then((r) => {
        if (r?.inv) {
          state.inv = r.inv;
          render();
        }
      });
    }
  });
});

async function loadOptions() {
  const res = await send({ type: 'inv:get-options' });
  state.options = res?.options || {};
}

// ---------- 渲染 ----------

function showEmpty() {
  $('empty-state').classList.remove('hidden');
  $('loading-state').classList.add('hidden');
  $('result-state').classList.add('hidden');
}

function render() {
  const inv = state.inv;
  if (!inv) {
    showEmpty();
    return;
  }

  if (inv.status === 'collecting') {
    $('empty-state').classList.add('hidden');
    $('result-state').classList.add('hidden');
    $('loading-state').classList.remove('hidden');
    renderLoading(inv);
    return;
  }

  $('empty-state').classList.add('hidden');
  $('loading-state').classList.add('hidden');
  $('result-state').classList.remove('hidden');

  // 纯文本会话不显示图像链路的卡片（那些卡片在没有图片时全是无关空信息）
  $('image-flow').classList.toggle('hidden', inv.kind === 'text');

  renderTextCheck(inv);
  renderVerdict(inv);
  renderImage(inv);
  renderEngines(inv);
  renderExif(inv);
  renderC2pa(inv);
  renderTimeline(inv);
  renderSignals(inv);
  renderManual(inv);
  renderArticle(inv);
  loadHistory();
}

function renderLoading(inv) {
  const steps = [
    { key: 'image', label: '抓取原图与还原大图地址', done: Boolean(inv.image?.sha256) },
    { key: 'meta', label: '解析 EXIF 与 PNG 生成参数', done: inv.status === 'ready' },
    { key: 'c2pa', label: '扫描并验签 C2PA 内容凭证', done: inv.status === 'ready' },
    { key: 'timeline', label: '查询 Wayback 归档时间线', done: inv.status === 'ready' },
    { key: 'reverse', label: '自动反搜（后台进行，页面不可见）', done: false },
  ];
  $('loading-steps').innerHTML = steps
    .map((s) => `<li class="${s.done ? 'done' : 'doing'}">${s.label}</li>`)
    .join('');
}

// ---------- 文本事实核查渲染 ----------

/** 置信度文案 */
const CONF_LABEL = { high: '高', medium: '中', low: '低', none: '无' };
/** 置信度强弱序（用于取最弱一环） */
const CONF_ORDER = { high: 3, medium: 2, low: 1, none: 0 };
/** 证据立场文案 */
const STANCE_LABEL = { supports: '支持', refutes: '反驳', neutral: '背景' };

function renderTextCheck(inv) {
  const tc = inv.textCheck;
  const statusEl = $('text-status');

  if (!tc) {
    statusEl.textContent = '';
    $('text-empty').classList.remove('hidden');
    $('text-body').classList.add('hidden');
    return;
  }

  $('text-empty').classList.add('hidden');
  $('text-body').classList.remove('hidden');

  const statusText = { running: '核查中', done: '已完成', failed: '失败' }[tc.status] || tc.status || '';
  statusEl.textContent = tc.note ? `${statusText} · ${tc.note}` : statusText;

  if (tc.status === 'running') {
    $('text-verdict-box').innerHTML =
      `<div class="text-progress"><span class="spin-dot"></span>${escapeHtml(tc.note || '正在核查…')}</div>`;
    $('text-process-box').innerHTML = '';
    $('text-claims-box').innerHTML = '';
    $('text-sources-box').innerHTML = '';
    $('text-blocked').classList.add('hidden');
    return;
  }

  if (tc.status === 'failed') {
    $('text-verdict-box').innerHTML = `<div class="text-error">${escapeHtml(tc.note || '核查失败')}</div>`;
    $('text-process-box').innerHTML = '';
    $('text-claims-box').innerHTML = '';
    $('text-sources-box').innerHTML = '';
    $('text-blocked').classList.add('hidden');
    return;
  }

  renderTextVerdict(tc);
  renderTextProcess(tc);
  renderTextClaims(tc);
  renderTextSources(tc);
}

function renderTextVerdict(tc) {
  const results = tc.results || [];
  const report = tc.report || {};
  const overall = tc.overallVerdict || report.verdict || 'unverifiable';
  const label = TEXT_VERDICT_LABEL[overall] || overall;

  // 总体置信度取「最弱一环」：只要有一条关键断言证据不足，整体就不能算高置信
  const decisive = results.filter((r) =>
    ['true', 'false', 'partial', 'misleading'].includes(r.verdict)
  );
  const conf = decisive.length ? weakestConfidence(decisive) : 'low';

  const sourceCount = (tc.sources || []).length;
  const groupCount = (tc.groups || []).length;

  $('text-verdict-box').innerHTML = `
    <div class="text-verdict">
      <div class="text-verdict-head">
        <span class="verdict-label">总体判定</span>
        <strong class="vt-${escapeHtml(overall)}">${escapeHtml(label)}</strong>
        <span class="conf-tag conf-${escapeHtml(conf)}">置信 ${escapeHtml(CONF_LABEL[conf] || conf)}</span>
      </div>
      <div class="text-verdict-meta">
        拆解 ${results.length} 条断言 · 命中 ${sourceCount} 条来源 · 归为 ${groupCount} 个独立来源组
      </div>
      ${report.headline ? `<div class="text-headline">${escapeHtml(report.headline)}</div>` : ''}
      ${report.summary ? `<div class="text-summary">${escapeHtml(report.summary)}</div>` : ''}
    </div>`;
}

function renderTextProcess(tc) {
  const report = tc.report || {};
  const src = tc.source || {};
  const results = tc.results || [];
  const steps = [];

  // 前四步是程序真实做过的事，不允许被模型改写
  steps.push(`抽取正文并拆解，识别出 ${results.length} 条可独立核查的断言`);
  if ((tc.queries || []).length) {
    steps.push(`使用 ${tc.queries.length} 组检索词联网取证：${tc.queries.join('、')}`);
  }
  steps.push(
    `命中 ${(tc.sources || []).length} 条来源，按主办方与原文文本比对归为 ${
      (tc.groups || []).length
    } 个独立来源组`
  );
  if (tc.factCheck?.available) {
    steps.push(`专业核查库：${tc.factCheck.note}`);
  }
  // 之后是模型写的叙述部分（已过 URL 白名单）
  for (const p of report.process || []) steps.push(p);

  $('text-process-box').innerHTML = `
    <div class="text-sub-head">核查过程</div>
    <ol class="text-process">${steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>
    ${
      src.text
        ? `<details class="text-source-detail"><summary>查看被核查的原文${
            src.platform ? `（${escapeHtml(src.platform)}）` : ''
          }</summary><div class="text-raw">${escapeHtml(src.text)}</div></details>`
        : ''
    }`;
}

function renderTextClaims(tc) {
  const results = tc.results || [];
  if (!results.length) {
    $('text-claims-box').innerHTML =
      '<p class="muted small">正文里没有识别到可独立核查的断言。</p>';
    return;
  }

  const items = results
    .map((r) => {
      const label = TEXT_VERDICT_LABEL[r.verdict] || r.verdict;
      const conf = r.confidence || 'low';
      const evidence = (r.evidence || [])
        .map(
          (e) => `<li>
            <span class="ev-quote">「${escapeHtml(e.quote || '')}」</span>
            <span class="ev-stance stance-${escapeHtml(e.stance || 'neutral')}">${escapeHtml(
              STANCE_LABEL[e.stance] || ''
            )}</span>
            <a class="link" target="_blank" rel="noreferrer noopener" href="${escapeHtml(e.url)}">来源 ↗</a>
          </li>`
        )
        .join('');

      return `<div class="text-claim">
        <div class="text-claim-head">
          <span class="verdict-tag vt-${escapeHtml(r.verdict)}">${escapeHtml(label)}</span>
          <span class="conf-tag conf-${escapeHtml(conf)}">置信 ${escapeHtml(CONF_LABEL[conf] || conf)}</span>
          ${r.forced ? '<span class="forced-tag">规则已校正</span>' : ''}
        </div>
        <div class="text-claim-body">${escapeHtml(r.claimText)}</div>
        <div class="text-claim-meta">${
          r.queries && r.queries.length ? `检索词：${escapeHtml(r.queries.join('、'))} · ` : ''
        }${escapeHtml(r.independenceNote || '')}</div>
        ${r.reasoning ? `<div class="text-claim-reason">${escapeHtml(r.reasoning)}</div>` : ''}
        ${
          evidence
            ? `<div class="text-evidence"><div class="text-sub-head">证据原文</div><ul class="text-ev-list">${evidence}</ul></div>`
            : ''
        }
        ${
          r.missing && r.missing.length
            ? `<div class="text-missing">缺失环节：${escapeHtml(r.missing.join('；'))}</div>`
            : ''
        }
      </div>`;
    })
    .join('');

  $('text-claims-box').innerHTML =
    `<div class="text-sub-head">逐条核查（${results.length} 条断言）</div>` + items;
}

function renderTextSources(tc) {
  const sources = tc.sources || [];
  const groups = tc.groups || [];
  const syndicated = groups.filter((g) => !g.independent);

  let html = `<div class="text-sub-head">检索到的来源（${sources.length} 条 / ${groups.length} 个独立来源组）</div>`;

  if (syndicated.length) {
    html += `<div class="text-syndication">识别出 ${syndicated.length} 组同源转载（不计为多个独立佐证）：${syndicated
      .map((g) => escapeHtml((g.hosts || []).join('、')))
      .join('；')}</div>`;
  }

  html += `<ul class="text-src-list">${sources
    .slice(0, 40)
    .map(
      (s) => `<li>
      <a class="link" target="_blank" rel="noreferrer noopener" href="${escapeHtml(s.url)}">${escapeHtml(
        s.title || s.url
      )}</a>
      ${s.snippet ? `<div class="text-src-snip">${escapeHtml(String(s.snippet).slice(0, 180))}</div>` : ''}
    </li>`
    )
    .join('')}</ul>`;

  if (tc.failures && tc.failures.length) {
    html += `<div class="text-failures">检索异常：${tc.failures
      .map((f) => escapeHtml(`${f.engine || ''}: ${f.error || ''}`))
      .join('；')}</div>`;
  }

  $('text-sources-box').innerHTML = html;

  const blocked = tc.blockedSources || [];
  if (blocked.length) {
    $('text-blocked').classList.remove('hidden');
    $('text-blocked').innerHTML =
      `<b>已剥离 ${blocked.length} 条不在本次检索结果中的链接（疑似模型幻觉）：</b><br>` +
      blocked.map((u) => escapeHtml(u)).join('<br>');
  } else {
    $('text-blocked').classList.add('hidden');
  }
}

/** 取一组断言里最弱的置信度 */
function weakestConfidence(list) {
  let weakest = 'high';
  for (const r of list) {
    const c = r.confidence || 'low';
    if ((CONF_ORDER[c] ?? 1) < (CONF_ORDER[weakest] ?? 1)) weakest = c;
  }
  return weakest;
}

function renderVerdict(inv) {
  const hasStrong = (inv.signals || []).some((s) => s.strength === 'strong');
  const suggestion = inv.manual?.verdict || inv.systemSuggestion || VERDICTS.UNDETERMINED;
  $('verdict-text').textContent = VERDICT_LABEL[suggestion] || '无法判断';

  const banner = $('verdict-banner');
  banner.classList.toggle('locked', !hasStrong && !inv.manual?.verdict);

  const reason = !hasStrong && !inv.manual?.verdict
    ? '未检出任何确定性证据，系统倾向强制锁定为「无法判断」。旧图挪用 / AI 生成 快捷模板已锁定，需人工显式录入强证据并附说明。'
    : `确定性证据 ${(inv.signals || []).filter((s) => s.strength === 'strong').length} 条，倾向性线索 ${
        (inv.signals || []).filter((s) => s.strength === 'weak').length
      } 条。最终定性始终由人工裁定。`;
  $('verdict-reason').textContent = reason;
}

function renderImage(inv) {
  const img = inv.image || {};
  $('image-dims').textContent = img.width && img.height ? `${img.width} × ${img.height} · ${img.mime}` : img.mime || '';
  $('image-site').textContent = `${img.pageSite || ''} — ${img.pageTitle || ''}`;
  const link = $('image-link');
  if (img.normalizedUrl || img.originalUrl) {
    link.href = img.normalizedUrl || img.originalUrl;
    link.classList.remove('hidden');
  } else {
    link.classList.add('hidden');
  }
  $('image-notes').textContent = img.notes || '';
  $('cdn-note').textContent = img.cdnNote || '';
  $('cdn-note').classList.toggle('hidden', !img.cdnNote);

  // 防盗链提示
  // 全自动模式下不再需要「复制到剪贴板 + Ctrl+V」——
  // 图片字节直接由后台注入引擎的上传框，防盗链图片同样能全自动检索。
  // 剪贴板横幅默认隐藏，仅在用户主动点「复制原图」后才出现确认提示。
  $('clipboard-banner').classList.add('hidden');

  // 缩略图
  if (img.sha256) {
    getImageBlob(img.sha256)
      .then((blob) => {
        if (blob) {
          state.coverBlob = blob;
          $('thumb').src = URL.createObjectURL(blob);
        }
      })
      .catch(() => {});
  }
}

function renderEngines(inv) {
  const list = inv.engines || [];
  const av = inv.autoVerify || {};
  const done = list.filter((e) => e.autoStatus === 'ok').length;
  const running = list.filter((e) => e.autoStatus === 'running' || e.autoStatus === 'queued').length;

  // 顶部状态条
  let banner = '';
  if (av.status === 'running' || running > 0) {
    banner = `<div class="auto-banner running"><span class="spin-dot"></span>正在后台自动检索（${
      done + (list.length - running)
    }/${list.length} 已结束）· 检索页面不可见，完成即自动关闭</div>`;
  } else if (av.status === 'done') {
    banner = `<div class="auto-banner done">✅ 自动检索已完成 · 所有临时页面均已关闭 · ${done} 个引擎返回结果</div>`;
  } else if (av.status === 'failed') {
    banner = `<div class="auto-banner failed">自动检索失败：${escapeHtml(av.note || '')}</div>`;
  }

  $('engine-mode').textContent = av.status === 'done' ? '全自动完成' : '全自动进行中';

  // Wayback 反查结果（自动补充时间锚点）
  const ap = inv.archiveProbe;
  let archiveLine = '';
  if (ap?.earliestFirstSeen) {
    archiveLine = `<div class="archive-probe">
      <span class="ap-label">时间锚点</span>
      命中站点最早被 Wayback 收录于 <b>${escapeHtml(ap.earliestFirstSeen)}</b>
      （已核 ${ap.checked} 个来源，命中 ${ap.hits} 个）
      ${
        ap.snapshotUrl
          ? `· <a class="link" target="_blank" rel="noreferrer noopener" href="${escapeHtml(ap.snapshotUrl)}">查看快照 ↗</a>`
          : ''
      }
    </div>`;
  } else if (ap && ap.checked > 0) {
    archiveLine = `<div class="archive-probe muted">已对 ${ap.checked} 个命中来源反查 Wayback，均未被收录（时间线无法自动确认）</div>`;
  }

  $('engine-list').innerHTML =
    banner +
    archiveLine +
    list
      .map((e) => {
        const st = e.autoStatus || 'queued';
        const statusText =
          {
            ok: '已命中',
            blocked: '需验证码',
            timeout: '超时',
            failed: '失败',
            queued: '排队中',
            running: '检索中',
            skipped: '已跳过',
          }[st] || st;

        const hosts = e.distinctHosts || [];
        const meta = [];
        if (e.matchCount) meta.push(`命中 ${e.matchCount} 条`);
        if (hosts.length) meta.push(`${hosts.length} 个站点`);
        if (e.earliestSeenDate) meta.push(`最早 ${e.earliestSeenDate}`);
        if (e.durationMs) meta.push(`${(e.durationMs / 1000).toFixed(1)}s`);

        return `
      <div class="engine" data-engine="${e.id}">
        <div class="engine-top">
          <span class="engine-name">${escapeHtml(e.name)}</span>
          <span class="badge auto-${st}">${statusText}</span>
        </div>
        ${meta.length ? `<div class="engine-metrics">${meta.map((m) => `<span>${escapeHtml(m)}</span>`).join('')}</div>` : ''}
        ${e.autoNote ? `<div class="engine-note">${escapeHtml(e.autoNote)}</div>` : ''}
        ${
          hosts.length
            ? `<div class="engine-hosts">${hosts
                .slice(0, 6)
                .map((h) => `<span class="host-chip">${escapeHtml(h)}</span>`)
                .join('')}${hosts.length > 6 ? `<span class="muted small">+${hosts.length - 6}</span>` : ''}</div>`
            : ''
        }
        ${
          e.earliestSeenUrl
            ? `<div class="engine-early-link"><a class="link" target="_blank" rel="noreferrer noopener" href="${escapeHtml(
                e.earliestSeenUrl
              )}">最早线索 ↗</a></div>`
            : ''
        }
        ${
          st === 'blocked' || st === 'timeout' || st === 'failed'
            ? `<div class="row"><button class="ghost-btn" data-act="open-engine" data-engine="${e.id}">手动打开一次</button></div>`
            : ''
        }
        <details class="manual-fix">
          <summary>手动修正（可选）</summary>
          <div class="engine-early">
            <input type="date" placeholder="最早出现日期" data-field="earliestSeenDate" data-engine="${e.id}" value="${escapeHtml(
          e.earliestSeenDate || ''
        )}" />
            <input type="url" placeholder="最早出处链接" data-field="earliestSeenUrl" data-engine="${e.id}" value="${escapeHtml(
          e.earliestSeenUrl || ''
        )}" />
            <input type="text" placeholder="出处语境简述" data-field="earliestSeenContext" data-engine="${e.id}" value="${escapeHtml(
          e.earliestSeenContext || ''
        )}" />
          </div>
        </details>
      </div>`;
      })
      .join('');
}

function renderExif(inv) {
  const ex = inv.exif || {};
  const rows = [];
  const add = (k, v) => {
    if (v !== undefined && v !== null && v !== '') rows.push({ k, v });
  };

  add('设备', [ex.make, ex.model].filter(Boolean).join(' ') || undefined);
  add('镜头', ex.lens);
  add('拍摄时间', ex.dateTimeOriginal ? formatDate(ex.dateTimeOriginal) : undefined);
  add('编辑软件', ex.software);
  add('生成工具', ex.creatorTool);
  add('IPTC 来源', ex.digitalSourceType);
  add('GPS（粗略）', ex.gpsApprox);
  add('作者', ex.iptc?.byline);
  add('版权', ex.iptc?.copyright);
  add('图片说明', ex.iptc?.caption);

  if (ex.aigcChunk?.detected) {
    rows.unshift({
      k: 'AIGC 参数',
      v: `<b>命中 ${escapeHtml(ex.aigcChunk.generator)} 生成参数（键名 ${escapeHtml(
        ex.aigcChunk.rawKey
      )}）</b><br><span class="muted small">${escapeHtml(
        (ex.aigcChunk.promptSnippet || '').slice(0, 220)
      )}</span>`,
    });
  }

  if (!rows.length) {
    rows.push({
      k: '状态',
      v: escapeHtml(
        ex.error ||
          '不含 EXIF 元数据。社交平台转存默认清空 EXIF，缺失元数据不构成造假证据。'
      ),
    });
  }

  $('exif-list').innerHTML = rows
    .map((r) => `<div class="kv"><span class="kv-k">${escapeHtml(r.k)}</span><span class="kv-v">${r.v}</span></div>`)
    .join('');
}

function renderC2pa(inv) {
  const c = inv.c2pa || {};
  const rows = [];
  const statusText = {
    absent: '无内容凭证',
    'present-unverified': '检测到容器，未验签',
    'verified-valid': '签名验证通过',
    'verified-invalid': '签名校验失败',
    error: '验签出错',
  }[c.status] || c.status;

  rows.push({ k: '状态', v: `<b>${escapeHtml(statusText)}</b>` });
  if (c.signer) rows.push({ k: '签发机构', v: escapeHtml(c.signer) });
  if (c.claimGenerator) rows.push({ k: '生成工具', v: escapeHtml(c.claimGenerator) });
  if (typeof c.isAiGenerated === 'boolean') {
    rows.push({ k: 'AI 声明', v: c.isAiGenerated ? '凭证声明为 AI 生成' : '凭证未声明为 AI 生成' });
  }
  if (c.actions?.length) rows.push({ k: '操作历史', v: escapeHtml(c.actions.join('；')) });
  if (c.validationErrors?.length) {
    rows.push({ k: '验签错误', v: escapeHtml(c.validationErrors.join('；')) });
  }
  rows.push({ k: '说明', v: escapeHtml(c.note || '') });

  $('c2pa-box').innerHTML = rows
    .map((r) => `<div class="kv"><span class="kv-k">${escapeHtml(r.k)}</span><span class="kv-v">${r.v}</span></div>`)
    .join('');

  $('btn-c2pa-online').href = C2PA_VERIFY_PAGE;
  $('btn-verify-c2pa').disabled = !state.inv?.image?.sha256;
}

function renderTimeline(inv) {
  const t = inv.timeline || {};
  const rows = [];
  const fmt = (entry, label) => {
    if (!entry) return;
    if (entry.firstSeen) {
      rows.push({
        k: label,
        v: `${escapeHtml(String(entry.firstSeen).slice(0, 10))} · <a class="link" target="_blank" rel="noreferrer noopener" href="${escapeHtml(
          entry.snapshotUrl || '#'
        )}">查看快照 ↗</a>`,
      });
    } else if (entry.error) {
      rows.push({ k: label, v: `<span class="muted">${escapeHtml(entry.error)}</span>` });
    }
  };
  fmt(t.image, '图片首次收录');
  fmt(t.page, '页面首次收录');
  if (!rows.length) rows.push({ k: '状态', v: '<span class="muted">尚未查询</span>' });

  $('timeline-box').innerHTML = rows
    .map((r) => `<div class="kv"><span class="kv-k">${escapeHtml(r.k)}</span><span class="kv-v">${r.v}</span></div>`)
    .join('');
}

function renderSignals(inv) {
  const signals = inv.signals || [];
  const strong = signals.filter((s) => s.strength === 'strong').length;
  $('signal-count').textContent = `确定性 ${strong} 条 · 倾向性 ${
    signals.filter((s) => s.strength === 'weak').length
  } 条 · 未知 ${signals.filter((s) => s.strength === 'unknown').length} 条`;

  const strengthLabel = { strong: '确定性证据', weak: '倾向性线索', unknown: '未知' };
  const dirLabel = {
    'supports-fake': '指向存疑',
    'supports-authentic': '指向可信',
    neutral: '中性',
  };

  $('signal-list').innerHTML = signals.length
    ? signals
        .map(
          (s) => `
      <div class="signal ${s.strength}">
        <div class="signal-head">
          <span class="strength-tag">${strengthLabel[s.strength] || s.strength}</span>
          <span class="muted small">${dirLabel[s.direction] || ''}</span>
        </div>
        <div>${escapeHtml(s.text)}</div>
        ${s.detail ? `<div class="signal-detail">${escapeHtml(s.detail)}</div>` : ''}
        ${
          s.sourceUrl
            ? `<div class="signal-detail"><a class="link" target="_blank" rel="noreferrer noopener" href="${escapeHtml(
                s.sourceUrl
              )}">来源链接 ↗</a></div>`
            : ''
        }
      </div>`
        )
        .join('')
    : '<p class="muted">暂无信号。</p>';
}

function renderManual(inv) {
  const manual = inv.manual || {};
  if (document.activeElement !== $('claim-text')) $('claim-text').value = manual.claimText || '';
  if (document.activeElement !== $('manual-notes')) $('manual-notes').value = manual.notes || '';

  const chips = [
    { v: VERDICTS.OLD_REUSE, label: VERDICT_LABEL['likely-old-reuse'] },
    { v: VERDICTS.AI, label: VERDICT_LABEL['likely-ai'] },
    { v: VERDICTS.MANIPULATED, label: VERDICT_LABEL.manipulated },
    { v: VERDICTS.AUTHENTIC, label: VERDICT_LABEL['no-anomaly'] },
    { v: VERDICTS.UNDETERMINED, label: VERDICT_LABEL.undetermined },
  ];
  $('verdict-options').innerHTML = chips
    .map(
      (c) =>
        `<button class="verdict-chip ${manual.verdict === c.v ? 'active' : ''}" data-verdict="${c.v}">${escapeHtml(
          c.label
        )}</button>`
    )
    .join('');
}

function renderArticle(inv) {
  const art = inv.article || {};

  // 闸门 A：画面事实
  const facts = art.facts;
  if (facts) {
    const merged = { ...facts, ...(state.factEdits || {}) };
    $('facts-box').innerHTML = `
      ${factInput('scene', '场景', merged.scene)}
      ${factInput('objects', '物体（逗号分隔）', (merged.objects || []).join('、'))}
      ${factInput('visibleText', '画面文字（逗号分隔）', (merged.visibleText || []).join(' / '))}
      ${factInput('counts', '计数（逗号分隔）', (merged.counts || []).join('、'))}
      ${factInput('watermark', '水印', merged.watermark)}
      ${factInput('imageQuality', '形态', merged.imageQuality)}
      ${factInput('anomalies', '可见异常（逗号分隔）', (merged.anomalies || []).join('、'))}
      ${factInput('unknowns', '未知项（逗号分隔）', (merged.unknowns || []).join('、'))}
      <div class="muted small" style="margin-top:6px">可直接修改以上内容，确认后再进入闸门 B。</div>`;
  }

  $('btn-confirm-facts').disabled = !facts;
  $('btn-confirm-facts').textContent = art.factsConfirmed ? '✓ 事实已确认' : '确认事实无误';
  $('btn-extract-facts').disabled = Boolean(facts) && art.factsConfirmed;

  // 闸门 B：文案
  const draft = art.draft;
  const draftReady = Boolean(draft) && Boolean(art.factsConfirmed);
  $('btn-generate-draft').disabled = !draftReady;
  $('btn-confirm-draft').disabled = !draftReady;
  $('btn-confirm-draft').textContent = art.draftConfirmed ? '✓ 文案已确认' : '确认文案';

  if (draft) {
    const merged = { ...draft, ...(state.draftEdits || {}) };
    $('draft-box').innerHTML = `
      ${draftInput('headline', '大标题', merged.headline)}
      ${draftInput('subhead', '副标题', merged.subhead)}
      ${draftInput('claim', '网传说法', merged.claim)}
      ${draftInput('conclusion', '核查结论', merged.conclusion)}
      ${draftInput('basis', '判定依据', merged.basis)}
      ${draftTextarea('evidence', '核心证据链（每行一条）', (merged.evidence || []).join('\n'))}
      ${draftTextarea('sources', '可核验来源（每行：名称|URL）', (merged.sources || [])
        .map((s) => `${s.label}|${s.url}`)
        .join('\n'))}
      ${draftInput('disclaimer', '免责声明', merged.disclaimer)}
      <div class="muted small">核查时间：${escapeHtml(merged.checkedAt || '')}</div>`;
  }

  // 被白名单拦截的链接
  const blocked = art.blockedSources || [];
  if (blocked.length) {
    $('blocked-sources').classList.remove('hidden');
    $('blocked-sources').innerHTML =
      `<b>已剥离 ${blocked.length} 条不在白名单中的链接（疑似模型幻觉）：</b><br>` +
      blocked.map((u) => escapeHtml(u)).join('<br>');
  } else {
    $('blocked-sources').classList.add('hidden');
  }

  // 闸门 C：预览
  const canRender = Boolean(draft) && Boolean(art.draftConfirmed);
  $('btn-render').disabled = !canRender;
  $('btn-download').disabled = !canRender;

  $('ai-status').textContent = art.factsConfirmed
    ? art.draftConfirmed
      ? '三道闸门均已通过，可导出'
      : '闸门 B 待确认'
    : '闸门 A 待确认';
}

// ---------- 事件绑定 ----------

function bindStaticEvents() {
  $('btn-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('btn-history').addEventListener('click', () => {
    $('history-card').scrollIntoView({ behavior: 'smooth' });
  });

  $('btn-drop').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', (e) => handleManualDrop(e.target.files?.[0]));

  $('btn-text-check').addEventListener('click', async () => {
    const btn = $('btn-text-check');
    btn.disabled = true;
    btn.textContent = '核查中…';
    try {
      const res = await send({ type: 'text:check-active-tab' });
      if (res?.ok === false) {
        setTip('export-tip', res?.error || '无法发起文本核查');
      }
    } catch (e) {
      setTip('export-tip', `发起失败：${e?.message || e}`);
    } finally {
      // 核查在后台跑，按钮先恢复；进度由 storage.session 实时回写
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = '核查当前页面文本';
      }, 1500);
    }
  });

  $('btn-copy-clipboard').addEventListener('click', copyCurrentToClipboard);
  $('btn-verify-c2pa').addEventListener('click', runC2paVerification);

  $('btn-save-manual').addEventListener('click', saveManual);

  $('btn-extract-facts').addEventListener('click', extractFacts);
  $('btn-confirm-facts').addEventListener('click', confirmFacts);
  $('btn-generate-draft').addEventListener('click', generateDraft);
  $('btn-confirm-draft').addEventListener('click', confirmDraft);
  $('btn-render').addEventListener('click', renderCard);
  $('btn-download').addEventListener('click', exportCard);

  // 事件委托：引擎按钮与人工回填
  $('engine-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act="open-engine"]');
    if (btn) openEngine(btn.dataset.engine);
  });
  $('engine-list').addEventListener('change', async (e) => {
    const input = e.target.closest('[data-field]');
    if (!input) return;
    await saveEngineField(input.dataset.engine, input.dataset.field, input.value);
  });

  $('verdict-options').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-verdict]');
    if (!chip) return;
    document.querySelectorAll('.verdict-chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
  });

  // 闸门 A 事实字段编辑
  $('facts-box').addEventListener('input', (e) => {
    const t = e.target;
    if (!t.dataset.fact) return;
    state.factEdits = state.factEdits || {};
    if (FACT_ARRAY_FIELDS.has(t.dataset.fact)) {
      state.factEdits[t.dataset.fact] = t.value
        .split(/[、,，;；]/)
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      state.factEdits[t.dataset.fact] = t.value;
    }
  });

  // 闸门 B 文本编辑
  $('draft-box').addEventListener('input', (e) => {
    const t = e.target;
    if (!t.dataset.field) return;
    state.draftEdits = state.draftEdits || {};
    if (t.dataset.multiline) {
      state.draftEdits[t.dataset.field] = t.value
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      state.draftEdits[t.dataset.field] = t.value;
    }
  });
}

// ---------- 动作 ----------

async function copyCurrentToClipboard() {
  const inv = state.inv;
  if (!inv?.image?.sha256) return;
  const blob = await getImageBlob(inv.image.sha256);
  if (!blob) {
    setTip('export-tip', '图片字节不在缓存中，请重新发起核查');
    return;
  }
  try {
    const png = await normalizeToPng(blob);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    $('clipboard-banner').classList.remove('hidden');
    setTip('export-tip', '已复制到剪贴板');
  } catch (e) {
    setTip('export-tip', `复制失败：${e?.message || e}`);
  }
}

/** 把任意图片统一重编码为 PNG（部分引擎只吃 PNG 粘贴） */
async function normalizeToPng(blob) {
  if (blob.type === 'image/png') return blob;
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext('2d').drawImage(bmp, 0, 0);
  return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

async function openEngine(engineId) {
  const inv = state.inv;
  if (!inv) return;
  const res = await send({
    type: 'engines:open-one',
    engineId,
    useClipboard: !inv.image?.canDirectLink,
  });
  if (res?.ok) {
    setTip('export-tip', res.note || '已打开');
  } else {
    setTip('export-tip', res?.error || '打开失败');
  }
}

async function saveEngineField(engineId, field, value) {
  const res = await send({ type: 'inv:patch', enginePatch: { id: engineId, [field]: value } });
  if (res?.inv) {
    state.inv = res.inv;
    render();
  }
  setTip('save-manual-tip', '已保存');
  setTimeout(() => setTip('save-manual-tip', ''), 1600);
}

async function saveManual() {
  const verdict =
    document.querySelector('.verdict-chip.active')?.dataset.verdict ||
    state.inv?.manual?.verdict ||
    null;
  const res = await send({
    type: 'inv:patch',
    manual: {
      verdict,
      confidence: verdict ? 'medium' : null,
      claimText: $('claim-text').value,
      notes: $('manual-notes').value,
      decidedAt: verdict ? new Date().toISOString() : undefined,
    },
  });
  if (res?.inv) {
    state.inv = res.inv;
    render();
  }
  setTip('save-manual-tip', '裁定已保存');
  setTimeout(() => setTip('save-manual-tip', ''), 1600);
}

async function runC2paVerification() {
  const inv = state.inv;
  if (!inv?.image?.sha256) return;
  const btn = $('btn-verify-c2pa');
  btn.disabled = true;
  btn.textContent = '验签中…';
  try {
    const blob = await getImageBlob(inv.image.sha256);
    const result = await verifyC2pa(blob, inv.image.mime);
    const res = await send({ type: 'c2pa:save-result', c2pa: result });
    if (res?.inv) {
      state.inv = res.inv;
      render();
    }
  } catch (e) {
    setTip('export-tip', `验签失败：${e?.message || e}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'C2PA 验签';
  }
}

async function extractFacts() {
  const inv = state.inv;
  if (!inv?.image?.sha256) return;
  const btn = $('btn-extract-facts');
  btn.disabled = true;
  btn.textContent = '提取中…';
  $('ai-status').textContent = '正在调用视觉模型提取画面事实…';
  try {
    const blob = await getImageBlob(inv.image.sha256);
    const b64 = await blobToBase64(blob);
    // 超过 1600px 的长边先压缩，避免中转路由的 4MB 请求体限制与超时
    const { base64: payload, mime } = await compressForLLM(blob);
    const res = await send({
      type: 'llm:generate-facts',
      imageBase64: payload,
      mime,
      visionModel: state.options?.llmVisionModel || '',
    });
    if (res?.inv) {
      state.inv = res.inv;
      state.factEdits = null;
      render();
    }
    void b64;
  } catch (e) {
    $('ai-status').textContent = `提取失败：${e?.message || e}`;
  } finally {
    btn.disabled = false;
    btn.textContent = '提取画面事实';
  }
}

/** 压缩到长边 ≤1600 的 JPEG，用于发给 LLM（不影响本地原始字节的元数据检验） */
async function compressForLLM(blob, maxEdge = 1600, quality = 0.85) {
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    const out = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    return { base64: await blobToBase64(out), mime: 'image/jpeg' };
  } catch {
    return { base64: await blobToBase64(blob), mime: blob.type || 'image/jpeg' };
  }
}

async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

async function confirmFacts() {
  const inv = state.inv;
  if (!inv?.article?.facts) return;
  // 把人工修正写回 facts，并置位闸门 A
  const facts = { ...inv.article.facts, ...(state.factEdits || {}) };
  const res = await send({ type: 'inv:patch', article: { facts, factsConfirmed: true } });
  if (res?.inv) {
    state.inv = res.inv;
    render();
  }
  setTip('ai-status', '闸门 A 已确认');
}

async function generateDraft() {
  const btn = $('btn-generate-draft');
  btn.disabled = true;
  btn.textContent = '生成中…';
  $('ai-status').textContent = '正在生成受控文案…';
  try {
    const res = await send({ type: 'llm:generate-draft' });
    if (res?.inv) {
      state.inv = res.inv;
      state.draftEdits = null;
      render();
    }
  } catch (e) {
    $('ai-status').textContent = `生成失败：${e?.message || e}`;
  } finally {
    btn.disabled = false;
    btn.textContent = '生成文案';
  }
}

async function confirmDraft() {
  const res = await send({ type: 'inv:patch', article: { draftConfirmed: true } });
  if (res?.inv) {
    state.inv = res.inv;
    render();
  }
  setTip('ai-status', '闸门 B 已确认');
}

async function renderCard() {
  const inv = state.inv;
  const draft = inv?.article?.draft;
  if (!draft) return;
  const merged = { ...draft, ...(state.draftEdits || {}) };
  const blob = inv.image?.sha256 ? await getImageBlob(inv.image.sha256) : null;
  await renderFactCheckCard($('card-canvas'), merged, blob, state.options?.watermark);
  $('card-canvas').setAttribute('data-rendered', '1');
  $('preview-empty').classList.add('hidden');
  setTip('export-tip', '预览已刷新');
}

async function exportCard() {
  const canvas = $('card-canvas');
  if (!canvas.width) {
    await renderCard();
  }
  const res = await downloadCanvas(canvas, `factcheck-${Date.now()}.png`);
  setTip('export-tip', res.ok ? `已导出（${Math.round(res.bytes / 1024)} KB）` : res.error);
}

async function handleManualDrop(file) {
  if (!file) return;
  const base64 = await blobToBase64(file);
  const res = await send({
    type: 'inv:manual-drop',
    file: { bytesBase64: base64, fileName: file.name, mime: file.type || 'image/jpeg' },
  });
  if (res?.inv) {
    state.inv = res.inv;
    state.factEdits = null;
    state.draftEdits = null;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

async function loadHistory() {
  const res = await send({ type: 'history:list' });
  const list = res?.history || [];
  if (!list.length) {
    $('history-list').innerHTML = '<p class="muted small">暂无历史记录。</p>';
    return;
  }
  $('history-list').innerHTML = list
    .slice(0, 30)
    .map(
      (h) => `
    <div class="history-item">
      <span class="h-title" title="${escapeHtml(h.pageTitle || '')}">${escapeHtml(
        h.headline || h.pageTitle || h.id
      )}</span>
      <span class="h-meta">${escapeHtml(h.pageSite || '')} · ${escapeHtml(
        VERDICT_LABEL[h.verdict] || h.verdict || ''
      )}</span>
      <button class="ghost-btn" data-history="${escapeHtml(h.id)}">载入</button>
    </div>`
    )
    .join('');

  $('history-list')
    .querySelectorAll('[data-history]')
    .forEach((btn) =>
      btn.addEventListener('click', async () => {
        const r = await send({ type: 'history:load', id: btn.dataset.history });
        if (r?.inv) {
          state.inv = r.inv;
          state.factEdits = null;
          state.draftEdits = null;
          render();
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
      })
    );
}

// ---------- 工具 ----------

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

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(v) {
  try {
    const d = new Date(v);
    return isNaN(d.getTime()) ? String(v) : d.toLocaleString('zh-CN');
  } catch {
    return String(v);
  }
}

function factLine(label, value) {
  if (!value) return '';
  return `<div class="fact-line"><b>${escapeHtml(label)}</b>${escapeHtml(value)}</div>`;
}

/** 闸门 A 的可编辑事实字段（数组字段以「、」分隔输入） */
const FACT_ARRAY_FIELDS = new Set([
  'objects',
  'visibleText',
  'counts',
  'anomalies',
  'unknowns',
]);

function factInput(field, label, value) {
  return `<div class="draft-field"><span>${escapeHtml(label)}</span><input type="text" data-fact="${field}" value="${escapeHtml(
    value || ''
  )}" /></div>`;
}

function draftInput(field, label, value) {
  return `<div class="draft-field"><span>${escapeHtml(label)}</span><input type="text" data-field="${field}" value="${escapeHtml(
    value || ''
  )}" /></div>`;
}

function draftTextarea(field, label, value) {
  return `<div class="draft-field"><span>${escapeHtml(label)}</span><textarea rows="3" data-field="${field}" data-multiline="1">${escapeHtml(
    value || ''
  )}</textarea></div>`;
}

function setTip(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

void ENGINES;
