/**
 * background.js —— MV3 Service Worker
 *
 * 职责：
 *   1. 安装时写入默认设置、创建右键菜单；
 *   2. 统一转发 AI 请求（content script 直接 fetch 也可以，
 *      但集中在这里便于统一处理错误、缓存与跨域）；
 *   3. 维护每个标签页的运行状态（chrome.storage.session），供 popup 秒开读取；
 *   4. 响应 popup / options 的消息，必要时按需注入 content script。
 */
importScripts('lib/lang.js', 'lib/engine.js');

const Lang = self.SplitTranslateLang;
const Engine = self.SplitTranslate;

/* ------------------------------------------------------------------ */
/* 一、安装与生命周期                                                   */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(function (details) {
  Engine.getSettings(true).then(function (s) {
    // 首次安装：把默认设置落盘（保留用户已有配置）
    chrome.storage.local.get(Engine.STORAGE_SETTINGS, function (res) {
      if (!res || !res[Engine.STORAGE_SETTINGS]) {
        Engine.saveSettings(s);
      }
    });
  });
  createMenus();
  if (details && details.reason === 'install') {
    // 首次安装打开设置页，引导用户填 API Key
    chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') });
  }
});

chrome.runtime.onStartup.addListener(function () {
  createMenus();
});

// 设置变化时通知所有标签页，让已打开的页面实时生效
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local' || !changes[Engine.STORAGE_SETTINGS]) return;
  Engine.invalidateSettings();
  broadcast({ type: 'SETTINGS_CHANGED' });
});

function createMenus() {
  try {
    chrome.contextMenus.removeAll(function () {
      chrome.contextMenus.create({
        id: 'split-translate-page',
        title: '分屏翻译此页面',
        contexts: ['page']
      });
      chrome.contextMenus.create({
        id: 'split-translate-selection',
        title: '翻译选中文本为简体中文',
        contexts: ['selection']
      });
      chrome.contextMenus.create({
        id: 'split-translate-settings',
        title: '分屏翻译设置…',
        contexts: ['page', 'selection']
      });
    });
  } catch (e) { /* ignore */ }
}

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  if (!tab || !tab.id) return;
  if (info.menuItemId === 'split-translate-settings') {
    chrome.runtime.openOptionsPage();
    return;
  }
  ensureContentScript(tab.id)
    .then(function () {
      if (info.menuItemId === 'split-translate-selection' && info.selectionText) {
        // 划词翻译：把结果放到剪贴板不方便，改为直接弹出通知式翻译
        return translateSelection(tab, info.selectionText);
      }
      return sendToTab(tab.id, { type: 'TRANSLATE', reason: 'contextMenu' });
    })
    .catch(function (err) { console.warn('[分屏翻译]', err); });
});

/* ------------------------------------------------------------------ */
/* 二、工具函数                                                        */
/* ------------------------------------------------------------------ */

function broadcast(message) {
  chrome.tabs.query({}, function (tabs) {
    (tabs || []).forEach(function (tab) {
      if (!tab.id) return;
      chrome.tabs.sendMessage(tab.id, message, function () { void chrome.runtime.lastError; });
    });
  });
}

function sendToTab(tabId, message) {
  return new Promise(function (resolve, reject) {
    chrome.tabs.sendMessage(tabId, message, function (resp) {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(resp);
    });
  });
}

/** 判断 URL 是否可以注入脚本 */
function canInject(url) {
  return /^https?:\/\//i.test(url || '') || /^file:\/\//i.test(url || '');
}

/**
 * 确保目标标签页已经有 content script（popup 手点、右键菜单都会用到）
 */
function ensureContentScript(tabId) {
  return new Promise(function (resolve) {
    chrome.tabs.get(tabId, function (tab) {
      if (chrome.runtime.lastError || !tab) return resolve(null);
      if (!canInject(tab.url)) return resolve(null); // chrome:// 等受限页面
      // 先 ping，收不到再注入
      chrome.tabs.sendMessage(tabId, { type: 'PING' }, function (resp) {
        if (!chrome.runtime.lastError && resp) return resolve(resp);
        chrome.scripting.insertCSS({ target: { tabId: tabId }, files: ['content/content.css'] }, function () {
          void chrome.runtime.lastError;
          chrome.scripting.executeScript(
            { target: { tabId: tabId }, files: ['lib/lang.js', 'lib/engine.js', 'content/content.js'] },
            function () {
              const err = chrome.runtime.lastError;
              if (err) return resolve(null);
              setTimeout(function () {
                chrome.tabs.sendMessage(tabId, { type: 'PING' }, function (r2) {
                  resolve(chrome.runtime.lastError ? null : r2);
                });
              }, 120);
            }
          );
        });
      });
    });
  });
}

