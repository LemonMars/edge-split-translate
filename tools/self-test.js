/**
 * tools/self-test.js —— 无浏览器的自检脚本
 *
 * 在 Node 里加载扩展的纯逻辑模块（lib/lang.js、lib/engine.js），验证：
 *   1. JSON 配置与清单文件是否合法、引用到的文件是否都存在；
 *   2. 语言检测在多种语言样本上的判定是否正确；
 *   3. 翻译结果解析器（JSON 数组 / 代码块 / 兜底行解析）是否稳健；
 *   4. 缓存 key 是否随服务商 / 模型 / 语言变化。
 *
 * 用法： node tools/self-test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let pass = 0;
let fail = 0;

function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`);
  }
}

/** 在伪浏览器环境里加载一个自执行到 self 上的库文件 */
function loadLib(relPath) {
  const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  const sandbox = { console };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src, sandbox, { filename: relPath });
  return sandbox;
}

/* ================================================================== */
console.log('\n[1] 清单与文件结构');
/* ================================================================== */

const manifestPath = path.join(ROOT, 'manifest.json');
let manifest = null;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  check('manifest.json 是合法 JSON', true);
} catch (err) {
  check('manifest.json 是合法 JSON', false, err.message);
}

if (manifest) {
  check('manifest_version === 3', manifest.manifest_version === 3, String(manifest.manifest_version));
  check('声明了 background.service_worker', !!(manifest.background && manifest.background.service_worker));
  check('声明了 action.default_popup', !!(manifest.action && manifest.action.default_popup));
  check('声明了 options_ui', !!manifest.options_ui);
  check('注册了 content_scripts', Array.isArray(manifest.content_scripts) && manifest.content_scripts.length > 0);

  const referenced = new Set();
  const collect = (v) => {
    if (typeof v === 'string') {
      if (/\.(js|css|html|json|png|svg)$/i.test(v) && !/^https?:/i.test(v)) referenced.add(v);
    } else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === 'object') Object.values(v).forEach(collect);
  };
  collect(manifest);
  // 语言包目录也要检查
  referenced.add('_locales/zh_CN/messages.json');

  const missing = [...referenced].filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
  check(`清单引用的 ${referenced.size} 个文件全部存在`, missing.length === 0, missing.join(', '));

  // 图标必须是 PNG（Edge 工具栏不渲染 SVG）
  const iconFiles = Object.values(manifest.icons || {});
  check('图标使用 PNG 格式（Edge 工具栏兼容）', iconFiles.every((f) => /\.png$/i.test(f)), iconFiles.join(', '));

  // permissions 是否覆盖用到的 API
  const perms = manifest.permissions || [];
  const usedApis = [];
  const allSource = ['background.js', 'content/content.js', 'popup/popup.js', 'options/options.js']
    .filter((f) => fs.existsSync(path.join(ROOT, f)))
    .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'))
    .join('\n');
  [['chrome.notifications', 'notifications'], ['chrome.contextMenus', 'contextMenus'],
   ['chrome.scripting', 'scripting'], ['chrome.storage', 'storage']].forEach(([api, perm]) => {
    if (allSource.includes(api) && !perms.includes(perm)) usedApis.push(perm);
  });
  check('代码用到的 API 都已在 permissions 中声明', usedApis.length === 0, '缺少: ' + usedApis.join(', '));

  // storage.session 需要 storage 权限即可，但 Chrome 102+ 才支持
  check('minimum_chrome_version 不低于 109', parseInt(manifest.minimum_chrome_version, 10) >= 109,
    String(manifest.minimum_chrome_version));
}

/* ================================================================== */
console.log('\n[2] 语言检测（lib/lang.js）');
/* ================================================================== */

const langSandbox = loadLib('lib/lang.js');
const Lang = langSandbox.SplitTranslateLang;
check('lib/lang.js 导出了 SplitTranslateLang', !!Lang);

