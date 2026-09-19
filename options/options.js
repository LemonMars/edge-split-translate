/**
 * options/options.js —— 设置页逻辑
 */

const Engine = self.SplitTranslate;

/** 表单字段 → 设置项 的映射（含类型转换） */
const FIELDS = {
  provider: 'string',
  baseURL: 'string',
  apiKey: 'string',
  model: 'string',
  reasoningEffort: 'string',
  temperature: 'float',
  batchSize: 'int',
  batchChars: 'int',
  targetLang: 'string',
  languageDetect: 'string',
  autoMode: 'string',
  minConfidence: 'float',
  excludeList: 'string',
  autoTranslateDynamic: 'bool',
  layout: 'string',
  showPaneBadge: 'bool',
  highlightOriginal: 'bool',
  detachWindow: 'bool',
  showBanner: 'bool',
  showDivider: 'bool',
  syncScroll: 'bool',
  showStatusBar: 'bool',
  showOriginalOnHover: 'bool',
  readingStyle: 'bool',
  defaultRatio: 'int',
  fontSize: 'int',
  lineHeight: 'float',
  ocrEnabled: 'bool',
  ocrBaseURL: 'string',
  ocrApiKey: 'string',
  ocrModel: 'string',
  ocrPrompt: 'string'
};

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ */
/* 提示                                                                */
/* ------------------------------------------------------------------ */

let toastTimer = null;
function toast(msg, kind, ms) {
  const box = $('toast');
  box.textContent = msg;
  box.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.className = 'toast'; }, ms || 2600);
}

function showResult(id, ok, msg) {
  const box = $(id);
  box.className = 'test-result ' + (ok ? 'ok' : 'err');
  box.textContent = (ok ? '✓ ' : '✗ ') + msg;
}

/* ------------------------------------------------------------------ */
/* 与 background 通信                                                  */
/* ------------------------------------------------------------------ */

function bg(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) return resolve({ ok: false, error: err.message });
      resolve(resp || { ok: false, error: '无响应' });
    });
  });
}

/* ------------------------------------------------------------------ */
/* 表单读写                                                            */
/* ------------------------------------------------------------------ */

function fillForm(s) {
  Object.keys(FIELDS).forEach((key) => {
    const el = $(key);
    if (!el) return;
    const type = FIELDS[key];
    if (type === 'bool') el.checked = !!s[key];
    else el.value = s[key] == null ? '' : String(s[key]);
  });
  updateProviderDoc();
  updateOcrHint();
}

function readForm() {
  const out = {};
  Object.keys(FIELDS).forEach((key) => {
    const el = $(key);
    if (!el) return;
    const type = FIELDS[key];
    if (type === 'bool') out[key] = !!el.checked;
    else if (type === 'int') out[key] = parseInt(el.value, 10) || 0;
    else if (type === 'float') out[key] = parseFloat(el.value);
    else out[key] = el.value;
  });
  return out;
}

/** 表单值 + 已存设置合并成一份完整配置（用于测试连接） */
function currentSettings() {
  return Engine.normalizeSettings(Object.assign({}, settings, readForm()));
}

/* ------------------------------------------------------------------ */
/* 服务商预设                                                          */
/* ------------------------------------------------------------------ */

function buildProviderSelect() {
  const sel = $('provider');
  sel.innerHTML = '';
  Object.keys(Engine.PROVIDER_PRESETS).forEach((key) => {
    const p = Engine.PROVIDER_PRESETS[key];
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = p.label;
    sel.appendChild(opt);
  });
}

function updateProviderDoc() {
  const key = $('provider').value;
  const preset = Engine.PROVIDER_PRESETS[key] || {};
  const link = $('providerDoc');
  if (preset.doc) {
    link.href = preset.doc;
    link.classList.remove('hidden');
  } else {
    link.classList.add('hidden');
  }
}

/** 用户手动改了 URL/模型 → 自动切到「自定义」 */
function markCustomIfNeeded() {
  const key = $('provider').value;
  const preset = Engine.PROVIDER_PRESETS[key];
  if (!preset || key === 'custom') return;
  const changed = ($('baseURL').value.trim() !== preset.baseURL) || ($('model').value.trim() !== preset.model);
  if (changed) {
    $('provider').value = 'custom';
    updateProviderDoc();
  }
}

function updateOcrHint() {
  const on = $('ocrEnabled').checked;
  ['ocrBaseURL', 'ocrApiKey', 'ocrModel', 'ocrPrompt'].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = false; // 始终可编辑，只是未勾选时不生效
    if (el) el.parentElement.classList.toggle('dim', !on);
  });
}

/* ------------------------------------------------------------------ */
/* 加载 / 保存                                                         */
/* ------------------------------------------------------------------ */

let settings = Engine.normalizeSettings({});

async function load() {
  const resp = await bg({ type: 'GET_SETTINGS' });
  settings = (resp && resp.settings) || Engine.normalizeSettings({});
  buildProviderSelect();
  fillForm(settings);
  refreshCacheStats();
}

