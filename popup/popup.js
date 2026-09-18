/**
 * popup/popup.js —— 工具栏弹窗逻辑
 */

const Engine = self.SplitTranslate;

const dom = {
  provider: document.getElementById('provider'),
  lang: document.getElementById('lang'),
  status: document.getElementById('status'),
  progressWrap: document.getElementById('progressWrap'),
  progress: document.getElementById('progress'),
  error: document.getElementById('error'),
  btnMain: document.getElementById('btnMain'),
  btnMainText: document.getElementById('btnMainText'),
  btnRestore: document.getElementById('btnRestore'),
  btnRetranslate: document.getElementById('btnRetranslate'),
  btnOptions: document.getElementById('btnOptions'),
  ratio: document.getElementById('ratio'),
  ratioText: document.getElementById('ratioText'),
  layoutGrid: document.getElementById('layoutGrid'),
  layoutText: document.getElementById('layoutText'),
  btnDetach: document.getElementById('btnDetach'),
  detachHint: document.getElementById('detachHint'),
  autoMode: document.getElementById('autoMode'),
  readingStyle: document.getElementById('readingStyle'),
  ocrEnabled: document.getElementById('ocrEnabled'),
  ocrHint: document.getElementById('ocrHint'),
  tip: document.getElementById('tip')
};

let tabId = null;
let settings = null;
let pageState = null;
let pollTimer = null;

const LAYOUT_LABEL = {
  'original-left': '左侧',
  'original-right': '右侧',
  'original-top': '上侧',
  'original-bottom': '下侧'
};

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
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

function renderProvider() {
  if (!settings) return;
  const preset = Engine.PROVIDER_PRESETS[settings.provider] || {};
  const label = preset.label || settings.provider;
  dom.provider.textContent = label + ' · ' + (settings.model || '未设置模型') +
    (settings.apiKey ? '' : ' · 缺少 API Key');
  dom.provider.classList.toggle('warn', !settings.apiKey);
}

function renderState() {
  const st = pageState;
  if (!st) {
    dom.lang.textContent = '不可用（浏览器内置页面）';
    dom.status.textContent = '—';
    dom.btnMain.disabled = true;
    dom.btnMainText.textContent = '当前页面不支持翻译';
    dom.btnRestore.disabled = true;
    dom.btnRetranslate.disabled = true;
    dom.progressWrap.classList.add('hidden');
    return;
  }

  // 语言
  if (st.detection) {
    const d = st.detection;
    const conf = d.confidence != null ? '（置信度 ' + Math.round(d.confidence * 100) + '%）' : '';
    dom.lang.textContent = d.name + conf;
    dom.lang.classList.toggle('ok', !!d.isSimplifiedChinese);
  } else {
    dom.lang.textContent = '检测中…';
  }

  // 状态
  if (st.translating) {
    dom.status.textContent = `翻译中 ${st.done || 0} / ${st.total || 0} 段`;
    dom.btnMainText.textContent = '正在翻译…';
    dom.btnMain.disabled = true;
  } else if (st.splitActive) {
    dom.status.textContent = `分屏对照中 · 已翻译 ${st.total || 0} 段`;
    dom.btnMainText.textContent = '已开启分屏翻译';
    dom.btnMain.disabled = true;
  } else {
    dom.status.textContent = '未翻译';
    dom.btnMainText.textContent = st.detection && st.detection.isSimplifiedChinese ? '当前已是简体中文，仍然翻译' : '开始分屏翻译';
    dom.btnMain.disabled = false;
  }

  dom.btnRestore.disabled = !st.splitActive;
  dom.btnRetranslate.disabled = !st.splitActive || !!st.translating;

  // 进度条
  if (st.splitActive && st.total) {
    const pct = Math.min(100, Math.round(((st.done || 0) / st.total) * 100));
    dom.progressWrap.classList.remove('hidden');
    dom.progress.style.width = pct + '%';
  } else {
    dom.progressWrap.classList.add('hidden');
  }

  // 错误
  if (st.error) {
    dom.error.textContent = '⚠ ' + st.error;
    dom.error.classList.remove('hidden');
  } else {
    dom.error.classList.add('hidden');
  }

  // 比例
  if (st.ratio) {
    dom.ratio.value = String(st.ratio);
    dom.ratioText.textContent = st.ratio + ' : ' + (100 - st.ratio);
  }

  // 版面
  const layout = st.layout || (settings && settings.layout) || 'original-left';
  dom.layoutText.textContent = LAYOUT_LABEL[layout] || '左侧';
  dom.layoutGrid.querySelectorAll('.layout-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.layout === layout);
  });

  // 独立小窗按钮
  if (st.detached) {
    dom.btnDetach.textContent = '收回译文';
    dom.btnDetach.disabled = false;
  } else {
    dom.btnDetach.textContent = '独立小窗';
    dom.btnDetach.disabled = !st.splitActive;
  }
  dom.detachHint.classList.toggle('hidden', st.detachSupported !== false);
}