const CASES = [
  ['en', 'The quick brown fox jumps over the lazy dog. This is a sample English paragraph for testing. It should be detected as English.'],
  ['fr', 'Le renard brun rapide saute par-dessus le chien paresseux. Ceci est un texte en français pour le test de détection.'],
  ['de', 'Der schnelle braune Fuchs springt über den faulen Hund. Dies ist ein deutscher Text für den Test.'],
  ['es', 'El rápido zorro marrón salta sobre el perro perezoso. Este es un texto en español para la prueba.'],
  ['ja', 'これは日本語のテキストです。ひらがなとカタカナが含まれているので、中国語とは区別できます。'],
  ['ko', '이것은 한국어 텍스트입니다. 한글 음절이 포함되어 있어 중국어와 구별됩니다.'],
  ['ru', 'Это русский текст для проверки определения языка. Он содержит кириллические символы.'],
  ['zh_Hans', '这是一个用于测试的中文段落，包含简体字，应该被识别为简体中文而不是其他语言。'],
  ['zh_Hant', '這是一個用於測試的中文段落，包含繁體字，應該被識別為繁體中文。']
];

CASES.forEach(([expected, text]) => {
  const r = Lang.detectText(text);
  const ok = expected === 'en'
    ? r.code === 'en' || (!r.isChinese && r.code !== 'und')
    : r.code === expected;
  check(`「${text.slice(0, 14)}…」→ ${expected}（实际 ${r.code}, ${r.name}, 置信度 ${r.confidence.toFixed(2)}）`, ok);
});

check('繁体判定为正体之外的 zh_Hant', Lang.detectText(CASES[8][1]).code === 'zh_Hant');
check('isSimplifiedChinese 对简体为 true', Lang.detectText(CASES[7][1]).isSimplifiedChinese === true);
check('isSimplifiedChinese 对英文为 false', Lang.detectText(CASES[0][1]).isSimplifiedChinese === false);
check('shouldTranslate(日文) === true', Lang.shouldTranslate(Lang.detectText(CASES[4][1])) === true);
check('shouldTranslate(简体) === false', Lang.shouldTranslate(Lang.detectText(CASES[7][1])) === false);
check('shouldTranslate(繁体) === true', Lang.shouldTranslate(Lang.detectText(CASES[8][1])) === true);

// <html lang> 提示
check('normalizeLangCode("zh-TW") === "zh_Hant"', Lang.normalizeLangCode('zh-TW') === 'zh_Hant');
check('normalizeLangCode("en-US") === "en"', Lang.normalizeLangCode('en-US') === 'en');
check('normalizeLangCode("zh-CN") === "zh_Hans"', Lang.normalizeLangCode('zh-CN') === 'zh_Hans');

// 短文本 + 提示
const shortRes = Lang.detectText('OK', 'fr');
check('短文本时回退到 html lang 提示', shortRes.code === 'fr', shortRes.code);

/* ================================================================== */
console.log('\n[3] 翻译结果解析（lib/engine.js）');
/* ================================================================== */

const engineSandbox = loadLib('lib/engine.js');
const Engine = engineSandbox.SplitTranslate;
check('lib/engine.js 导出了 SplitTranslate', !!Engine);
check('预设包含 deepseek', !!(Engine.PROVIDER_PRESETS && Engine.PROVIDER_PRESETS.deepseek));
check('预设包含 minimax', !!(Engine.PROVIDER_PRESETS && Engine.PROVIDER_PRESETS.minimax));

if (Engine.PROVIDER_PRESETS) {
  const dp = Engine.PROVIDER_PRESETS.deepseek;
  check('DeepSeek 预设 baseURL 正确', dp.baseURL === 'https://api.deepseek.com/v1', dp.baseURL);
  check('DeepSeek 预设 model 正确', dp.model === 'deepseek-chat', dp.model);
  const mm = Engine.PROVIDER_PRESETS.minimax;
  check('MiniMax 预设 baseURL 正确', mm.baseURL === 'https://api.minimax.cn/v1', mm.baseURL);
  check('MiniMax 预设 model 正确', mm.model === 'MiniMax-M3', mm.model);
}

const PARSE_CASES = [
  ['纯 JSON 数组', '["你好","世界"]', 2],
  ['带 Markdown 代码块', '```json\n["你好","世界"]\n```', 2],
  ['带前后说明文字', '好的，以下是译文：\n["你好","世界"]', 2],
  ['对象包裹', '{"translations":["你好","世界"]}', 2],
  ['逐行输出兜底', '1. 你好\n2. 世界', 2],
  ['含换行与转义', '["第一行\\n第二行","带\\"引号\\""]', 2]
];
PARSE_CASES.forEach(([name, raw, expected]) => {
  const arr = Engine.parseArrayResponse(raw, expected);
  check(`解析：${name}`, arr.length === expected, `得到 ${arr.length} 项：${JSON.stringify(arr).slice(0, 60)}`);
});

