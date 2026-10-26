/**
 * UI 审计：配色对比度 + 元素/样式一致性（无需浏览器）。
 *
 *  1) 从宿主主题包解析**真实的**明/暗色 token 值（不是猜的）；
 *  2) 对每一处"文字压在背景上"算 WCAG 对比度并判定；
 *  3) 回归检查：禁止 `background: brand-primary` + `color:#fff`
 *     —— 宿主 brand 在深色下等于文字色（#f9fafb），这样搭配会白字压白底；
 *  4) 核对 class 定义/使用、hover-only 控件、触摸兜底、字号与点击目标。
 *
 * 阈值：普通文字 4.5:1；大字（≥18.7px 粗 / 24px）与 UI 图形 3:1。
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const THEME = '/home/user/.npm/_npx/b5c6312874079fe8/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js';

let failures = 0;
let checks = 0;
const rows = [];

function record(group, label, ratio, threshold) {
  checks += 1;
  const ok = ratio >= threshold;
  if (!ok) failures += 1;
  rows.push({ group, label, ratio: Number(ratio.toFixed(2)), threshold, ok });
}

function hexToRgb(hex) {
  const h = String(hex).trim().replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}
function channel(c) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function luminance(rgb) { return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]); }
function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// ── 宿主 token
const themeSource = await fsp.readFile(THEME, 'utf8');
const statics = new Map();
for (const m of themeSource.matchAll(/--(dsw-static-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})/g)) {
  if (!statics.has(m[1])) statics.set(m[1], m[2]);
}
function parseVars(block) {
  const map = new Map();
  for (const m of block.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) map.set(m[1], m[2].trim());
  return map;
}
function resolveColor(vars, name, depth = 0) {
  const raw = vars.get(name);
  if (!raw || depth > 6) return null;
  const varRef = /^var\(--([a-z0-9-]+)\)$/.exec(raw);
  if (varRef) {
    const inner = varRef[1];
    return resolveColor(vars, inner, depth + 1) || statics.get(inner) || null;
  }
  if (raw.startsWith('#')) return raw;
  return statics.get(`dsw-static-${raw}`) || statics.get(raw) || null;
}
const lightStart = themeSource.indexOf('body{--dsw-alias-bg-base');
const lightVars = parseVars(themeSource.slice(lightStart + 5, themeSource.indexOf('}', lightStart)));
const darkStart = themeSource.indexOf('body[data-ds-dark-theme]{--dsw-alias-bg-base');
const darkVars = parseVars(themeSource.slice(darkStart + 'body[data-ds-dark-theme]{'.length, themeSource.indexOf('}', darkStart)));

function themeOf(vars) {
  const pick = (name) => resolveColor(vars, name);
  return {
    bgBase: pick('dsw-alias-bg-base'), layer1: pick('dsw-alias-bg-layer-1'), layer2: pick('dsw-alias-bg-layer-2'),
    labelPrimary: pick('dsw-alias-label-primary'), labelSecondary: pick('dsw-alias-label-secondary'),
    brand: pick('dsw-alias-brand-primary')
  };
}
const themes = { light: themeOf(lightVars), dark: themeOf(darkVars) };

console.log('宿主真实 token（解析自主题包）');
for (const [name, t] of Object.entries(themes)) {
  console.log(`  ${name}: bg=${t.bgBase} layer1=${t.layer1} layer2=${t.layer2} text=${t.labelPrimary} text2=${t.labelSecondary} brand=${t.brand}`);
}

// ── 插件样式
const clientSource = await fsp.readFile(path.join(repo, 'client.js'), 'utf8');
const css = /const STYLE = `([\s\S]*?)`;/.exec(clientSource)[1];
const lightBlock = /\.gm-root\{([\s\S]*?)\}/.exec(css)[1];
const darkBlockMatch = /body\[data-ds-dark-theme\] \.gm-root\{([\s\S]*?)\}/.exec(css);
const darkBlock = darkBlockMatch ? darkBlockMatch[1] : '';
const paletteLight = {};
for (const m of lightBlock.matchAll(/--gm-([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})/g)) paletteLight[m[1]] = m[2];
const paletteDark = Object.assign({}, paletteLight);
for (const m of darkBlock.matchAll(/--gm-([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})/g)) paletteDark[m[1]] = m[2];

console.log('\n插件色板（明 / 暗）');
for (const key of Object.keys(paletteLight)) {
  console.log(`  --gm-${key}: ${paletteLight[key]}${paletteDark[key] !== paletteLight[key] ? ` → 暗色 ${paletteDark[key]}` : ''}`);
}

console.log('\n色块 / 徽章（白字，阈值 4.5）');
const SHADE_KEYS = ['safe', 'safe2', 'safe3', 'caution', 'caution2', 'caution3', 'keep', 'keep2', 'keep3', 'blocked', 'blocked2', 'blocked3'];
const white = [255, 255, 255];
for (const key of SHADE_KEYS) {
  if (!paletteLight[key]) { record('色块', `--gm-${key} 缺失`, 0, 1); continue; }
  record('色块', `白字 on --gm-${key} (${paletteLight[key]})`, contrast(white, hexToRgb(paletteLight[key])), 4.5);
}

console.log('\n文字层级（明/暗 × 三种背景，阈值 4.5）');
for (const [themeName, theme] of Object.entries(themes)) {
  for (const [bgName, bgHex] of [['bg-base', theme.bgBase], ['layer-1', theme.layer1], ['layer-2', theme.layer2]]) {
    if (!bgHex) continue;
    const bg = hexToRgb(bgHex);
    if (theme.labelPrimary) record(`${themeName}·正文`, `label-primary on ${bgName}`, contrast(hexToRgb(theme.labelPrimary), bg), 4.5);
    if (theme.labelSecondary) record(`${themeName}·次要`, `label-secondary on ${bgName}`, contrast(hexToRgb(theme.labelSecondary), bg), 4.5);
  }
}

console.log('\n强调色与按钮（成对比较，阈值 4.5）');
for (const themeName of ['light', 'dark']) {
  const palette = themeName === 'light' ? paletteLight : paletteDark;
  const accent = palette.accent;
  const onAccent = palette['on-accent'];
  if (!accent || !onAccent) { record(themeName, '缺少 accent/on-accent 定义', 0, 1); continue; }
  record(`${themeName}·主按钮`, `${onAccent} on ${accent}`, contrast(hexToRgb(onAccent), hexToRgb(accent)), 4.5);
  const bg = themes[themeName].layer2;
  if (bg) record(`${themeName}·@引用`, `accent ${accent} on layer-2 ${bg}`, contrast(hexToRgb(accent), hexToRgb(bg)), 4.5);
  record(`${themeName}·危险按钮`, `白字 on --gm-danger ${palette.danger || palette.blocked}`, contrast(white, hexToRgb(palette.danger || palette.blocked)), 4.5);
}

console.log('\n回归检查');
checks += 1;
const brandWhite = /background:\s*var\(--dsw-alias-brand-primary\)[^}]*color:\s*#fff|color:\s*#fff[^}]*background:\s*var\(--dsw-alias-brand-primary\)/.test(css);
if (brandWhite) { failures += 1; console.log('  ✗ 仍有 `background: brand-primary` + `color:#fff`（深色下白字压白底）'); }
else console.log('  ✓ 没有 brand-primary + 白字的组合');

checks += 1;
if (/\.gm-tab\.on[^{]*\{[^}]*color:\s*#fff/.test(css)) { failures += 1; console.log('  ✗ 选中页签仍用白字压在会随主题翻转的填充上'); }
else console.log('  ✓ 选中页签使用 accent/on-accent 成对配色');

checks += 1;
if (/--gm-t3\{[^}]*opacity:\s*\.?7/.test(css)) { failures += 1; console.log('  ✗ .gm-t3 仍在降透明度（浅色下低于 4.5:1）'); }
else console.log('  ✓ 第三级文字不再靠降透明度');

console.log('\n视觉评审回归项');
checks += 1;
if (/\.gm-chip\.off\{[^}]*opacity:\s*(\.\d+|0\.[0-9]+)/.test(css)) { failures += 1; console.log('  ✗ .gm-chip.off 用透明度表达"未选中"（深色下文字只剩 ~3.3:1）'); }
else console.log('  ✓ 未选中胶囊不靠透明度（改虚线边框 + 次要文字色）');

checks += 1;
const placeholder = /::placeholder\{([^}]*)\}/.exec(css);
if (placeholder && /opacity:\s*(\.\d+|0\.[0-9]+)/.test(placeholder[1])) { failures += 1; console.log('  ✗ 占位符降了透明度（深色下 3.4:1）'); }
else console.log('  ✓ 占位符用不透明次要文字色');

checks += 1;
const trackLayer2 = /\.gm-(rbar|diskbar|scanbar)\{[^}]*background:\s*var\(--dsw-alias-bg-layer-2\)/.test(css);
if (trackLayer2) { failures += 1; console.log('  ✗ 进度条轨道用 layer-2（压在卡片上只有 1.28:1，看不出剩余）'); }
else console.log('  ✓ 进度条轨道用边框色（≥3:1 可辨）');

checks += 1;
if (/\.gm-cardhead\{[^}]*min-height:/.test(css)) console.log('  ✓ 卡片头有固定最小高度（两列分隔线不会错位）');
else { failures += 1; console.log('  ✗ 卡片头没有最小高度：并排两卡的分隔线会错开'); }

checks += 1;
if (/\.gm-root\{[^}]*background:\s*transparent/.test(css)) console.log('  ✓ 面板不再自铺底色（避免四周露一圈更暗的内框）');
else { failures += 1; console.log('  ✗ 面板自铺底色：宿主面板外会露出一圈色差'); }

checks += 1;
if (/\.gm-root \*\{box-sizing:border-box\}/.test(css)) console.log('  ✓ 全局 box-sizing:border-box（控件高度才真的一致）');
else { failures += 1; console.log('  ✗ 缺全局 box-sizing：chip/input 会比 button 高 2px'); }

checks += 1;
if (/\.gm-cardbody\{[^}]*scrollbar-width:\s*thin/.test(css)) { failures += 1; console.log('  ✗ 同时用了 scrollbar-width 与 ::-webkit-scrollbar，Chromium 会忽略后者（▲▼ 按钮回来）'); }
else console.log('  ✓ 滚动条只用 ::-webkit-scrollbar（Chromium 正常生效）');

checks += 1;
// 5 个筛选胶囊要能放进一行的可用宽度（按最坏情况估算：每字约 12px + padding 16 + gap 5）
const chipW = ['全部', '可安全删除', '需你确认', '建议保留', '不可删除'];
const estimate = chipW.reduce((sum, w) => sum + w.length * 12 + 16, 0) + (chipW.length - 1) * 5;
if (/padding:0 8px/.test(css) && /gap:4px/.test(css)) console.log(`  ✓ 筛选胶囊收紧到 gap4/padding8（估算 ${estimate}px，接近 404px 可用宽）`);
else { failures += 1; console.log('  ✗ 筛选胶囊未收紧，可能换行'); }

/* DOC-SPLIT */
checks += 1;
// 色块不允许按序号轮换色阶（会让同风险被误读成不同类别）
if (/riskVar\([^)]*,\s*[a-zA-Z]/.test(clientSource)) { failures += 1; console.log('  ✗ 色块仍按序号轮换色阶（同风险会被看成不同类别）'); }
else console.log('  ✓ 色块颜色只表达风险，不随条目序号变化');