/** 划词翻译：用通知展示结果（不改动页面结构） */
function translateSelection(tab, text) {
  return Engine.getSettings(true).then(function (s) {
    if (!s.apiKey) throw new Error('未配置 API Key');
    return Engine.translateTexts([text], s).then(function (res) {
      const out = res.map[text] || text;
      chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.svg'),
        title: '译文（' + (s.model || '') + '）',
        message: out.slice(0, 900)
      });
      return out;
    });
  });
}

/** 运行状态：内存 + storage.session 双写 */
const stateMemo = new Map();

function setTabState(tabId, state) {
  stateMemo.set(tabId, state);
  const obj = {};
  obj[Engine.STORAGE_STATE_PREFIX + tabId] = state;
  try {
    chrome.storage.session.set(obj, function () { void chrome.runtime.lastError; });
  } catch (e) { /* ignore */ }
}

function getTabState(tabId) {
  if (stateMemo.has(tabId)) return Promise.resolve(stateMemo.get(tabId));
  return new Promise(function (resolve) {
    try {
      chrome.storage.session.get(Engine.STORAGE_STATE_PREFIX + tabId, function (res) {
        resolve((res && res[Engine.STORAGE_STATE_PREFIX + tabId]) || null);
      });
    } catch (e) { resolve(null); }
  });
}

chrome.tabs.onRemoved.addListener(function (tabId) {
  stateMemo.delete(tabId);
  try { chrome.storage.session.remove(Engine.STORAGE_STATE_PREFIX + tabId); } catch (e) { /* ignore */ }
});

/** 标签页 URL 变化时清空旧状态 */
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    stateMemo.delete(tabId);
    try { chrome.storage.session.remove(Engine.STORAGE_STATE_PREFIX + tabId); } catch (e) { /* ignore */ }
  }
});