check('parseArrayResponse 对空输入返回空数组', Engine.parseArrayResponse('', 2).length === 0);
check('joinEndpoint 自动补 /chat/completions',
  Engine.joinEndpoint('https://api.deepseek.com/v1') === 'https://api.deepseek.com/v1/chat/completions');
check('joinEndpoint 不重复补全',
  Engine.joinEndpoint('https://x.com/v1/chat/completions') === 'https://x.com/v1/chat/completions');
check('joinEndpoint 去掉尾部斜杠',
  Engine.joinEndpoint('https://x.com/v1///') === 'https://x.com/v1/chat/completions');

/* ---- 设置规范化 ---- */
const norm = Engine.normalizeSettings({ batchSize: 999, defaultRatio: 200, temperature: 5, autoMode: 'auto' });
check('batchSize 被夹到上限 50', norm.batchSize === 50, String(norm.batchSize));
check('defaultRatio 被夹到上限 80', norm.defaultRatio === 80, String(norm.defaultRatio));
check('temperature 被夹到上限 2', norm.temperature === 2, String(norm.temperature));
check('未填 OCR 配置时 ocrEnabled 自动为 false',
  Engine.normalizeSettings({ ocrEnabled: true }).ocrEnabled === false);

const norm2 = Engine.normalizeSettings({
  ocrEnabled: true, ocrBaseURL: 'https://api.siliconflow.cn/v1', ocrModel: 'Qwen/Qwen2.5-VL-7B-Instruct'
});
check('填全 OCR 配置后 ocrEnabled 为 true', norm2.ocrEnabled === true);
check('excludeList 被解析成数组',
  Array.isArray(norm2.excludePatterns) && norm2.excludePatterns.includes('mail.google.com'),
  JSON.stringify(norm2.excludePatterns));
check('默认不排除 localhost（由语言检测自行判断）',
  Engine.normalizeSettings({}).excludePatterns.indexOf('localhost') < 0,
  JSON.stringify(Engine.normalizeSettings({}).excludePatterns));
check('自定义 localhost 排除项生效',
  Engine.isExcluded('http://localhost:3000/', Engine.normalizeSettings({ excludeList: 'localhost' })) === true);

/* ---- 排除名单 ---- */
check('isExcluded 拦截 chrome:// 页面', Engine.isExcluded('chrome://settings', norm) === true);
check('isExcluded 拦截 edge:// 页面', Engine.isExcluded('edge://extensions', norm) === true);
check('isExcluded 放行普通 https 页面', Engine.isExcluded('https://example.com/article', norm) === false);
check('isExcluded 命中自定义关键词', Engine.isExcluded('https://mail.google.com/mail', norm) === true);
check('isExcluded 拦截扩展商店', Engine.isExcluded('https://chrome.google.com/webstore/x', norm) === true);

/* ---- 缓存 key ---- */
const s1 = Engine.normalizeSettings({ provider: 'deepseek', baseURL: 'https://a/v1', model: 'm1', targetLang: 'zh-CN' });
const s2 = Engine.normalizeSettings({ provider: 'deepseek', baseURL: 'https://a/v1', model: 'm2', targetLang: 'zh-CN' });
const s3 = Engine.normalizeSettings({ provider: 'deepseek', baseURL: 'https://a/v1', model: 'm1', targetLang: 'zh-TW' });
check('缓存 key 随模型变化', Engine.cacheKey('hello', s1) !== Engine.cacheKey('hello', s2));
check('缓存 key 随目标语言变化', Engine.cacheKey('hello', s1) !== Engine.cacheKey('hello', s3));
check('缓存 key 对相同输入稳定', Engine.cacheKey('hello', s1) === Engine.cacheKey('hello', s1));

/* ---- 新增：版面 / 思考强度 / 译文栏交互 相关设置 ---- */
const def = Engine.normalizeSettings({});
check('默认版面为原文在左', def.layout === 'original-left', def.layout);
check('默认不自动打开独立小窗', def.detachWindow === false, String(def.detachWindow));
check('默认显示原文/译文角标', def.showPaneBadge === true, String(def.showPaneBadge));
check('默认开启悬停高亮原文', def.highlightOriginal === true, String(def.highlightOriginal));
check('默认不发送 reasoning_effort', def.reasoningEffort === '', JSON.stringify(def.reasoningEffort));