async function save(quiet) {
  markCustomIfNeeded();
  const patch = readForm();
  const resp = await bg({ type: 'SAVE_SETTINGS', settings: patch });
  if (!resp || !resp.ok) {
    toast('保存失败：' + ((resp && resp.error) || '未知错误'), 'err');
    return false;
  }
  settings = resp.settings;
  fillForm(settings);
  if (!quiet) toast('设置已保存', 'ok');
  return true;
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                            */
/* ------------------------------------------------------------------ */

function bindEvents() {
  // ---- 服务商切换：套用预设 ----
  $('provider').addEventListener('change', () => {
    const key = $('provider').value;
    const preset = Engine.PROVIDER_PRESETS[key];
    if (preset && key !== 'custom') {
      $('baseURL').value = preset.baseURL;
      $('model').value = preset.model;
    }
    updateProviderDoc();
    $('testResult').className = 'test-result hidden';
  });

  // ---- 手动改 URL / 模型 → 切自定义 ----
  $('baseURL').addEventListener('input', markCustomIfNeeded);
  $('model').addEventListener('input', markCustomIfNeeded);

  // ---- 保存 ----
  $('btnSave').addEventListener('click', () => save());
  $('btnSave2').addEventListener('click', () => save());

  // ---- 显示 / 隐藏密钥 ----
  $('btnToggleKey').addEventListener('click', () => {
    const el = $('apiKey');
    const isPwd = el.type === 'password';
    el.type = isPwd ? 'text' : 'password';
    $('btnToggleKey').textContent = isPwd ? '隐藏' : '显示';
  });

  // ---- 测试连接 ----
  $('btnTest').addEventListener('click', async () => {
    const s = currentSettings();
    if (!s.apiKey) return showResult('testResult', false, '请先填写 API Key');
    showResult('testResult', true, '正在请求接口…');
    $('testResult').className = 'test-result';
    $('btnTest').disabled = true;
    const resp = await bg({ type: 'TEST_CONNECTION', overrides: s });
    $('btnTest').disabled = false;
    if (resp && resp.ok) {
      showResult('testResult', true, resp.message);
      toast('连接成功', 'ok');
    } else {
      showResult('testResult', false, (resp && resp.error) || '测试失败');
    }
  });

  // ---- 测试识别接口 ----
  $('btnTestVision').addEventListener('click', async () => {
    const s = currentSettings();
    if (!s.ocrBaseURL || !s.ocrModel) return showResult('visionResult', false, '请先填写识别接口的 Base URL 与模型名');
    $('btnTestVision').disabled = true;
    showResult('visionResult', true, '正在请求接口…');
    const resp = await bg({ type: 'TEST_CONNECTION', which: 'vision', overrides: s });
    $('btnTestVision').disabled = false;
    if (resp && resp.ok) showResult('visionResult', true, resp.message);
    else showResult('visionResult', false, (resp && resp.error) || '测试失败');
  });

  // ---- 拉取模型列表 ----
  $('btnModels').addEventListener('click', async () => {
    const s = currentSettings();
    if (!s.baseURL || !s.apiKey) return toast('请先填写 Base URL 与 API Key', 'err');
    $('btnModels').disabled = true;
    $('btnModels').textContent = '拉取中…';
    const resp = await bg({ type: 'FETCH_MODELS', overrides: s });
    $('btnModels').disabled = false;
    $('btnModels').textContent = '拉取列表';
    if (resp && resp.ok && resp.models && resp.models.length) {
      const list = $('modelList');
      list.innerHTML = '';
      resp.models.slice(0, 200).forEach((m) => {
        const o = document.createElement('option');
        o.value = m;
        list.appendChild(o);
      });
      toast('已拉取 ' + resp.models.length + ' 个模型，可在输入框下拉选择', 'ok', 3600);
    } else {
      toast('拉取失败：' + ((resp && resp.error) || '该服务商可能不支持 /models'), 'err', 3600);
    }
  });

  // ---- 缓存 ----
  $('btnCacheStats').addEventListener('click', refreshCacheStats);
  $('btnCacheClear').addEventListener('click', async () => {
    if (!confirm('确定清空全部翻译缓存？清空后相同内容会重新调用接口。')) return;
    await bg({ type: 'CACHE_CLEAR' });
    showResult('cacheResult', true, '缓存已清空');
    refreshCacheStats();
  });

  // ---- 导出 / 导入 ----
  $('btnExport').addEventListener('click', () => {
    const data = { type: 'split-translate-settings', version: 1, exportedAt: new Date().toISOString(), settings };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'split-translate-settings.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  });

  $('btnImport').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        const incoming = parsed.settings || parsed;
        if (!incoming || typeof incoming !== 'object') throw new Error('文件内容不是有效的设置对象');
        const resp = await bg({ type: 'SAVE_SETTINGS', settings: incoming });
        settings = resp.settings;
        fillForm(settings);
        toast('设置已导入', 'ok');
      } catch (err) {
        toast('导入失败：' + err.message, 'err', 4000);
      }
      e.target.value = '';
    };
    reader.readAsText(file, 'utf-8');
  });

  // ---- 恢复默认 ----
  $('btnReset').addEventListener('click', async () => {
    if (!confirm('恢复默认设置？API Key 也会被清空。')) return;
    const def = Object.assign({}, Engine.DEFAULT_SETTINGS);
    const resp = await bg({ type: 'SAVE_SETTINGS', settings: def });
    settings = resp.settings;
    fillForm(settings);
    toast('已恢复默认设置', 'ok');
  });

  // ---- 勾选识别开关时更新提示 ----
  $('ocrEnabled').addEventListener('change', updateOcrHint);

  // ---- 数字输入的即时校验 ----
  ['batchSize', 'batchChars', 'defaultRatio', 'fontSize'].forEach((id) => {
    $(id).addEventListener('blur', () => {
      const el = $(id);
      const v = parseInt(el.value, 10);
      if (isNaN(v)) el.value = String(Engine.DEFAULT_SETTINGS[id]);
    });
  });
}

async function refreshCacheStats() {
  const resp = await bg({ type: 'CACHE_STATS' });
  if (resp && resp.ok) {
    showResult('cacheResult', true, '当前缓存条目：' + resp.stats.count + ' 条（上限 3000 条，自动淘汰最久未用）');
  }
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

bindEvents();
load();