function renderSettings() {
  if (!settings) return;
  dom.autoMode.value = settings.autoMode;
  dom.readingStyle.checked = !!settings.readingStyle;
  dom.ocrEnabled.checked = !!settings.ocrEnabled;
  dom.ocrHint.classList.toggle('hidden', !!settings.ocrEnabled);
  dom.ratio.value = String(settings.defaultRatio || 50);
  dom.ratioText.textContent = (settings.defaultRatio || 50) + ' : ' + (100 - (settings.defaultRatio || 50));
}

/* ------------------------------------------------------------------ */
/* 数据加载                                                            */
/* ------------------------------------------------------------------ */

async function refreshState(showSpinner) {
  const resp = await bg({ type: 'GET_TAB_STATE', tabId });
  if (resp && resp.ok) {
    pageState = resp.state;
  } else {
    pageState = null;
  }
  renderState();
  return pageState;
}

async function init() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  tabId = tab ? tab.id : null;

  const sResp = await bg({ type: 'GET_SETTINGS' });
  settings = (sResp && sResp.settings) || Engine.normalizeSettings({});
  renderProvider();
  renderSettings();

  await refreshState();

  // 翻译进行中时轮询刷新，让进度动起来
  pollTimer = setInterval(async () => {
    if (!pageState || pageState.translating) await refreshState();
  }, 900);
}

/* ------------------------------------------------------------------ */
/* 事件                                                                */
/* ------------------------------------------------------------------ */

async function doAction(action) {
  if (tabId == null) return;
  dom.btnMain.disabled = true;
  const resp = await bg({ type: 'TAB_ACTION', tabId, action, ratio: parseInt(dom.ratio.value, 10) });
  if (!resp || !resp.ok) {
    dom.error.textContent = '⚠ ' + ((resp && resp.error) || '操作失败');
    dom.error.classList.remove('hidden');
    dom.btnMain.disabled = false;
    return;
  }
  await refreshState();
}

dom.btnMain.addEventListener('click', () => doAction('TRANSLATE'));
dom.btnRestore.addEventListener('click', () => doAction('RESTORE'));
dom.btnRetranslate.addEventListener('click', () => doAction('RETRANSLATE'));

// 独立小窗：开 / 关
dom.btnDetach.addEventListener('click', async () => {
  if (!pageState || !pageState.splitActive) return;
  const action = pageState.detached ? 'UNDETACH' : 'DETACH';
  const resp = await bg({ type: 'TAB_ACTION', tabId, action });
  if (resp && resp.ok && resp.result && resp.result.supported === false) {
    dom.detachHint.textContent = '当前浏览器不支持可交互小窗，已改用普通弹窗展示译文。';
    dom.detachHint.classList.remove('hidden');
  }
  await refreshState();
});

// 版面切换：立即生效并持久化
dom.layoutGrid.querySelectorAll('.layout-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const layout = btn.dataset.layout;
    dom.layoutGrid.querySelectorAll('.layout-btn').forEach((b) => b.classList.toggle('active', b === btn));
    dom.layoutText.textContent = LAYOUT_LABEL[layout] || '';
    if (tabId != null && pageState && pageState.splitActive) {
      await bg({ type: 'TAB_ACTION', tabId, action: 'SET_LAYOUT', layout });
    }
    const resp = await bg({ type: 'SAVE_SETTINGS', settings: { layout } });
    if (resp && resp.ok) settings = resp.settings;
  });
});

dom.btnOptions.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

// 拖动比例条：实时下发
let ratioTimer = null;
dom.ratio.addEventListener('input', () => {
  const v = parseInt(dom.ratio.value, 10);
  dom.ratioText.textContent = v + ' : ' + (100 - v);
  clearTimeout(ratioTimer);
  ratioTimer = setTimeout(() => {
    if (tabId != null && pageState && pageState.splitActive) {
      bg({ type: 'TAB_ACTION', tabId, action: 'SET_RATIO', ratio: v });
    }
  }, 120);
});

// 比例改动也持久化到设置里
dom.ratio.addEventListener('change', async () => {
  const v = parseInt(dom.ratio.value, 10);
  const resp = await bg({ type: 'SAVE_SETTINGS', settings: { defaultRatio: v } });
  if (resp && resp.ok) settings = resp.settings;
});

dom.autoMode.addEventListener('change', async () => {
  const resp = await bg({ type: 'SAVE_SETTINGS', settings: { autoMode: dom.autoMode.value } });
  if (resp && resp.ok) settings = resp.settings;
  if (dom.autoMode.value === 'auto' && pageState && !pageState.splitActive && tabId != null) {
    // 切到完全自动时，顺手把当前页面翻掉
    doAction('TRANSLATE');
  }
});

dom.readingStyle.addEventListener('change', async () => {
  const resp = await bg({ type: 'SAVE_SETTINGS', settings: { readingStyle: dom.readingStyle.checked } });
  if (resp && resp.ok) settings = resp.settings;
});

dom.ocrEnabled.addEventListener('change', async () => {
  dom.ocrHint.classList.toggle('hidden', dom.ocrEnabled.checked);
  const resp = await bg({ type: 'SAVE_SETTINGS', settings: { ocrEnabled: dom.ocrEnabled.checked } });
  if (resp && resp.ok) settings = resp.settings;
});

window.addEventListener('unload', () => clearInterval(pollTimer));

init();