const LAYOUTS = ['original-left', 'original-right', 'original-top', 'original-bottom'];
LAYOUTS.forEach((l) => {
  check(`版面 ${l} 被接受`, Engine.normalizeSettings({ layout: l }).layout === l);
});
check('非法版面回退为 original-left',
  Engine.normalizeSettings({ layout: 'diagonal' }).layout === 'original-left',
  Engine.normalizeSettings({ layout: 'diagonal' }).layout);

check('思考强度 low 被接受', Engine.normalizeSettings({ reasoningEffort: 'low' }).reasoningEffort === 'low');
check('思考强度 high 被接受', Engine.normalizeSettings({ reasoningEffort: 'high' }).reasoningEffort === 'high');
check('非法思考强度被清空',
  Engine.normalizeSettings({ reasoningEffort: 'ultra' }).reasoningEffort === '',
  JSON.stringify(Engine.normalizeSettings({ reasoningEffort: 'ultra' }).reasoningEffort));
check('思考强度 auto 也归为不发送',
  Engine.normalizeSettings({ reasoningEffort: 'auto' }).reasoningEffort === '');

/* ================================================================== */
console.log('\n[3.5] 语言误判回归（NVIDIA 中文站被判成韩语）');
/* ================================================================== */

const dom = (c) => Lang.dominantScript(c);
check('中文正文 + 少量韩文选项 → 判中文',
  dom({ han: 800, hangul: 30, kana: 0, latin: 50 }).code === 'zh',
  JSON.stringify(dom({ han: 800, hangul: 30, kana: 0, latin: 50 })));
check('真韩文页面（谚文远多于汉字）→ 判韩语',
  dom({ han: 20, hangul: 500 }).code === 'ko', JSON.stringify(dom({ han: 20, hangul: 500 })));
check('纯韩文页面 → 判韩语',
  dom({ han: 0, hangul: 300 }).code === 'ko', JSON.stringify(dom({ han: 0, hangul: 300 })));
check('谚文略多于汉字 → 判韩语',
  dom({ han: 100, hangul: 120 }).code === 'ko', JSON.stringify(dom({ han: 100, hangul: 120 })));
check('日文（假名 + 汉字）→ 判日语',
  dom({ han: 100, kana: 200 }).code === 'ja', JSON.stringify(dom({ han: 100, kana: 200 })));
check('纯中文 → 判中文', dom({ han: 400 }).code === 'zh');
check('纯英文 → 判英语', dom({ latin: 400 }).code === 'en');
check('空统计 → 返回 null', dom({}) === null);

check('声明简体中文 + 大量汉字 → 不冲突',
  Lang.declarationConflicts({ declared: 'zh_Hans', hanCount: 800, hangulCount: 30, kanaCount: 0, script: 'han' }) === false);
check('声明简体中文但页面几乎没有汉字 → 冲突，不采信声明',
  Lang.declarationConflicts({ declared: 'zh_Hans', hanCount: 2, hangulCount: 0, script: 'latin' }) === true);
check('声明韩语但谚文极少 → 冲突',
  Lang.declarationConflicts({ declared: 'ko', hanCount: 500, hangulCount: 0, script: 'han' }) === true);
check('声明日语但既无假名也无汉字 → 冲突',
  Lang.declarationConflicts({ declared: 'ja', hanCount: 0, kanaCount: 0, script: 'latin' }) === true);

check('shouldTranslate：声明简体中文且统计支持 → 不翻译（该误判的直接后果）',
  Lang.shouldTranslate({
    code: 'ko', declared: 'zh_Hans', hanCount: 800, hangulCount: 30, kanaCount: 0,
    isChinese: false, isSimplifiedChinese: false
  }) === false);
check('shouldTranslate：声明简体中文但统计不支持 → 按检测结果翻译',
  Lang.shouldTranslate({
    code: 'en', declared: 'zh_Hans', hanCount: 2, hangulCount: 0, kanaCount: 0,
    isChinese: false, isSimplifiedChinese: false
  }) === true);