/* ------------------------------------------------------------------ */
/* 三、消息路由                                                        */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return false;

  switch (msg.type) {
    /* ---- content script 上报运行状态 ---- */
    case 'STATE_CHANGED': {
      const tabId = sender && sender.tab && sender.tab.id;
      if (typeof tabId === 'number') {
        setTabState(tabId, Object.assign({}, msg.state, { tabId: tabId, updatedAt: Date.now() }));
      }
      return false;
    }

    /* ---- 翻译一批文本（content script 也可以自己 fetch，这里做代理）---- */
    case 'TRANSLATE_BATCH': {
      Engine.getSettings(true).then(function (s) {
        const merged = Object.assign({}, s, msg.overrides || {});
        return Engine.translateTexts(msg.texts || [], merged, { kind: msg.kind || 'tx' });
      }).then(function (res) {
        sendResponse({ ok: true, map: res.map, errors: res.errors });
      }).catch(function (err) {
        sendResponse({ ok: false, error: (err && err.message) || String(err) });
      });
      return true; // 异步响应
    }

    /* ---- 图片取字 ---- */
    case 'OCR_IMAGE': {
      Engine.getSettings(true).then(function (s) {
        return Engine.recognizeImage({ src: msg.src, alt: msg.alt }, s);
      }).then(function (text) {
        sendResponse({ ok: true, text: text });
      }).catch(function (err) {
        sendResponse({ ok: false, error: (err && err.message) || String(err) });
      });
      return true;
    }

    /* ---- 连通性测试 ---- */
    case 'TEST_CONNECTION': {
      Engine.getSettings(true).then(function (s) {
        return Engine.testConnection(Object.assign({}, s, msg.overrides || {}), msg.which);
      }).then(function (r) {
        sendResponse({ ok: true, message: r.message, ms: r.ms });
      }).catch(function (err) {
        sendResponse({ ok: false, error: (err && err.message) || String(err) });
      });
      return true;
    }

    /* ---- 拉取模型列表 ---- */
    case 'FETCH_MODELS': {
      Engine.getSettings(true).then(function (s) {
        return Engine.fetchModels(Object.assign({}, s, msg.overrides || {}));
      }).then(function (list) {
        sendResponse({ ok: true, models: list });
      }).catch(function (err) {
        sendResponse({ ok: false, error: (err && err.message) || String(err) });
      });
      return true;
    }

    /* ---- 缓存管理 ---- */
    case 'CACHE_CLEAR': {
      Engine.cacheClear().then(function () { sendResponse({ ok: true }); });
      return true;
    }
    case 'CACHE_STATS': {
      Engine.cacheStats().then(function (st) { sendResponse({ ok: true, stats: st }); });
      return true;
    }

    /* ---- 打开设置页 ---- */
    case 'OPEN_OPTIONS': {
      chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      return false;
    }

    /*
     * 译文栏里的链接点击 → 在这边真正执行导航。
     * content script 出于安全与权限考虑不能自己改标签页，统一交给 Service Worker。
     * 只允许 http/https，杜绝 javascript: / data: / file: 之类的注入面。
     */
    case 'NAVIGATE': {
      const tabId = (typeof msg.tabId === 'number' ? msg.tabId : null) ||
        (sender && sender.tab && sender.tab.id);
      const rawUrl = String(msg.url || '').trim();
      if (typeof tabId !== 'number') {
        sendResponse({ ok: false, error: '无法确定目标标签页' });
        return false;
      }
      if (!/^https?:\/\//i.test(rawUrl)) {
        sendResponse({ ok: false, error: '只允许打开 http/https 链接' });
        return false;
      }
      // 同站链接沿用当前标签页；外站或要求新窗口时新开标签页
      const openInNewTab = msg.disposition === 'newTab';
      if (openInNewTab) {
        chrome.tabs.create({ url: rawUrl, active: true }, function (tab) {
          void chrome.runtime.lastError;
          sendResponse({ ok: true, opened: 'newTab', tabId: tab && tab.id });
        });
      } else {
        chrome.tabs.update(tabId, { url: rawUrl }, function (tab) {
          const err = chrome.runtime.lastError;
          if (err) return sendResponse({ ok: false, error: err.message });
          sendResponse({ ok: true, opened: 'sameTab', tabId: tab && tab.id });
        });
      }
      return true;
    }

    /* ---- popup 请求：向页面下发动作 ---- */
    case 'TAB_ACTION': {
      // 优先使用消息里显式指定的 tabId（popup 会带上），否则回退到发送方所在标签页
      const tabId = (typeof msg.tabId === 'number' ? msg.tabId : null) ||
        (sender && sender.tab && sender.tab.id);
      const action = msg.action; // TRANSLATE / RESTORE / SET_RATIO / RETRANSLATE
      if (typeof tabId !== 'number') {
        sendResponse({ ok: false, error: '无法确定目标标签页' });
        return false;
      }
      ensureContentScript(tabId).then(function (pong) {
        if (!pong) {
          sendResponse({ ok: false, error: '当前页面不支持翻译（可能是浏览器内置页面）' });
          return;
        }
        // popup 侧用 action 传指令，内容脚本侧统一按 type 分发，这里做一次映射
        const forward = { type: action, reason: 'popup', action: action };
        ['ratio', 'layout', 'enable', 'url', 'disposition', 'texts', 'kind', 'settings'].forEach(function (k) {
          if (msg[k] !== undefined) forward[k] = msg[k];
        });
        return sendToTab(tabId, forward).then(function (r) {
          if (r && r.state) setTabState(tabId, r.state);
          sendResponse({ ok: true, result: r });
        });
      }).catch(function (err) {
        sendResponse({ ok: false, error: (err && err.message) || String(err) });
      });
      return true;
    }

    /* ---- 读取指定标签页状态（不传则用发送方所在标签页） ---- */
    case 'GET_TAB_STATE': {
      const tabId = (typeof msg.tabId === 'number' ? msg.tabId : null) ||
        (sender && sender.tab && sender.tab.id);
      if (typeof tabId !== 'number') {
        sendResponse({ ok: true, state: null });
        return false;
      }
      getTabState(tabId).then(function (st) {
        // 存储里没有时，实时 ping 一下页面里的 content script
        if (st) return sendResponse({ ok: true, state: st });
        ensureContentScript(tabId).then(function (pong) {
          if (pong && pong.state) {
            setTabState(tabId, pong.state);
            sendResponse({ ok: true, state: pong.state });
          } else {
            sendResponse({ ok: true, state: null });
          }
        });
      });
      return true;
    }

    /* ---- 选项页：读取 / 写入设置 ---- */
    case 'GET_SETTINGS': {
      Engine.getSettings(true).then(function (s) { sendResponse({ ok: true, settings: s }); });
      return true;
    }
    case 'SAVE_SETTINGS': {
      Engine.saveSettings(msg.settings || {}).then(function (s) {
        broadcast({ type: 'SETTINGS_CHANGED' });
        sendResponse({ ok: true, settings: s });
      });
      return true;
    }

    default:
      /*
       * 未在此处处理的消息（例如面向内容脚本的内部指令）转发给发送方所在标签页。
       * 这样 popup / options / 自动化脚本都能直接给页面里的内容脚本发消息。
       * 注意：来源是内容脚本时不能再回传，否则会自己转发给自己形成死循环。
       */
      {
        const fromContentScript = !!(sender && sender.tab && sender.tab.id);
        if (fromContentScript) return false;
        const tabId = (typeof msg.tabId === 'number' ? msg.tabId : null) ||
          (sender && sender.tab && sender.tab.id);
        if (typeof tabId !== 'number') return false;
        ensureContentScript(tabId).then(function (pong) {
          if (!pong) return sendResponse({ ok: false, error: '页面未注入内容脚本' });
          return sendToTab(tabId, msg).then(function (r) {
            sendResponse(r || { ok: false, error: '内容脚本无响应' });
          });
        }).catch(function (err) {
          sendResponse({ ok: false, error: (err && err.message) || String(err) });
        });
        return true;
      }
  }
});
