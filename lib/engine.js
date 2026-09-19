/**
 * lib/engine.js —— 配置 / 翻译引擎 / 缓存 / 多模态 OCR
 *
 * 统一封装 OpenAI 兼容的 Chat Completions 接口：
 *   POST {baseURL}/chat/completions
 *   Authorization: Bearer {apiKey}
 *   body: { model, messages:[{role:'system'},{role:'user'}], temperature, max_tokens, stream:false }
 *
 * 同一份文件被三种环境复用：
 *   - content script（manifest 注入，加载到 self 上）
 *   - service worker（importScripts）
 *   - popup / options 页面（<script src>）
 */
(function (root) {
  'use strict';

  /* ================================================================== */
  /* 一、常量与默认配置                                                  */
  /* ================================================================== */

  var STORAGE_SETTINGS = 'st_settings';
  var STORAGE_CACHE = 'st_cache';
  var STORAGE_SITE_LOG = 'st_site_log';
  var STORAGE_STATE_PREFIX = 'st_state_';   // storage.session 中按 tabId 保存的运行状态

  /** 服务商预设：全部走 OpenAI 兼容接口，唯一区别是 baseURL / model */
  var PROVIDER_PRESETS = {
    deepseek: {
      label: 'DeepSeek',
      baseURL: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      doc: 'https://platform.deepseek.com/api_keys'
    },
    minimax: {
      label: 'MiniMax',
      baseURL: 'https://api.minimax.cn/v1',
      model: 'MiniMax-M3',
      doc: 'https://platform.minimaxi.com/user-center/basic-information/interface-key'
    },
    openai: {
      label: 'OpenAI',
      baseURL: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      doc: 'https://platform.openai.com/api-keys'
    },
    siliconflow: {
      label: '硅基流动 SiliconFlow',
      baseURL: 'https://api.siliconflow.cn/v1',
      model: 'Qwen/Qwen2.5-7B-Instruct',
      doc: 'https://cloud.siliconflow.cn/account/ak'
    },
    moonshot: {
      label: '月之暗面 Kimi',
      baseURL: 'https://api.moonshot.cn/v1',
      model: 'moonshot-v1-8k',
      doc: 'https://platform.moonshot.cn/console/api-keys'
    },
    dashscope: {
      label: '阿里云百炼（兼容模式）',
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-plus',
      doc: 'https://bailian.console.aliyun.com/'
    },
    ollama: {
      label: '本地 Ollama',
      baseURL: 'http://localhost:11434/v1',
      model: 'qwen2.5:7b',
      doc: 'https://ollama.com/'
    },
    custom: {
      label: '自定义（OpenAI 兼容）',
      baseURL: '',
      model: '',
      doc: ''
    }
  };

  /** 默认设置 */
  var DEFAULT_SETTINGS = {
    // ---- 翻译服务 ----
    provider: 'deepseek',
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.2,
    maxTokens: 4096,
    batchSize: 12,              // 每次请求合并的文本段数
    batchChars: 5000,           // 每次请求合并的最大字符数
    requestTimeout: 60000,

    // ---- 思考强度（推理强度）----
    // ''      : 不发送该参数（默认，最省 token、最快）
    // 'auto'  : 同上，只是语义上表示「跟随服务商默认」
    // 'low' / 'medium' / 'high' : 发送 reasoning_effort（DeepSeek、OpenAI o 系列等支持）
    // 若服务商不认这个参数会返回 400，engine 会自动去掉参数重试一次。
    reasoningEffort: '',

    // ---- 翻译目标 ----
    targetLang: 'zh-CN',

    // ---- 自动化程度 ----
    // smart  : 顶部提示条，用户点击才翻译（默认）
    // auto   : 完全自动翻译，不提示
    // manual : 仅手动触发（popup / 右键菜单）
    // off    : 关闭扩展
    // 语言识别方式：
    //   'local'     —— 只用本地统计（默认，零成本零延迟）
    //   'local-api' —— 本地统计判不准时（置信度低 / 与网页声明冲突）改用 AI 接口兜底
    //   'api'       —— 总是用 AI 接口识别
    languageDetect: 'local',
    autoMode: 'smart',
    minConfidence: 0.5,
    // 默认只排除极少数确实不需要翻译的站点，其余交给语言检测判断。
    // 需要排除本地开发页时，在设置里加上 localhost / 127.0.0.1 即可。
    excludeList: 'mail.google.com',

    // ---- 界面 ----
    showBanner: true,
    defaultRatio: 50,
    showDivider: true,
    fontSize: 15,
    lineHeight: 1.7,
    readingStyle: false,        // true = 译文栏使用简洁阅读样式（不继承原站 CSS）
    showStatusBar: true,
    showOriginalOnHover: true,  // 悬停译文显示原文
    syncScroll: true,
    autoTranslateDynamic: false, // 页面动态加载内容是否继续翻译

    // ---- 分屏版面 ----
    // original-left / original-right / original-top / original-bottom
    layout: 'original-left',
    showPaneBadge: true,        // 两栏左上角显示「原文 / 译文」角标
    highlightOriginal: true,    // 悬停译文时高亮原文对应元素
    detachWindow: false,        // 是否在进入分屏后自动把译文放进独立小窗（默认关闭）

    // ---- 图片 / 全语言识别 API（多模态）----
    ocrEnabled: false,
    ocrBaseURL: '',
    ocrApiKey: '',
    ocrModel: '',
    ocrPrompt: '请提取这张图片中的所有可见文字，按阅读顺序输出，只输出文字本身，不要解释、不要 Markdown 代码块。如果图中没有文字，只输出：NO_TEXT'
  };

  /* ================================================================== */
  /* 二、小工具                                                          */
  /* ================================================================== */

  function log() {
    try { console.log.apply(console, ['[分屏翻译]'].concat([].slice.call(arguments))); } catch (e) { /* ignore */ }
  }

  /** djb2 字符串哈希，用于缓存 key */
  function djb2(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function nowTs() { return Date.now(); }

  /** 规范化 baseURL：去掉尾部斜杠、补上 /chat/completions */
  function joinEndpoint(baseURL, path) {
    var base = String(baseURL || '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('未配置 Base URL');
    // 用户可能把完整地址粘进来
    if (/\/chat\/completions$/i.test(base)) return base;
    return base + (path || '/chat/completions');
  }

  function withTimeout(promise, ms, label) {
    var timer;
    var timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        reject(new Error((label || '请求') + '超时（' + Math.round(ms / 1000) + ' 秒）'));
      }, ms);
    });
    return Promise.race([promise, timeout]).then(
      function (v) { clearTimeout(timer); return v; },
      function (e) { clearTimeout(timer); throw e; }
    );
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function safeJsonParse(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  /* ================================================================== */
  /* 三、设置读写                                                        */
  /* ================================================================== */

  // 内存缓存，避免高频读取 chrome.storage
  var settingsMemo = null;

  function normalizeSettings(raw) {
    var s = Object.assign({}, DEFAULT_SETTINGS, raw || {});
    // 兼容：用户只填了 baseURL 却选了预设
    s.baseURL = String(s.baseURL || '').trim();
    s.ocrBaseURL = String(s.ocrBaseURL || '').trim();
    s.ocrApiKey = String(s.ocrApiKey || '').trim();
    s.ocrModel = String(s.ocrModel || '').trim();
    s.batchSize = Math.max(1, Math.min(50, parseInt(s.batchSize, 10) || DEFAULT_SETTINGS.batchSize));
    s.batchChars = Math.max(500, Math.min(20000, parseInt(s.batchChars, 10) || DEFAULT_SETTINGS.batchChars));
    s.defaultRatio = Math.max(20, Math.min(80, parseInt(s.defaultRatio, 10) || 50));
    s.temperature = Math.max(0, Math.min(2, parseFloat(s.temperature)));
    if (isNaN(s.temperature)) s.temperature = DEFAULT_SETTINGS.temperature;
    s.maxTokens = Math.max(256, Math.min(32000, parseInt(s.maxTokens, 10) || DEFAULT_SETTINGS.maxTokens));
    s.ocrEnabled = !!(s.ocrEnabled && s.ocrBaseURL && s.ocrModel);
    if (['local', 'local-api', 'api'].indexOf(s.languageDetect) < 0) s.languageDetect = 'local';
    // 思考强度只接受白名单值
    if (['low', 'medium', 'high'].indexOf(s.reasoningEffort) < 0) s.reasoningEffort = '';
    // 版面白名单
    if (['original-left', 'original-right', 'original-top', 'original-bottom'].indexOf(s.layout) < 0) {
      s.layout = 'original-left';
    }
    s.excludePatterns = String(s.excludeList || '')
      .split(/[\n,;]/)
      .map(function (x) { return x.trim().toLowerCase(); })
      .filter(Boolean);
    return s;
  }

  /**
   * 读取设置（带内存缓存）
   * @param {boolean} [force] 强制从存储重新读取
   */
  function getSettings(force) {
    if (!force && settingsMemo) return Promise.resolve(settingsMemo);
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      settingsMemo = normalizeSettings({});
      return Promise.resolve(settingsMemo);
    }
    return new Promise(function (resolve) {
      chrome.storage.local.get(STORAGE_SETTINGS, function (res) {
        settingsMemo = normalizeSettings(res && res[STORAGE_SETTINGS]);
        resolve(settingsMemo);
      });
    });
  }

  function saveSettings(patch) {
    return getSettings().then(function (cur) {
      var next = normalizeSettings(Object.assign({}, cur, patch));
      settingsMemo = next;
      return new Promise(function (resolve) {
        var obj = {};
        obj[STORAGE_SETTINGS] = next;
        chrome.storage.local.set(obj, function () { resolve(next); });
      });
    });
  }

  /** 清空内存缓存（storage.onChanged 时调用） */
  function invalidateSettings() { settingsMemo = null; }

  /**
   * 判断某个 URL 是否命中排除名单
   */
  function isExcluded(url, settings) {
    if (!url) return true;
    var u = String(url).toLowerCase();
    if (/^(chrome|edge|about|devtools|view-source|chrome-extension|extension|edge-extension|moz-extension):/.test(u)) return true;
    if (/^https?:\/\/(chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons)/.test(u)) return true;
    var list = (settings && settings.excludePatterns) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && u.indexOf(list[i]) >= 0) return true;
    }
    return false;
  }

  /* ================================================================== */
  /* 四、翻译缓存（chrome.storage.local 中的哈希表）                      */
  /* ================================================================== */

  var CACHE_LIMIT = 3000;          // 最多保留的条目数
  var CACHE_TTL = 90 * 24 * 3600 * 1000; // 90 天

  function cacheKey(text, settings, kind) {
    var head = (kind || 'tx') + '|' + settings.baseURL + '|' + settings.model + '|' + settings.targetLang;
    return 'h' + djb2(head + '\u0001' + text);
  }

  function readCacheMap() {
    return new Promise(function (resolve) {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return resolve({});
      chrome.storage.local.get(STORAGE_CACHE, function (res) {
        resolve((res && res[STORAGE_CACHE]) || {});
      });
    });
  }

  function writeCacheMap(map) {
    return new Promise(function (resolve) {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return resolve(false);
      var obj = {};
      obj[STORAGE_CACHE] = map;
      chrome.storage.local.set(obj, function () {
        if (chrome.runtime.lastError) {
          log('缓存写入失败（可能超出配额），执行裁剪重试', chrome.runtime.lastError.message);
          map = pruneCache(map, 800);
          var obj2 = {};
          obj2[STORAGE_CACHE] = map;
          chrome.storage.local.set(obj2, function () { resolve(true); });
          return;
        }
        resolve(true);
      });
    });
  }

  /** 按时间戳裁剪到指定条数 */
  function pruneCache(map, keep) {
    var entries = Object.keys(map).map(function (k) {
      return { k: k, t: (map[k] && map[k].t) || 0 };
    });
    entries.sort(function (a, b) { return b.t - a.t; });
    var out = {};
    for (var i = 0; i < entries.length && i < keep; i++) out[entries[i].k] = map[entries[i].k];
    return out;
  }

  /**
   * 批量查询缓存
   * @returns {Promise<Object>} { [原文]: 译文 }
   */
  function cacheGetMany(texts, settings, kind) {
    return readCacheMap().then(function (map) {
      var hit = {};
      var ttl = kind === 'ocr' ? CACHE_TTL * 3 : CACHE_TTL;
      for (var i = 0; i < texts.length; i++) {
        var item = map[cacheKey(texts[i], settings, kind)];
        if (item && item.v && (nowTs() - (item.t || 0) < ttl)) hit[texts[i]] = item.v;
      }
      return hit;
    });
  }

  /**
   * 批量写入缓存（自带条数上限与过期清理）
   */
  function cacheSetMany(pairs, settings, kind) {
    return readCacheMap().then(function (map) {
      var keys = Object.keys(map);
      // 顺手清理过期条目
      if (keys.length > CACHE_LIMIT * 0.9) {
        var cutoff = nowTs() - CACHE_TTL;
        keys.forEach(function (k) { if ((map[k].t || 0) < cutoff) delete map[k]; });
      }
      Object.keys(pairs).forEach(function (src) {
        map[cacheKey(src, settings, kind)] = { v: pairs[src], t: nowTs(), k: kind || 'tx' };
      });
      if (Object.keys(map).length > CACHE_LIMIT) map = pruneCache(map, CACHE_LIMIT);
      return writeCacheMap(map);
    });
  }

  function cacheClear() {
    return new Promise(function (resolve) {
      var obj = {};
      obj[STORAGE_CACHE] = {};
      chrome.storage.local.set(obj, function () { resolve(true); });
    });
  }

  function cacheStats() {
    return readCacheMap().then(function (map) {
      return { count: Object.keys(map).length };
    });
  }

  /* ================================================================== */
  /* 五、Chat Completions 调用                                           */
  /* ================================================================== */

  /**
   * 底层请求：任意 OpenAI 兼容 /chat/completions
   * @param {{baseURL:string, apiKey:string, model:string, timeout?:number, reasoningEffort?:string}} cfg
   * @param {Array} messages
   * @param {{temperature?:number, max_tokens?:number}} [opts]
   * @returns {Promise<string>} 模型输出的纯文本
   */
  function chatCompletion(cfg, messages, opts) {
    opts = opts || {};
    if (!cfg || !cfg.apiKey) throw new Error('未配置 API Key，请到「设置」中填写。');
    if (!cfg.model) throw new Error('未配置模型名称。');
    var effort = cfg.reasoningEffort;
    if (['low', 'medium', 'high'].indexOf(effort) < 0) effort = '';

    return doChatCompletion(cfg, messages, opts, effort).catch(function (err) {
      // 有些服务商 / 模型不认 reasoning_effort，会直接 400。
      // 这时自动去掉该参数重试一次，避免用户因为一个下拉框选错就完全不能用。
      var msg = (err && err.message) || '';
      if (effort && /400|422|reasoning_effort|unsupported|invalid.*(parameter|argument)/i.test(msg)) {
        log('接口不接受 reasoning_effort，已自动去掉该参数重试');
        return doChatCompletion(cfg, messages, opts, '');
      }
      throw err;
    });
  }

  /**
   * 实际发请求（reasoningEffort 传空串表示不带该参数）
   */
  function doChatCompletion(cfg, messages, opts, reasoningEffort) {
    var url = joinEndpoint(cfg.baseURL, '/chat/completions');
    var body = {
      model: cfg.model,
      messages: messages,
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.2,
      max_tokens: opts.max_tokens || 4096,
      stream: false
    };
    if (reasoningEffort) body.reasoning_effort = reasoningEffort;

    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var fetchPromise = fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + cfg.apiKey
      },
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined
    }).then(function (resp) {
      return resp.text().then(function (raw) {
        if (!resp.ok) {
          var msg = raw;
          var j = safeJsonParse(raw);
          if (j && j.error) msg = j.error.message || j.error.code || raw;
          else if (j && j.message) msg = j.message;
          throw new Error('接口返回 ' + resp.status + '：' + String(msg).slice(0, 300));
        }
        var data = safeJsonParse(raw);
        if (!data) throw new Error('接口返回内容无法解析为 JSON：' + raw.slice(0, 200));
        if (data.error) throw new Error(data.error.message || String(data.error));
        var choice = data.choices && data.choices[0];
        if (!choice) throw new Error('接口返回中没有 choices 字段');
        var content = (choice.message && choice.message.content) || choice.text || '';
        // 部分服务商（如推理模型）会把内容放在数组里
        if (Array.isArray(content)) {
          content = content.map(function (p) { return (p && (p.text || p.content)) || ''; }).join('');
        }
        return String(content || '');
      });
    });

    return withTimeout(fetchPromise, cfg.timeout || DEFAULT_SETTINGS.requestTimeout, 'AI 接口')
      .catch(function (err) {
        if (controller && /abort/i.test(String(err && err.name))) throw new Error('请求已取消');
        if (/Failed to fetch|NetworkError|Load failed/i.test(String(err && err.message))) {
          throw new Error('网络请求失败：请检查 Base URL 是否正确、网络是否可访问该服务商（' + url + '）');
        }
        throw err;
      });
  }

  /* ================================================================== */
  /* 六、翻译批处理                                                      */
  /* ================================================================== */

  var SYSTEM_PROMPT =
    '你是一名专业的网页本地化译者，负责把网页文本翻译成简体中文（中国大陆用语习惯）。\n' +
    '严格遵守以下规则：\n' +
    '1. 输入是一个 JSON 数组，元素顺序即为输出顺序，必须逐个翻译，不得合并、拆分、增删或重排。\n' +
    '2. 输出必须是一个 JSON 数组，长度与输入完全一致，元素为对应的简体中文译文，不要输出任何解释、注释或 Markdown 代码块。\n' +
    '3. 保留原始文本中的占位符、变量、URL、邮箱、代码片段、数字与单位，例如 {name}、%s、{{count}}、https://... 必须原样照抄。\n' +
    '4. 保留原文的语气、标点风格与大小写习惯；短标签（按钮、菜单项）翻译得简洁自然，符合中文界面惯例。\n' +
    '5. 已经是中文的条目（例如产品名、人名、专有名词）保持原样输出。\n' +
    '6. 如果是代码、命令行、数学公式等不应翻译的内容，原样输出。\n' +
    '7. 只输出 JSON 数组本身，第一个字符必须是 [，最后一个字符必须是 ]。';

  /** 从模型输出中稳健地解析出字符串数组 */
  function parseArrayResponse(raw, expectedCount) {
    if (!raw) return [];
    var text = String(raw).trim();
    // 去掉可能的 ```json ``` 包裹
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

    function tryParse(s) {
      var v = safeJsonParse(s);
      if (Array.isArray(v)) return v.map(function (x) { return typeof x === 'string' ? x : (x == null ? '' : String(x)); });
      // 有些模型返回 {"translations":[...]}
      if (v && typeof v === 'object') {
        var keys = ['translations', 'result', 'results', 'data', 'items', 'output'];
        for (var i = 0; i < keys.length; i++) {
          if (Array.isArray(v[keys[i]])) {
            return v[keys[i]].map(function (x) { return typeof x === 'string' ? x : (x == null ? '' : String(x)); });
          }
        }
      }
      return null;
    }

    var arr = tryParse(text);
    if (!arr) {
      // 退而求其次：截取第一个 [ 到最后一个 ]
      var s = text.indexOf('['), e = text.lastIndexOf(']');
      if (s >= 0 && e > s) arr = tryParse(text.slice(s, e + 1));
    }
    if (!arr) {
      // 再退：按行切分（模型有时会输出逐行译文）
      var lines = text.split('\n')
        .map(function (l) { return l.replace(/^\s*(?:\d+[.、)]|[-*])\s*/, '').trim(); })
        .filter(function (l) { return l && l !== '[' && l !== ']'; });
      if (lines.length) arr = lines;
    }
    if (!arr) return [];
    if (expectedCount && arr.length !== expectedCount) {
      log('返回条数与请求不一致：期望 ' + expectedCount + '，实际 ' + arr.length);
    }
    return arr;
  }

  /** 把一批文本组织成 user 消息 */
  function buildUserMessage(texts) {
    return '待翻译 JSON 数组（共 ' + texts.length + ' 项）：\n' + JSON.stringify(texts) +
      '\n\n请输出长度相同的简体中文 JSON 数组。';
  }

  /**
   * 请求一批翻译（内部函数，不做缓存、不做拆分）
   * @param {string[]} texts
   * @param {object} settings
   * @returns {Promise<string[]>}
   */
  function requestBatch(texts, settings) {
    var cfg = {
      baseURL: settings.baseURL,
      apiKey: settings.apiKey,
      model: settings.model,
      timeout: settings.requestTimeout,
      reasoningEffort: settings.reasoningEffort
    };
    var sys = SYSTEM_PROMPT;
    if (settings.targetLang === 'zh-TW') {
      sys = sys.replace(/简体中文（中国大陆用语习惯）/g, '繁体中文（台湾用语习惯）');
    }
    var messages = [
      { role: 'system', content: sys },
      { role: 'user', content: buildUserMessage(texts) }
    ];
    return chatCompletion(cfg, messages, {
      temperature: settings.temperature,
      max_tokens: settings.maxTokens
    }).then(function (raw) {
      var arr = parseArrayResponse(raw, texts.length);
      if (!arr.length) throw new Error('模型未返回可解析的译文数组');
      return arr;
    });
  }

  /**
   * 翻译一组文本（合并去重 + 缓存 + 自动拆分 + 失败重试）
   *
   * @param {string[]} texts
   * @param {object} settings
   * @param {{kind?:string, onProgress?:(done:number,total:number)=>void, signal?:{aborted:boolean}}} [opts]
   * @returns {Promise<{map:Object, errors:string[]}>}
   */
  function translateTexts(texts, settings, opts) {
    opts = opts || {};
    settings = normalizeSettings(settings);
    var errors = [];

    // 1) 去重（同一段文字只请求一次）
    var unique = [];
    var seen = Object.create(null);
    for (var i = 0; i < texts.length; i++) {
      var t = texts[i];
      if (typeof t !== 'string') continue;
      if (!t.trim()) continue;
      if (seen[t]) continue;
      seen[t] = true;
      unique.push(t);
    }
    if (!unique.length) return Promise.resolve({ map: {}, errors: errors });

    var kind = opts.kind || 'tx';
    var resultMap = Object.create(null);
    var doneCount = 0;

    function reportProgress() {
      if (opts.onProgress) {
        try { opts.onProgress(doneCount, unique.length); } catch (e) { /* ignore */ }
      }
    }

    // 2) 查缓存
    return cacheGetMany(unique, settings, kind).then(function (cached) {
      var hits = 0;
      var pending = [];
      unique.forEach(function (t) {
        if (Object.prototype.hasOwnProperty.call(cached, t)) {
          resultMap[t] = cached[t];
          hits++;
          doneCount++;
        } else {
          pending.push(t);
        }
      });
      log('缓存命中 ' + hits + ' / ' + unique.length);
      reportProgress();
      if (!pending.length) return null;

      // 3) 按条数与字符数切分为多个批次
      var batches = [];
      var cur = [], curChars = 0;
      pending.forEach(function (t) {
        if (cur.length >= settings.batchSize || (curChars + t.length > settings.batchChars && cur.length)) {
          batches.push(cur);
          cur = []; curChars = 0;
        }
        cur.push(t);
        curChars += t.length;
      });
      if (cur.length) batches.push(cur);

      // 4) 串行执行（避免触发服务商并发限流）
      function runBatch(batch, depth) {
        if (opts.signal && opts.signal.aborted) return Promise.resolve();
        return requestBatch(batch, settings).then(function (arr) {
          var storePairs = Object.create(null);
          for (var k = 0; k < batch.length; k++) {
            var val = arr[k];
            if (typeof val !== 'string' || !val.length) val = null;
            if (val === null) {
              // 模型少返回时：单条补发，或退化为原文
              if (batch.length === 1) { resultMap[batch[k]] = batch[k]; continue; }
              val = batch[k];
            }
            resultMap[batch[k]] = val;
            storePairs[batch[k]] = val;
            doneCount++;
          }
          reportProgress();
          return cacheSetMany(storePairs, settings, kind);
        }).catch(function (err) {
          var msg = (err && err.message) || String(err);
          // 批次过大导致的失败 → 二分拆分重试
          if (batch.length > 1 && depth < 3) {
            log('批次失败，拆分重试：' + msg);
            var mid = Math.ceil(batch.length / 2);
            return runBatch(batch.slice(0, mid), depth + 1).then(function () {
              return runBatch(batch.slice(mid), depth + 1);
            });
          }
          // 单条失败：网络类错误重试一次
          if (depth < 3 && /超时|网络|429|502|503|504|rate limit/i.test(msg)) {
            return sleep(1200 * (depth + 1)).then(function () {
              return runBatch(batch, depth + 1);
            });
          }
          errors.push(msg);
          batch.forEach(function (t) {
            if (!(t in resultMap)) { resultMap[t] = t; doneCount++; } // 降级：保留原文
          });
          reportProgress();
          return null;
        });
      }

      var chain = Promise.resolve();
      batches.forEach(function (b) {
        chain = chain.then(function () { return runBatch(b, 0); });
      });
      return chain;
    }).then(function () {
      // 5) 未命中的条目统一落盘（上面已增量写入，这里兜底）
      return { map: resultMap, errors: errors };
    });
  }

  /* ================================================================== */
  /* 七、图片取字（可选的「全语言识别 API」）                            */
  /* ================================================================== */

  var OCR_SYSTEM_PROMPT =
    '你是一个 OCR 文字识别引擎，只需如实提取图片中出现的文字，不要翻译、不要解释、不要添加任何前后缀。';

  /**
   * 调用多模态接口提取图片中的文字
   * @param {{src:string, alt?:string}} image
   * @param {object} settings
   * @returns {Promise<string>} 提取到的原文（无文字则为空串）
   */
  function recognizeImage(image, settings) {
    if (!settings.ocrEnabled || !settings.ocrBaseURL || !settings.ocrModel) {
      return Promise.resolve('');
    }
    var src = image && image.src;
    if (!src) return Promise.resolve('');
    // 相对路径 / blob: 无法被远程模型读取
    if (!/^(https?:|data:image\/)/i.test(src)) return Promise.resolve('');

    var userContent = [
      { type: 'text', text: settings.ocrPrompt || DEFAULT_SETTINGS.ocrPrompt },
      { type: 'image_url', image_url: { url: src } }
    ];

    var cfg = {
      baseURL: settings.ocrBaseURL,
      apiKey: settings.ocrApiKey || settings.apiKey,
      model: settings.ocrModel,
      timeout: settings.requestTimeout,
      reasoningEffort: ''   // OCR 用不上思考强度
    };
    var messages = [
      { role: 'system', content: OCR_SYSTEM_PROMPT },
      { role: 'user', content: userContent }
    ];
    return chatCompletion(cfg, messages, { temperature: 0, max_tokens: 1024 })
      .then(function (txt) {
        var out = String(txt || '').trim();
        out = out.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
        if (!out || /^NO_TEXT$/i.test(out) || out === '无文字') return '';
        return out.slice(0, 4000);
      })
      .catch(function (err) {
        log('图片取字失败：' + ((err && err.message) || err));
        return '';
      });
  }

  /* ================================================================== */
  /* 八、连通性测试                                                      */
  /* ================================================================== */

  /**
   * 「测试连接」：发一条最小请求，验证 baseURL / apiKey / model 是否可用
   * @param {object} settings
   * @param {'text'|'vision'} [which]
   */
  function testConnection(settings, which) {
    settings = normalizeSettings(settings);
    var started = nowTs();
    if (which === 'vision') {
      if (!settings.ocrBaseURL || !settings.ocrModel) throw new Error('请先填写「全语言识别 API」的 Base URL 与模型名');
      var cfg = {
        baseURL: settings.ocrBaseURL,
        apiKey: settings.ocrApiKey || settings.apiKey,
        model: settings.ocrModel,
        timeout: 30000
      };
      // 1x1 透明 PNG，仅用于验证多模态链路
      var px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
      return chatCompletion(cfg, [{
        role: 'user',
        content: [
          { type: 'text', text: '这是一张 1x1 的透明图片，请只回复两个字：可用' },
          { type: 'image_url', image_url: { url: px } }
        ]
      }], { temperature: 0, max_tokens: 16 }).then(function (out) {
        return { ok: true, message: '多模态接口可用，返回：' + String(out).trim().slice(0, 40), ms: nowTs() - started };
      });
    }

    var cfg2 = {
      baseURL: settings.baseURL,
      apiKey: settings.apiKey,
      model: settings.model,
      timeout: 30000,
      reasoningEffort: settings.reasoningEffort
    };
    return chatCompletion(cfg2, [
      { role: 'system', content: '你是翻译引擎，只输出译文，不要任何解释。' },
      { role: 'user', content: '把下面这句翻译成简体中文，只输出译文：Hello, this is a connection test.' }
    ], { temperature: 0, max_tokens: 64 }).then(function (out) {
      return { ok: true, message: '连接成功（' + (nowTs() - started) + 'ms）：' + String(out).trim().slice(0, 60), ms: nowTs() - started };
    });
  }

  /**
   * 拉取服务商的模型列表（可选功能，失败不影响使用）
   */
  function fetchModels(settings) {
    settings = normalizeSettings(settings);
    var url = String(settings.baseURL || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '') + '/models';
    return withTimeout(fetch(url, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + settings.apiKey }
    }).then(function (r) {
      return r.text().then(function (raw) {
        if (!r.ok) throw new Error('拉取模型列表失败：HTTP ' + r.status);
        var j = safeJsonParse(raw);
        var list = (j && (j.data || j.models)) || [];
        return list.map(function (m) { return m.id || m.name || m.model; }).filter(Boolean);
      });
    }), 20000, '模型列表接口');
  }

  /* ================================================================== */
  /* 九、导出                                                           */
  /* ================================================================== */

  /* ================================================================== */
  /* 八、语言识别（可选：用 AI 兜底本地统计判不准的页面）               */
  /* ================================================================== */

  var LANG_DETECT_PROMPT =
    '你是语言识别引擎。请判断下面这段网页文本的主要语言，只输出一个 ISO 639-1 语言代码，' +
    '不要输出任何解释、标点或多余文字。\n' +
    '常用代码：zh 中文、en 英语、ja 日语、ko 韩语、fr 法语、de 德语、es 西班牙语、' +
    'pt 葡萄牙语、it 意大利语、ru 俄语、ar 阿拉伯语、th 泰语、vi 越南语。\n' +
    '若正文是中文，再区分简繁：简体输出 zh-CN，繁体输出 zh-TW。';

  /** 把模型返回的各种写法归一化成内部语言码 */
  function normalizeDetectedCode(raw) {
    var s = String(raw || '').trim().toLowerCase();
    if (!s) return '';
    // 有些模型会回中文语言名而不是语言码，先按名字兜一层
    var cnName = { '简体中文': 'zh_Hans', '中文': 'zh_Hans', '繁体中文': 'zh_Hant',
      '英语': 'en', '英文': 'en', '日语': 'ja', '日文': 'ja', '韩语': 'ko', '韩文': 'ko',
      '法语': 'fr', '法文': 'fr', '德语': 'de', '德文': 'de', '西班牙语': 'es',
      '葡萄牙语': 'pt', '意大利语': 'it', '俄语': 'ru', '阿拉伯语': 'ar', '泰语': 'th',
      '越南语': 'vi' };
    var firstLine = s.split('\n')[0].trim();
    if (cnName[firstLine]) return cnName[firstLine];
    // 取第一个像语言码的片段，例如 "zh-CN" / "en" / "ko-KR"
    var m = s.match(/[a-z]{2,3}(?:[-_][a-z0-9]{2,8})?/);
    if (m) s = m[0].replace(/_/g, '-');
    if (s.indexOf('zh') === 0) {
      if (/hant|tw|hk|mo|traditional|繁体|繁/.test(s)) return 'zh_Hant';
      return 'zh_Hans';
    }
    if (s === 'ja' || s === 'jp') return 'ja';
    if (s === 'ko' || s === 'kr') return 'ko';
    return s.split('-')[0] || '';
  }

  /**
   * 调用 AI 识别一段文本的主要语言。
   * 用于本地统计判不准（置信度低 / 与网页声明冲突）时兜底。
   *
   * @param {string} text
   * @param {object} settings
   * @returns {Promise<{code:string, raw:string}|null>} 识别失败返回 null，不抛错
   */
  function detectLanguageViaApi(text, settings) {
    settings = normalizeSettings(settings);
    var sample = String(text || '').trim();
    if (!sample) return Promise.resolve(null);
    // 头尾各取 3000 字符足够判断语言，也省 token
    if (sample.length > 6000) sample = sample.slice(0, 3000) + '\n...\n' + sample.slice(-3000);
    var cfg = {
      baseURL: settings.baseURL,
      apiKey: settings.apiKey,
      model: settings.model,
      timeout: Math.min(settings.requestTimeout, 25000),
      reasoningEffort: ''      // 语言识别不需要思考强度
    };
    var messages = [
      { role: 'system', content: LANG_DETECT_PROMPT },
      { role: 'user', content: sample }
    ];
    return chatCompletion(cfg, messages, { temperature: 0, max_tokens: 16 })
      .then(function (raw) {
        var code = normalizeDetectedCode(raw);
        if (!code) return null;
        return { code: code, raw: String(raw).trim().slice(0, 40) };
      })
      .catch(function (err) {
        log('AI 语言识别失败：' + ((err && err.message) || err));
        return null;
      });
  }

  /* ================================================================== */
  /* 九、导出                                                           */
  /* ================================================================== */

  var api = {
    STORAGE_SETTINGS: STORAGE_SETTINGS,
    STORAGE_CACHE: STORAGE_CACHE,
    STORAGE_SITE_LOG: STORAGE_SITE_LOG,
    STORAGE_STATE_PREFIX: STORAGE_STATE_PREFIX,

    PROVIDER_PRESETS: PROVIDER_PRESETS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    SYSTEM_PROMPT: SYSTEM_PROMPT,

    normalizeSettings: normalizeSettings,
    getSettings: getSettings,
    saveSettings: saveSettings,
    invalidateSettings: invalidateSettings,
    isExcluded: isExcluded,

    cacheKey: cacheKey,
    cacheGetMany: cacheGetMany,
    cacheSetMany: cacheSetMany,
    cacheClear: cacheClear,
    cacheStats: cacheStats,

    chatCompletion: chatCompletion,
    translateTexts: translateTexts,
    parseArrayResponse: parseArrayResponse,
    recognizeImage: recognizeImage,

    detectLanguageViaApi: detectLanguageViaApi,
    normalizeDetectedCode: normalizeDetectedCode,
    LANG_DETECT_PROMPT: LANG_DETECT_PROMPT,

    testConnection: testConnection,
    fetchModels: fetchModels,

    djb2: djb2,
    joinEndpoint: joinEndpoint,
    log: log
  };

  root.SplitTranslate = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