checks += 1;
// 过小的块要折叠，避免无文字碎片
if (/foldedItems/.test(css + clientSource)) console.log('  ✓ 过小的块会折叠成「其他 N 项」');
else { failures += 1; console.log('  ✗ 没有折叠逻辑：会出现 2px 无文字碎片'); }

/* DOC-SPLIT */
// 文案完整性：t('key') 必须有对应词条，否则界面上会直接显示原始 key
{
  const iZh = clientSource.indexOf('      zh: {');
  const iEn = clientSource.indexOf('      en: {');
  const zhBlock = clientSource.slice(iZh, iEn);
  const enBlock = clientSource.slice(iEn, clientSource.indexOf('    const LANG'));
  const keys = (block) => new Set([...block.matchAll(/([a-zA-Z][a-zA-Z0-9]*)\s*:\s*(?:'|\{)/g)].map((m) => m[1]));
  const usedKeys = new Set([...clientSource.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)].map((m) => m[1]));
  const zhKeys = keys(zhBlock);
  const enKeys = keys(enBlock);
  const missZh = [...usedKeys].filter((k) => !zhKeys.has(k)).sort();
  const missEn = [...usedKeys].filter((k) => !enKeys.has(k)).sort();
  checks += 1;
  if (missZh.length > 0 || missEn.length > 0) {
    failures += 1;
    console.log(`  ✗ 文案缺词条（界面会显示原始 key）：zh[${missZh.join(', ')}] en[${missEn.join(', ')}]`);
  } else console.log(`  ✓ ${usedKeys.size} 个 t() 文案键在 zh/en 两个字典里都存在`);
}

checks += 1;
if (/\.gm-(rbar|diskbar|scanbar)\{[^}]*background:\s*var\(--dsw-alias-(border-l1|bg-layer-2)\)/.test(css)) {
  failures += 1;
  console.log('  ✗ 进度条轨道仍用低对比色（边框/layer-2 在卡片上只有 ~1.2:1）');
} else console.log('  ✓ 进度条轨道用专用 --gm-track（明暗两套都 ≥3:1）');

checks += 1;
if (/\.gm-btn\.gm-primary\[disabled\]/.test(css)) console.log('  ✓ 禁用态主按钮有独立样式（不是整体降透明度）');
else { failures += 1; console.log('  ✗ 禁用态主按钮只靠 opacity，文字对比度会掉到 ~2.6:1'); }

checks += 1;
if (!/\.gm-chip\.off\{[^}]*border-style:\s*dashed/.test(css)) console.log('  ✓ 未选中胶囊不用虚线（虚线看起来像禁用）');
else { failures += 1; console.log('  ✗ 未选中胶囊用虚线边框，像禁用状态'); }

checks += 1;
// 图例色块要用填色本身，而不是另一套"更亮"的颜色
if (/background:\s*riskVar\(risk\)/.test(clientSource) && /border:\s*'1px solid var\(--dsw-alias-label-secondary\)'/.test(clientSource)) console.log('  ✓ 图例色块用真实填色 + 高对比描边（与树图一致）');
else { failures += 1; console.log('  ✗ 图例颜色与树图填色不一致，用户无法对应'); }

/* DOC-SPLIT */
console.log('\n本轮（r9）回归项');
checks += 1;
if (/\.gm-card--current\{[^}]*max-height/.test(css) && /\.gm-cardfoot\{[^}]*border-top/.test(css)) console.log('  ✓ 当前位置卡"内容可滚动 + 操作行固定在卡底"（解释不会再被遮住）');
else { failures += 1; console.log('  ✗ 缺少固定操作行：解释内容会把按钮挤走/被卡边裁掉'); }

checks += 1;
if (!/不跟进|避免绕圈/.test(clientSource)) console.log('  ✓ 没有"（不跟进，避免绕圈）"这类开发解释性措辞');
else { failures += 1; console.log('  ✗ 仍有开发解释性措辞（如"不跟进，避免绕圈"）'); }

checks += 1;
if (!/modeClean:\s*'(清除|Clear)'/.test(clientSource) && /modeClean:\s*'清理'/.test(clientSource)) console.log('  ✓ 操作术语统一为"清理"（不再混用清除/清理）');
else { failures += 1; console.log('  ✗ 术语仍混用：modeClean 不是"清理"'); }

checks += 1;
// "加入清理清单"按钮与操作下拉重复：当前位置卡只应保留下拉
const dupButton = /t\('addToList'\)\)/.test(clientSource);
if (!new RegExp("addCurrentToCart\\('clean'\\)\\},").test(clientSource)) console.log('  ✓ 已删掉与操作下拉重复的"加入清理清单"按钮');
else { failures += 1; console.log('  ✗ "加入清理清单"按钮与操作下拉仍然重复'); }

checks += 1;
if (/cartSearch/.test(clientSource) && /gm-footbar/.test(css)) console.log('  ✓ 底栏常驻搜索框（清单过滤）');
else { failures += 1; console.log('  ✗ 底栏没有搜索框'); }

checks += 1;
if (/\.gm-rex\{/.test(css)) console.log('  ✓ 本层条目显示子项解释（单行截断，悬停看全文）');
else { failures += 1; console.log('  ✗ 本层条目没有解释行样式'); }

checks += 1;
if (/explainDepth/.test(clientSource) && /setExplainDepth/.test(clientSource)) console.log('  ✓ 设置里有"自动解释层级 / 每层条数 / 联网次数 / 是否联网"');
else { failures += 1; console.log('  ✗ 设置里缺解释相关选项'); }

/* DOC-SPLIT */
checks += 1;
if (/parentNodeSize/.test(clientSource) && /selfInfo\.size \/ parentNodeSize/.test(clientSource)) console.log('  ✓ "占上级"用父目录体积当分母（不会恒为 100%）');
else { failures += 1; console.log('  ✗ "占上级"分母仍是当前目录体积，恒为 100%'); }

checks += 1;
if (/force: explainForce/.test(clientSource) && /reexplain/.test(clientSource)) console.log('  ✓ 有「重新解释」（force 绕过缓存）');
else { failures += 1; console.log('  ✗ 缺少强制重新解释入口'); }

/* DOC-SPLIT */
console.log('\n审计入口回归项');
checks += 1;
if (/\.gm-audit\{/.test(css) && /\.gm-auditrow\{/.test(css) && /\.gm-modal-wide\{/.test(css)) console.log('  ✓ 审计弹窗样式齐全（宽弹窗 + 运行列表 + 详情）');
else { failures += 1; console.log('  ✗ 审计弹窗样式缺失'); }

checks += 1;
if (/🗂 \$\{t\('auditOpen'\)\}/.test(clientSource) && /onClick: openAudit/.test(clientSource)) console.log('  ✓ 右上角有「审计」按钮（与设置并列）');
else { failures += 1; console.log('  ✗ 右上角缺「审计」入口'); }

checks += 1;
if (/\/api\/audit\/prune/.test(clientSource) && /pruneAuditLogs/.test(clientSource)) console.log('  ✓ 设置里能清理审计日志（保留最近 N 次 / 可选清空解释缓存）');
else { failures += 1; console.log('  ✗ 设置里缺日志清理'); }

checks += 1;
// 底部只保留"折叠栏 + 运行中进度"，报告/日志搬进审计
const footStart = clientSource.indexOf("const footer = h('div', { className: 'gm-foot' }");
const footEnd = clientSource.indexOf("const auditModal", footStart); // 审计弹窗在底栏之后定义，必须切在它前面
const footSrc = clientSource.slice(footStart, footEnd);
if (!/t\('report'\)/.test(footSrc) && !/gm-log/.test(footSrc) && /auditMovedHint/.test(footSrc)) console.log('  ✓ 报告/日志已移出底栏（底栏只剩折叠栏 + 运行进度 + 审计入口）');
else { failures += 1; console.log('  ✗ 底栏仍渲染报告/日志，会挤占界面'); }

/* DOC-SPLIT */
console.log('\n令牌过期回归项');
checks += 1;
if (/res\.status === 403 && code === 'bad-token'/.test(clientSource) && /staleTokenSink/.test(clientSource)) console.log('  ✓ 客户端识别 403 bad-token 并交给界面处理');
else { failures += 1; console.log('  ✗ 客户端没有识别 bad-token'); }

checks += 1;
if (/\.gm-stale\{/.test(css) && /staleTokenReload/.test(clientSource)) console.log('  ✓ 有"页面令牌已过期"横幅 + 立即刷新按钮');
else { failures += 1; console.log('  ✗ 缺少令牌过期提示（用户只会看到 bad-token）'); }

checks += 1;
if (/garbage_master_token_reloaded/.test(clientSource)) console.log('  ✓ 自动刷新只做一次（有防循环标记）');
else { failures += 1; console.log('  ✗ 自动刷新没有防循环，可能无限刷新'); }

checks += 1;
if (/staleTokenHint/.test(clientSource) && /bad-token\|令牌/.test(clientSource)) console.log('  ✓ 解释失败时按真实原因提示（不再一律说"需重启 dsh"）');
else { failures += 1; console.log('  ✗ 解释失败的提示仍是笼统的"需重启"'); }

/* DOC-SPLIT */
console.log('\n弹窗层级与解释诊断');
checks += 1;
{
  const idxAudit = clientSource.indexOf('        auditModal,');
  const idxSettings = clientSource.indexOf('        settingsModal,');
  const idxFinal = clientSource.indexOf('        finalModal,');
  if (idxAudit > idxSettings && idxAudit > idxFinal) console.log('  ✓ 审计弹窗最后挂载（不会再被设置弹窗盖住）');
  else { failures += 1; console.log('  ✗ 审计弹窗挂在设置前面，会被盖住'); }
}
checks += 1;
if (/\.gm-overlay-top\{[^}]*z-index:\s*11\d\d/.test(css)) console.log('  ✓ 审计弹窗有更高的 z-index（保险）');
else { failures += 1; console.log('  ✗ 审计弹窗没有更高的 z-index'); }

checks += 1;
if (/explainFailedShort/.test(clientSource) && !/t\('explainUnavailable'\)\s*\)/.test(clientSource)) console.log('  ✓ 解释失败时显示真实原因（不再一律"需重启 dsh"）');
else { failures += 1; console.log('  ✗ 解释失败仍显示笼统提示'); }

checks += 1;
{
  const hostIndex = await fsp.readFile(path.join(repo, 'index.js'), 'utf8');
  if (/explain-last\.json/.test(hostIndex)) console.log('  ✓ Host 落盘最后一条解释诊断（explain-last.json）');
  else { failures += 1; console.log('  ✗ 缺解释诊断落盘'); }
}

/* DOC-SPLIT */
console.log('\n解释加载态与取样回归项');
checks += 1;
if (/\.gm-spin-sm\{/.test(css) && /gm-spin-sm/.test(clientSource)) console.log('  ✓ 有"解释中"小转圈（条目行 / 树块 / 当前位置都用）');
else { failures += 1; console.log('  ✗ 缺少解释中的加载图标'); }

checks += 1;
if (/\.gm-tile\.pending\{/.test(css) && /explainPendingSet\.has\(item\.path\)/.test(clientSource)) console.log('  ✓ 树块有解释中状态（描边 + 脉冲）');
else { failures += 1; console.log('  ✗ 树块没有解释中状态'); }

checks += 1;
if (/gm-rex-wait/.test(css) && /t\('explaining'\)/.test(clientSource)) console.log('  ✓ 条目行有"正在解释…"占位文字');
else { failures += 1; console.log('  ✗ 条目行缺解释中占位'); }

checks += 1;
{
  const hostExplain = await fsp.readFile(path.join(repo, 'host/explain.js'), 'utf8');
  if (/probeDirectory/.test(hostExplain) && /内含\$\{item\.sample\.count\}项/.test(hostExplain)) console.log('  ✓ 解释会把"目录内含"带进提示词（结合文件分析）');
  else { failures += 1; console.log('  ✗ 解释只看路径名，没结合目录内容'); }
}

/* DOC-SPLIT */
console.log('\n解释提速回归项（r17）');
checks += 1;
if (/explain-partial/.test(clientSource) && /setExplanations\(\(cur\) => Object\.assign\(\{\}, cur, partial\)\)/.test(clientSource)) console.log('  ✓ 分批到达的解释即时显示（SSE explain-partial）');
else { failures += 1; console.log('  ✗ 前端没有接分批推送'); }

checks += 1;
{
  const hostExplain = await fsp.readFile(path.join(repo, 'host/explain.js'), 'utf8');
  if (/heuristicExplain/.test(hostExplain) && /FILE_HEURISTICS/.test(hostExplain)) console.log('  ✓ 媒体周边文件走启发式短路（不问模型）');
  else { failures += 1; console.log('  ✗ 缺启发式短路'); }
  checks += 1;
  if (/explainConcurrency/.test(hostExplain) && /Promise\.all\(workers\)/.test(hostExplain)) console.log('  ✓ 分批并行且并发度可配');
  else { failures += 1; console.log('  ✗ 分批仍是串行'); }
  checks += 1;
  if (/Promise\.all\(items\.map\(async \(item\)/.test(hostExplain)) console.log('  ✓ 联网搜索并行（原来是串行）');
  else { failures += 1; console.log('  ✗ 联网搜索仍串行'); }
}

checks += 1;
{
  const hostIndex = await fsp.readFile(path.join(repo, 'index.js'), 'utf8');
  if (/resolveModelInfo/.test(hostIndex) && /explain-model/.test(await fsp.readFile(path.join(repo, 'host/http.js'), 'utf8'))) console.log('  ✓ 设置能读模型声明的思考强度（/api/explain-model）');
  else { failures += 1; console.log('  ✗ 缺思考强度查询'); }
}

checks += 1;
if (/explainConcurrency/.test(clientSource) && /setExplainEffort/.test(clientSource)) console.log('  ✓ 设置里有并发度与思考强度');
else { failures += 1; console.log('  ✗ 设置里缺并发度/思考强度'); }

/* DOC-SPLIT */
console.log('\n会话计划回归项（r18）');
checks += 1;
if (/function renderMarkdown/.test(clientSource) && /\.gm-md-table\{/.test(css) && /\.gm-md-pre\{/.test(css)) console.log('  ✓ 面板能渲染计划 Markdown（标题/列表/表格/代码块）');
else { failures += 1; console.log('  ✗ 缺计划 Markdown 渲染'); }

checks += 1;
if (/\/api\/session-plan/.test(clientSource) && /\/api\/session-execute/.test(clientSource)) console.log('  ✓ 前端接了会话计划与"确认后执行"');
else { failures += 1; console.log('  ✗ 前端没接会话计划/执行'); }

checks += 1;
{
  const hostHttp = await fsp.readFile(path.join(repo, 'host', 'http.js'), 'utf8');
  if (/\/api\/session-plan/.test(hostHttp) && /\/api\/session-info/.test(hostHttp) && /\/api\/session-execute/.test(hostHttp)) console.log('  ✓ Host 有三个会话路由');
  else { failures += 1; console.log('  ✗ Host 缺会话路由'); }
  checks += 1;
  const bridge = await fsp.readFile(path.join(repo, 'host', 'session-bridge.js'), 'utf8');
  if (/form: 'notice'/.test(bridge) && /surfaceOp: 'append'/.test(bridge)) console.log('  ✓ 解释结果以"可见通知"写进会话（B+C）');
  else { failures += 1; console.log('  ✗ 没把解释写进会话'); }
}

checks += 1;
if (/setWorkspace/.test(clientSource) && /setPlanSession/.test(clientSource) && /setExplainModel/.test(clientSource)) console.log('  ✓ 设置里有工作区绑定 / 会话计划开关 / 模型覆盖');
else { failures += 1; console.log('  ✗ 设置缺新选项'); }

/* DOC-SPLIT */
console.log('\n缓存解释不回流转圈（r19）');
checks += 1;
if (/listing\.explanation/.test(clientSource) && /child\.explanation/.test(clientSource)) console.log('  ✓ 前端采用 /api/ls 带回的解释（不再为空跑一次请求）');
else { failures += 1; console.log('  ✗ 前端没有使用 ls 带回的解释'); }

checks += 1;
if (/if \(wanted\.length === 0\) \{ setExplainPending\(\[\]\); return; \}/.test(clientSource)) console.log('  ✓ "无需解释"时强制清空 pending（不会残留转圈）');
else { failures += 1; console.log('  ✗ wanted 为空时可能残留转圈'); }

checks += 1;
{
  const lsSrc = await fsp.readFile(path.join(repo, 'host', 'ls.js'), 'utf8');
  if (/explainLookup/.test(lsSrc) && /explanation: typeof explainLookup === 'function'/.test(lsSrc)) console.log('  ✓ Host 的 /api/ls 带出已缓存解释');
  else { failures += 1; console.log('  ✗ Host 的 ls 没带解释'); }
}

checks += 1;
{
  const idx = await fsp.readFile(path.join(repo, 'index.js'), 'utf8');
  if (/function lookupExplanation/.test(idx) && /lookupExplanation,\n/.test(idx)) console.log('  ✓ Host 提供 lookupExplanation 并注入路由');
  else { failures += 1; console.log('  ✗ 缺 lookupExplanation'); }
}

/* DOC-SPLIT */
console.log('\n计划在右栏 + 清单零 LLM（r20）');
checks += 1;
if (/const planCard = sessionPlanState/.test(clientSource) && /gm-card--plan/.test(css) && /planCard \|\| h\('div', \{ className: 'gm-col-inner'/.test(clientSource)) console.log('  ✓ 计划文档显示在 GM 面板自己的右栏（不是弹窗）');
else { failures += 1; console.log('  ✗ 计划仍走弹窗'); }

checks += 1;
if (!/sessionPlanModal/.test(clientSource)) console.log('  ✓ 旧的计划弹窗已移除（无死代码）');
else { failures += 1; console.log('  ✗ 还残留旧计划弹窗'); }

checks += 1;
{
  const hostHttp = await fsp.readFile(path.join(repo, 'host', 'http.js'), 'utf8');
  const planRoute = hostHttp.slice(hostHttp.indexOf("'POST /api/plan'"), hostHttp.indexOf("'POST /api/submit'"));
  if (!/requestAiPlan/.test(planRoute) && /deterministic-only/.test(planRoute)) console.log('  ✓ 提交清单零 LLM 调用（纯确定性）');
  else { failures += 1; console.log('  ✗ /api/plan 仍在调用 LLM'); }
}

checks += 1;
{
  const idx = await fsp.readFile(path.join(repo, 'index.js'), 'utf8');
  if (/degraded: true/.test(idx) && /planPermission/.test(idx)) console.log('  ✓ planMode 缺失时降级为只读权限预设');
  else { failures += 1; console.log('  ✗ 缺 planMode 降级'); }
  checks += 1;
  if (/explain-session-last\.json/.test(idx)) console.log('  ✓ 解释写会话失败会落盘原因（explain-session-last.json）');
  else { failures += 1; console.log('  ✗ 解释写会话失败仍静默'); }
}

/* DOC-SPLIT */
console.log('\n元素与样式一致性');
const defined = new Set();
for (const m of css.matchAll(/\.(gm-[a-z0-9-]+)/g)) defined.add(m[1]);
const used = new Set();

/** 把模板字符串里的 ${...} 全部删掉（支持嵌套花括号），避免嵌套引号把类名截断。 */
function stripInterpolations(source) {
  let out = '';
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '$' && source[i + 1] === '{') {
      let depth = 0;
      let j = i + 1;
      for (; j < source.length; j += 1) {
        if (source[j] === '{') depth += 1;
        else if (source[j] === '}') { depth -= 1; if (depth === 0) { j += 1; break; } }
      }
      out += ' ';
      i = j - 1;
    } else {
      out += source[i];
    }
  }
  return out;
}
const classScan = stripInterpolations(clientSource);
for (const m of classScan.matchAll(/className:\s*['"`]([^'"`]+)['"`]/g)) {
  for (const cls of m[1].split(/\s+/)) if (cls.startsWith('gm-')) used.add(cls);
}
for (const m of classScan.matchAll(/'(gm-[a-z0-9-]+)'/g)) used.add(m[1]);

checks += 1;
const missing = [...used].filter((c) => !defined.has(c));
if (missing.length > 0) { failures += 1; console.log(`  ✗ className 里用到但样式没定义：${missing.join(', ')}`); }
else console.log(`  ✓ className 用到的 ${used.size} 个 gm-* 类都有样式`);

checks += 1;
if (/@media\s*\(hover:\s*none\)/.test(css)) console.log('  ✓ 有 hover:none / pointer:coarse 兜底');
else { failures += 1; console.log('  ✗ 缺少触摸兜底：行内按钮在触摸设备上会一直不可见'); }

checks += 1;
const tiny = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1])).filter((n) => n < 11);
if (tiny.length > 0) { failures += 1; console.log(`  ✗ 有字号小于 11px：${tiny.join(', ')}`); }
else console.log('  ✓ 所有字号 ≥ 11px');

checks += 1;
const miniHeight = /\.gm-mini\{([^}]*)\}/.exec(css);
const minH = miniHeight ? /min-height:\s*(\d+)px/.exec(miniHeight[1]) : null;
if (minH && Number(minH[1]) >= 24) console.log(`  ✓ 行内小按钮最小高度 ${minH[1]}px（≥24）`);
else { failures += 1; console.log('  ✗ 行内小按钮点击目标 < 24px'); }

console.log('\n逐项结果');
for (const row of rows) console.log(`  ${row.ok ? '✓' : '✗'} [${row.group}] ${row.label} = ${row.ratio}:1（≥${row.threshold}）`);

const bad = rows.filter((r) => !r.ok);
if (bad.length > 0) {
  console.log('\n不达标项：');
  for (const row of bad) console.log(`  - [${row.group}] ${row.label} = ${row.ratio}:1（需要 ≥${row.threshold}）`);
}
console.log(`\n结果：${checks - failures}/${checks} 通过${failures ? `，${failures} 项需要注意` : ''}\n`);
process.exit(failures === 0 ? 0 : 1);