check('shouldTranslate：韩文页面 → 翻译',
  Lang.shouldTranslate({ code: 'ko', declared: 'ko', hanCount: 20, hangulCount: 500, isSimplifiedChinese: false }) === true);
check('shouldTranslate：繁体中文页面 → 翻译',
  Lang.shouldTranslate({ code: 'zh_Hant', declared: 'zh-Hant', hanCount: 500, isSimplifiedChinese: false }) === true);
check('shouldTranslate：无声明英文页面 → 翻译',
  Lang.shouldTranslate({ code: 'en', declared: '', isSimplifiedChinese: false }) === true);

check('languageDetect 默认 local', Engine.normalizeSettings({}).languageDetect === 'local');
check('languageDetect 接受 local-api',
  Engine.normalizeSettings({ languageDetect: 'local-api' }).languageDetect === 'local-api');
check('languageDetect 接受 api', Engine.normalizeSettings({ languageDetect: 'api' }).languageDetect === 'api');
check('languageDetect 非法值回退 local',
  Engine.normalizeSettings({ languageDetect: 'magic' }).languageDetect === 'local');

const normCode = Engine.normalizeDetectedCode;
check('归一化 "zh-CN" → zh_Hans', normCode('zh-CN') === 'zh_Hans', normCode('zh-CN'));
check('归一化 "zh-TW" → zh_Hant', normCode('zh-TW') === 'zh_Hant', normCode('zh-TW'));
check('归一化 "ZH_cn" → zh_Hans', normCode('ZH_cn') === 'zh_Hans', normCode('ZH_cn'));
check('归一化 "简体中文" → zh_Hans', normCode('简体中文') === 'zh_Hans', normCode('简体中文'));
check('归一化 "繁体中文" → zh_Hant', normCode('繁体中文') === 'zh_Hant', normCode('繁体中文'));
check('归一化 "韩语" → ko', normCode('韩语') === 'ko', normCode('韩语'));
check('归一化 "en" → en', normCode('en') === 'en');
check('归一化 "ko-KR" → ko', normCode('ko-KR') === 'ko', normCode('ko-KR'));
check('归一化空输入 → 空串', normCode('') === '');

/* ================================================================== */
console.log('\n[4] 前端页面引用检查');
/* ================================================================== */

const HTML_CHECKS = [
  ['popup/popup.html', ['popup.css', '../lib/lang.js', '../lib/engine.js', 'popup.js'],
    ['btnMain', 'btnRestore', 'btnRetranslate', 'btnOptions', 'ratio', 'autoMode', 'readingStyle', 'ocrEnabled',
     'layoutGrid', 'layoutText', 'btnDetach', 'detachHint']],
  ['options/options.html', ['options.css', '../lib/lang.js', '../lib/engine.js', 'options.js'],
    ['provider', 'baseURL', 'apiKey', 'model', 'autoMode', 'excludeList', 'ocrEnabled', 'ocrBaseURL',
     'ocrApiKey', 'ocrModel', 'ocrPrompt', 'btnSave', 'btnTest', 'btnTestVision', 'btnCacheClear',
     'reasoningEffort', 'layout', 'showPaneBadge', 'highlightOriginal', 'detachWindow']]
];

HTML_CHECKS.forEach(([file, scripts, ids]) => {
  const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
  scripts.forEach((s) => {
    check(`${file} 引用了 ${s}`, html.includes(s));
  });
  ids.forEach((id) => {
    check(`${file} 含元素 #${id}`, html.includes(`id="${id}"`));
  });
});

// options.js 中 FIELDS 的每个 key 都必须在 HTML 里有对应元素
const optionsHtml = fs.readFileSync(path.join(ROOT, 'options/options.html'), 'utf8');
const optionsJs = fs.readFileSync(path.join(ROOT, 'options/options.js'), 'utf8');
const fieldKeys = [...optionsJs.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*):\s*'(string|int|float|bool)',/gm)].map((m) => m[1]);
const missingIds = fieldKeys.filter((k) => !optionsHtml.includes(`id="${k}"`));
check(`options.js 的 ${fieldKeys.length} 个字段都有对应表单元素`, missingIds.length === 0, missingIds.join(', '));

// 每个 FIELDS key 也应当在 DEFAULT_SETTINGS 里
const missingDefaults = fieldKeys.filter((k) => !(k in Engine.DEFAULT_SETTINGS));
check('options.js 的字段都能在 DEFAULT_SETTINGS 找到', missingDefaults.length === 0, missingDefaults.join(', '));

/* ================================================================== */
console.log('\n[5] content script 结构检查');
/* ================================================================== */

const contentJs = fs.readFileSync(path.join(ROOT, 'content/content.js'), 'utf8');
const contentCss = fs.readFileSync(path.join(ROOT, 'content/content.css'), 'utf8');

check('content.js 有重复注入保护', contentJs.includes('__SPLIT_TRANSLATE_LOADED__'));
check('content.js 注册了 onMessage 监听', contentJs.includes('chrome.runtime.onMessage.addListener'));
check('content.js 使用 deep clone 构建镜像', contentJs.includes('cloneNode(true)'));
check('content.js 支持拖动分隔线', contentJs.includes('col-resize') || contentJs.includes('initDrag'));
check('content.js 有 MutationObserver（动态内容）', contentJs.includes('new MutationObserver'));
check('content.js 提供 RESTORE', contentJs.includes("case 'RESTORE'"));
check('content.js 提供 TRANSLATE', contentJs.includes("case 'TRANSLATE'"));
check('content.js 支持四种版面', contentJs.includes('original-bottom') && contentJs.includes('applyLayout'));
check('content.js 译文栏链接可点击（不再一律 preventDefault）',
  contentJs.includes('onCloneClick') && contentJs.includes("type: 'NAVIGATE'"));
check('content.js 提供独立小窗能力', contentJs.includes('documentPictureInPicture'));
check('content.js 提供 SET_LAYOUT / DETACH 指令',
  contentJs.includes("case 'SET_LAYOUT'") && contentJs.includes("case 'DETACH'"));

// background 必须在 NAVIGATE 里做协议白名单校验
const bgSource = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
check('background 校验 NAVIGATE 只允许 http/https',
  bgSource.includes("case 'NAVIGATE'") && bgSource.includes('只允许打开 http/https 链接'));
check('background 支持把未处理消息转发给内容脚本', bgSource.includes('fromContentScript'));
check('background 的 TAB_ACTION 会透传 layout 参数', bgSource.includes("'layout'"));

// engine 必须在接口返回不支持 reasoning_effort 时自动降级重试
const engineSource = fs.readFileSync(path.join(ROOT, 'lib/engine.js'), 'utf8');
check('engine 会发送 reasoning_effort', engineSource.includes('body.reasoning_effort = reasoningEffort'));
check('engine 在不支持 reasoning_effort 时自动去掉参数重试',
  /reasoning_effort/.test(engineSource) && engineSource.includes('已自动去掉该参数重试'));

// CSS 里被 JS 使用的关键类名必须存在
const cssClasses = [
  'split-translate-root', 'st-pane-original', 'st-pane-translated', 'st-divider',
  'st-banner', 'st-statusbar', 'st-toast', 'st-imgnote', 'st-reading', 'st-progress',
  'st-pane-badge', 'st-hover-origin', 'st-detached'
];
const missingCss = cssClasses.filter((c) => !contentCss.includes('.' + c));
check(`content.css 覆盖了 ${cssClasses.length} 个关键类名`, missingCss.length === 0, missingCss.join(', '));
check('content.css 支持上下版面（column + row-resize）',
  contentCss.includes('data-stt-layout="original-top"') && contentCss.includes('row-resize'));

// background 中 importScripts 的文件必须存在
const imports = [...bgSource.matchAll(/importScripts\(([^)]*)\)/g)]
  .flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
check(`background.js 的 importScripts 目标都存在（${imports.join(', ')}）`,
  imports.every((f) => fs.existsSync(path.join(ROOT, f))));

// manifest 里 content_scripts 的 js 顺序必须让依赖先加载
const cs = manifest && manifest.content_scripts && manifest.content_scripts[0];
if (cs) {
  const order = cs.js || [];
  check('content_scripts 中 lang.js 在 content.js 之前',
    order.indexOf('lib/lang.js') < order.indexOf('content/content.js'), order.join(' → '));
  check('content_scripts 中 engine.js 在 content.js 之前',
    order.indexOf('lib/engine.js') < order.indexOf('content/content.js'), order.join(' → '));
}

/* ================================================================== */
console.log(`\n结果：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
