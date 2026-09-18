/**
 * tests/e2e.js —— 真实浏览器端到端验证（无头 Edge + CDP）
 *
 * 覆盖的完整用户路径：
 *   [1] 扩展加载、拿到扩展 ID；
 *   [2] 未配置设置时打开法文页面 → 顶部出现提示条（智能提示模式），含文案与按钮；
 *   [3] 写入配置（与 options 页同一条落盘路径：Engine.saveSettings）；
 *   [4] 点击提示条「翻译」→ 分屏 + 调接口 + 译文回填；
 *   [5] 分屏结构、镜像层级、原文保留、代码块 / translate=no 未翻译；
 *   [6] 接口确实被调用且做了批量合并；
 *   [7] 拖动分隔线改变比例；点状态条按钮恢复原页面；
 *   [8] 「完全自动」模式重载后自动分屏 + 缓存命中；
 *   [9] 动态加载内容被续翻；
 *   [10] 排除名单命中时不提示、不分屏；
 *   [11] 运行期无未捕获异常。
 *
 * 已知环境差异：无头 Edge 下 getBoundingClientRect() 不会随样式变化更新
 * （对照组普通 div 也一样），因此凡是「宽度是否变化」的断言都改为读
 * getComputedStyle 的计算值，而不是几何尺寸。
 *
 * 配置写入走扩展自己的消息通道，而不是打开 options 页面点按钮——
 * 本机 Edge 的 content verifier 会拦截 chrome-extension:// 下的 HTML 页面。
 * options 页面请在真实 Edge 中人工验证。
 *
 * 用法：node tests/e2e.js
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];

const PORT = 18080;
const TMP = path.join(os.tmpdir(), 'st-e2e');
const EXT_DIR = path.join(TMP, 'ext');
const PROFILE_DIR = path.join(TMP, 'profile');

const BASE_SETTINGS = {
  provider: 'custom',
  baseURL: 'http://127.0.0.1:' + PORT + '/v1',
  apiKey: 'test-key-not-used',
  model: 'mock-translate-v1',
  temperature: 0,
  maxTokens: 2048,
  batchSize: 8,
  batchChars: 3000,
  requestTimeout: 20000,
  targetLang: 'zh-CN',
  autoMode: 'smart',
  minConfidence: 0.4,
  excludeList: 'mail.google.com',
  showBanner: true,
  defaultRatio: 50,
  showDivider: true,
  fontSize: 15,
  lineHeight: 1.7,
  readingStyle: false,
  showStatusBar: true,
  showOriginalOnHover: true,
  syncScroll: true,
  autoTranslateDynamic: false,
  ocrEnabled: false,
  ocrBaseURL: '',
  ocrApiKey: '',
  ocrModel: ''
};

let pass = 0, fail = 0;
const failures = [];
let currentStep = '初始化';

function check(name, ok, detail) {
  currentStep = name;
  if (ok) { pass++; console.log('  [OK] ' + name); }
  else {
    fail++;
    failures.push(name + (detail ? ' -> ' + detail : ''));
    console.log('  [FAIL] ' + name + (detail ? '  -> ' + detail : ''));
  }
}

function findEdge() {
  for (const p of EDGE_CANDIDATES) if (p && fs.existsSync(p)) return p;
  return null;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 复制一份被测扩展；Edge 内容校验器会拒绝 tests/、tools/，故剥掉 */
function prepareExtension() {
  fs.rmSync(EXT_DIR, { recursive: true, force: true });
  fs.mkdirSync(EXT_DIR, { recursive: true });
  const skip = new Set(['node_modules', '.git', 'tools', 'tests']);
  (function copy(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const s = path.join(src, entry.name);
      const d = path.join(dst, entry.name);
      if (entry.isDirectory()) copy(s, d);
      else fs.copyFileSync(s, d);
    }
  })(ROOT, EXT_DIR);
  return EXT_DIR;
}

/* ------------------------------------------------------------------ */
/* mock OpenAI 接口 + 测试页                                           */
/* ------------------------------------------------------------------ */

const FRENCH_PAGE = fs.readFileSync(path.join(__dirname, 'fixture-fr.html'), 'utf8');

/** 供「译文栏链接可点」测试使用的第二页 */
const ARTICLE_PAGE = [
  '<!DOCTYPE html>',
  '<html lang="en"><head><meta charset="utf-8"><title>News article one</title></head>',
  '<body><h1>This is the linked article page</h1>',
  '<p>The split screen translation extension navigated here because you clicked a link',
  'inside the translated pane. This page should also get auto translated.</p>',
  '</body></html>'
].join('\n');

function startMockServer() {
  const received = [];
  const server = http.createServer((req, res) => {
    const p = (req.url || '/').split('?')[0];
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

    if (p === '/v1/chat/completions' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let texts = [];
        let body = null;
        try {
          body = JSON.parse(raw);
          const msg = body.messages[body.messages.length - 1];
          const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          const s = content.indexOf('['), e = content.lastIndexOf(']');
          if (s >= 0 && e > s) texts = JSON.parse(content.slice(s, e + 1));
        } catch (err) { /* ignore */ }
        if (!Array.isArray(texts)) texts = [];
        received.push({
          count: texts.length,
          sample: texts[0],
          reasoningEffort: body && body.reasoning_effort,
          model: body && body.model
        });
        const out = texts.map((t) => '[\u4e2d]' + t);
        res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
        res.end(JSON.stringify({
          id: 'mock', object: 'chat.completion', model: (body && body.model) || 'mock-translate-v1',
          choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(out) }, finish_reason: 'stop' }]
        }));
      });
      return;
    }
    if (p === '/v1/models') {
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-translate-v1' }] }));
    }
    if (p === '/__report') {
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
      return res.end(JSON.stringify({
        calls: received.length,
        batches: received.map((r) => r.count),
        sample: received.length ? received[0].sample : null,
        efforts: received.map((r) => r.reasoningEffort === undefined ? '(未发送)' : r.reasoningEffort)
      }));
    }
    if (p === '/news/article-1') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(ARTICLE_PAGE);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(FRENCH_PAGE);
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

/* ------------------------------------------------------------------ */
/* 极简 CDP 客户端                                                     */
/* ------------------------------------------------------------------ */

function httpGetJson(target) {
  return new Promise((resolve, reject) => {
    http.get(target, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('无法解析 ' + target)); }
      });
    }).on('error', reject);
  });
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.console = [];
    this.exceptions = [];
    this.contexts = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.executionContextCreated') {
        const sid = msg.sessionId;
        if (!this.contexts.has(sid)) this.contexts.set(sid, []);
        this.contexts.get(sid).push(msg.params.context);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        this.console.push('[' + msg.params.type + '] ' + (msg.params.args || []).map((a) =>
          (a.value !== undefined ? String(a.value) : (a.description || a.type))).join(' '));
        if (this.console.length > 60) this.console.shift();
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails || {};
        this.exceptions.push((d.exception && d.exception.description) || d.text || 'unknown');
      }
    });
  }

  static async connect(port) {
    const info = await httpGetJson('http://127.0.0.1:' + port + '/json/version');
    const ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
    });
    return new CDP(ws);
  }

  send(method, params, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params: params || {} };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + ' timeout')); }
      }, 40000);
    });
  }

  async attach(targetId) {
    const r = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = r.sessionId;
    await this.send('Page.enable', {}, sessionId);
    await this.send('Runtime.enable', {}, sessionId);
    return sessionId;
  }

  /** 新建标签页并附着，返回 { targetId, sessionId } */
  async newTab(targetUrl) {
    const { targetId } = await this.send('Target.createTarget', { url: targetUrl || 'about:blank' });
    const sessionId = await this.attach(targetId);
    return { targetId, sessionId };
  }

  async evaluate(sessionId, expression, contextId) {
    const params = { expression, returnByValue: true, awaitPromise: true };
    if (contextId) params.contextId = contextId;
    const res = await this.send('Runtime.evaluate', params, sessionId);
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      const text = (d.exception && d.exception.description) || d.text || '';
      /*
       * 页面主世界拿不到 chrome.*，所有涉及扩展 API 的表达式必须跑在内容脚本的隔离世界。
       * 这里做一次自动纠偏，省得每个调用点都要人工判断用哪个世界。
       */
      if (/chrome/.test(expression) && /Cannot read properties of undefined \(reading '(sendMessage|runtime|storage|id)'\)|chrome is not defined/.test(text)) {
        const ctxId = await this.isolatedContextId(sessionId);
        return this.evaluate(sessionId, expression, ctxId);
      }
      throw new Error('页面内异常：' + text);
    }
    return res.result.value;
  }

  /**
   * 找到内容脚本所在的「隔离世界」执行上下文。
   * 页面可能同时存在多个非默认上下文（旧文档残留、其它扩展的隔离世界），
   * 因此逐个用 chrome.runtime 探测，只返回真正能访问扩展 API 的那个。
   */
  async isolatedContextId(sessionId, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 12000);
    let lastErr = null;
    while (Date.now() < deadline) {
      const candidates = (this.contexts.get(sessionId) || [])
        .filter((c) => c.auxData && c.auxData.isDefault === false);
      for (const ctx of candidates) {
        try {
          const ok = await this.evaluate(sessionId,
            'typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id', ctx.id);
          if (ok) return ctx.id;
        } catch (err) {
          lastErr = err;   // 上下文已失效，换下一个
        }
      }
      await sleep(250);
    }
    throw new Error('未找到可用的隔离世界上下文' + (lastErr ? '：' + lastErr.message : ''));
  }

  async evaluateIsolated(sessionId, expression) {
    // 导航会让隔离世界上下文重建，这里做一次重试
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const ctxId = await this.isolatedContextId(sessionId, 8000);
        return await this.evaluate(sessionId, expression, ctxId);
      } catch (err) {
        lastErr = err;
        console.log('    · evaluateIsolated 第 ' + (attempt + 1) + ' 次失败：' + String(err.message).slice(0, 140));
        await sleep(700);
      }
    }
    throw lastErr;
  }

  navigate(sessionId, targetUrl) {
    return this.send('Page.navigate', { url: targetUrl }, sessionId);
  }

  async waitFor(sessionId, expression, timeoutMs, label) {
    const deadline = Date.now() + (timeoutMs || 20000);
    let last = null;
    while (Date.now() < deadline) {
      try {
        last = await this.evaluate(sessionId, expression);
        if (last && last.ok) return last;
      } catch (err) { last = { ok: false, error: err.message }; }
      await sleep(350);
    }
    throw new Error('等待超时（' + (label || expression.slice(0, 60)) + '），最后结果：' + JSON.stringify(last).slice(0, 300));
  }
}

async function waitForDevToolsPort(profileDir, timeoutMs) {
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + (timeoutMs || 40000);
  while (Date.now() < deadline) {
    if (fs.existsSync(portFile)) {
      const port = parseInt(fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/)[0], 10);
      if (port > 0) return port;
    }
    await sleep(300);
  }
  throw new Error('等待 DevToolsActivePort 超时（浏览器没起来）');
}

/* ------------------------------------------------------------------ */
/* 复用表达式                                                          */
/* ------------------------------------------------------------------ */

const SPLIT_PROBE = [
  '(() => {',
  '  const root = document.querySelector(".split-translate-root");',
  '  if (!root) return { ok: false, why: "no-split-root" };',
  '  const left = root.querySelector(".st-pane-original");',
  '  const right = root.querySelector(".st-pane-translated");',
  '  const clone = right && right.querySelector(".st-clone-body");',
  '  return { ok: !!(left && right && clone), left: !!left, right: !!right, clone: !!clone };',
  '})()'
].join('\n');

const TRANSLATED_PROBE = [
  '(() => {',
  '  const clone = document.querySelector(".st-clone-body");',
  '  if (!clone) return { ok: false, why: "no-clone" };',
  '  const done = clone.querySelectorAll("[data-stt-id].st-done").length;',
  '  const failed = clone.querySelectorAll("[data-stt-id].st-failed").length;',
  '  return { ok: done > 4, done: done, failed: failed, hasPrefix: clone.textContent.indexOf("[\u4e2d]") >= 0 };',
  '})()'
].join('\n');

/** 写入测试设置（与 options 页相同的落盘路径） */
async function seedSettings(cdp, sessionId, settings) {
  return cdp.evaluateIsolated(sessionId, [
    'new Promise((resolve) => {',
    '  chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings: ' + JSON.stringify(settings) + ' }, (resp) => {',
    '    if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });',
    '    const s = (resp && resp.settings) || {};',
    '    resolve({ ok: !!(resp && resp.ok), baseURL: s.baseURL, model: s.model, autoMode: s.autoMode,',
    '      hasKey: !!s.apiKey, batchSize: s.batchSize, excludeList: s.excludeList,',
    '      autoTranslateDynamic: !!s.autoTranslateDynamic, showBanner: !!s.showBanner });',
    '  });',
    '})'
  ].join('\n'));
}

async function openPageAndWait(cdp, sessionId, pageUrl) {
  await cdp.navigate(sessionId, 'about:blank');
  await sleep(400);
  await cdp.navigate(sessionId, pageUrl);
  await cdp.waitFor(sessionId, SPLIT_PROBE, 45000, '等待自动分屏');
  return cdp.waitFor(sessionId, TRANSLATED_PROBE, 45000, '等待译文回填');
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  const edge = findEdge();
  if (!edge) {
    console.log('未找到 Edge/Chrome，跳过浏览器端到端测试');
    process.exit(0);
  }
  console.log('浏览器：' + edge);

  console.log('\n[0] 准备');
  fs.rmSync(TMP, { recursive: true, force: true });
  prepareExtension();
  check('已生成被测扩展副本（剥离 tools/ 与 tests/）', fs.existsSync(path.join(EXT_DIR, 'manifest.json')));
  const server = await startMockServer();
  check('mock OpenAI 接口已监听 127.0.0.1:' + PORT, true);

  const pageUrl = 'http://127.0.0.1:' + PORT + '/';
  const child = spawn(edge, [
    '--headless=new', '--no-sandbox', '--disable-gpu',
    '--disable-crash-reporter', '--disable-breakpad',
    '--no-first-run', '--no-default-browser-check',
    '--disable-features=Translate,msEdgeTranslate',
    '--remote-debugging-port=0',
    '--user-data-dir=' + PROFILE_DIR,
    '--disable-extensions-except=' + EXT_DIR,
    '--load-extension=' + EXT_DIR,
    '--window-size=1280,900',
    pageUrl
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let browserLog = '';
  child.stdout.on('data', (d) => { browserLog += d.toString(); });
  child.stderr.on('data', (d) => { browserLog += d.toString(); });

  let cdp = null;
  try {
    const port = await waitForDevToolsPort(PROFILE_DIR, 45000);
    console.log('  调试端口：' + port);
    cdp = await CDP.connect(port);
    check('已连接 CDP', true);

    const targets = (await cdp.send('Target.getTargets')).targetInfos;
    const extTarget = targets.find((t) => /^chrome-extension:\/\//.test(t.url));
    const extId = extTarget ? extTarget.url.split('/')[2] : null;
    check('扩展已加载（拿到扩展 ID）', !!extId, extId || '未找到 chrome-extension:// target');
    if (!extId) throw new Error('扩展未加载，后续测试无法进行');

    const pageTarget = targets.find((t) => t.type === 'page' && t.url.indexOf('127.0.0.1') >= 0)
      || targets.find((t) => t.type === 'page');
    if (!pageTarget) throw new Error('没有找到页面 target');
    const sessionId = await cdp.attach(pageTarget.targetId);

    /* ============================================================ */
    console.log('\n[1] 智能提示模式：语言检测 + 顶部提示条');
    /* ============================================================ */

    const banner = await cdp.waitFor(sessionId, [
      '(() => {',
      '  const b = document.querySelector(".st-banner");',
      '  if (!b) return { ok: false };',
      '  const anim = getComputedStyle(b).animationName;',
      '  if (anim && anim !== "none" && b.getAnimations && b.getAnimations().some(a => a.playState === "running")) {',
      '    return { ok: false, why: "animating" };',
      '  }',
      '  const r = b.getBoundingClientRect();',
      '  return { ok: r.top === 0, text: b.textContent,',
      '    buttons: [...b.querySelectorAll("button")].map(x => x.textContent.trim()),',
      '    position: getComputedStyle(b).position, background: getComputedStyle(b).backgroundColor,',
      '    top: r.top, splitExists: !!document.querySelector(".split-translate-root") };',
      '})()'
    ].join('\n'), 30000, '等待顶部提示条（含入场动画结束）');

    check('检测到非简体中文页面后自动出现顶部提示条', banner.ok === true, JSON.stringify(banner).slice(0, 140));
    check('提示条文案为「检测到 XXX 页面，是否翻译为简体中文？」',
      /\u68c0\u6d4b\u5230/.test(banner.text) && /\u9875\u9762\uff0c\u662f\u5426\u7ffb\u8bd1\u4e3a\u7b80\u4f53\u4e2d\u6587\uff1f/.test(banner.text),
      banner.text.slice(0, 90));
    check('提示条正确报出检测到的语言（法语）', /\u6cd5\u8bed/.test(banner.text), banner.text.slice(0, 90));
    check('提示条包含 翻译 / 忽略 / 设置 三个按钮',
      banner.buttons.some((t) => t.indexOf('\u7ffb\u8bd1') >= 0) &&
      banner.buttons.some((t) => t.indexOf('\u5ffd\u7565') >= 0) &&
      banner.buttons.some((t) => t.indexOf('\u8bbe\u7f6e') >= 0),
      banner.buttons.join(' | '));
    check('提示条固定在页面顶部（position:fixed, top=0）',
      banner.position === 'fixed' && banner.top === 0, banner.position + ' top=' + banner.top);
    check('提示条使用半透明背景', /rgba\(/.test(banner.background), banner.background);
    check('提示条出现时未进入分屏（需用户确认）', banner.splitExists === false);

    /* ============================================================ */
    console.log('\n[2] 写入配置（与 options 页同一条落盘路径）');
    /* ============================================================ */

    const saved = await seedSettings(cdp, sessionId, BASE_SETTINGS);
    check('设置保存成功', saved && saved.ok === true, JSON.stringify(saved).slice(0, 200));
    check('baseURL 保存正确（指向本地 mock）', /127\.0\.0\.1:18080/.test(saved.baseURL || ''), saved.baseURL);
    check('模型名保存正确', saved.model === 'mock-translate-v1', saved.model);
    check('API Key 保存成功', saved.hasKey === true);
    check('batchSize 被规范化为 8', saved.batchSize === 8, String(saved.batchSize));
    check('autoMode 保存为 smart', saved.autoMode === 'smart', saved.autoMode);

    /* ============================================================ */
    console.log('\n[3] 点击提示条「翻译」按钮 → 分屏 + 调接口 + 回填译文');
    /* ============================================================ */

    const clicked = await cdp.evaluate(sessionId, [
      '(() => {',
      '  const b = document.querySelector(".st-banner");',
      '  if (!b) return { ok: false, why: "no-banner" };',
      '  const btn = [...b.querySelectorAll("button")].find(x => x.textContent.trim() === "\u7ffb\u8bd1");',
      '  if (!btn) return { ok: false, why: "no-button" };',
      '  btn.click();',
      '  return { ok: true };',
      '})()'
    ].join('\n'));
    check('可点击提示条上的「翻译」按钮', clicked.ok === true, JSON.stringify(clicked));

    const split = await cdp.waitFor(sessionId, SPLIT_PROBE, 45000, '等待分屏出现');
    check('点击后进入分屏模式', split.ok === true, JSON.stringify(split));

    const translated = await cdp.waitFor(sessionId, TRANSLATED_PROBE, 45000, '等待译文回填');
    check('右栏译文已回填（.st-done > 4）', translated.done > 4, 'done=' + translated.done);
    check('无翻译失败段落', translated.failed === 0, String(translated.failed));
    check('译文来自接口（带 mock 前缀）', translated.hasPrefix === true);
    check('进入分屏后提示条自动消失',
      (await cdp.evaluate(sessionId, '!document.querySelector(".st-banner")')) === true);

    /* ============================================================ */
    console.log('\n[4] 分屏结构与镜像正确性');
    /* ============================================================ */

    const st = await cdp.evaluate(sessionId, [
      '(() => {',
      '  const root = document.querySelector(".split-translate-root");',
      '  const left = root.querySelector(".st-pane-original");',
      '  const right = root.querySelector(".st-pane-translated");',
      '  const clone = right.querySelector(".st-clone-body");',
      '  const rs = getComputedStyle(root);',
      '  const ls = getComputedStyle(left);',
      '  const chain = (el) => { const out = []; let n = el; while (n && n.tagName !== "BODY") {',
      '    out.unshift(n.tagName + (typeof n.className === "string" && n.className ? "." + n.className.trim().split(/\\s+/)[0] : ""));',
      '    n = n.parentElement; } return out.join(">"); };',
      '  return {',
      '    display: rs.display, flexDirection: rs.flexDirection, position: rs.position,',
      '    leftFlexBasis: getComputedStyle(left).flexBasis,',
      '    origInlineStyle: left.getAttribute("style") || "",',
      '    rootRatio: root.getAttribute("data-stt-ratio"),',
      '    rootFixedSize: root.getAttribute("data-stt-fixed-size"),',
      '    rightFlexGrow: getComputedStyle(right).flexGrow,',
      '    leftOverflow: ls.overflow,',
      '    hasDivider: !!root.querySelector(".st-divider"),',
      '    hasStatusbar: !!right.querySelector(".st-statusbar"),',
      '    leftSegments: left.querySelectorAll("[data-stt-id]").length,',
      '    rightSegments: clone.querySelectorAll("[data-stt-id]").length,',
      '    hasPrefix: clone.textContent.indexOf("[\u4e2d]") >= 0,',
      '    sampleTranslated: (clone.querySelector("[data-stt-id].st-done") || {}).textContent || "",',
      '    leftH1: (left.querySelector("h1") || {}).textContent || "",',
      '    rightH1: (clone.querySelector("h1") || {}).textContent || "",',
      '    leftChain: chain(left.querySelector("h1")), rightChain: chain(clone.querySelector("h1")),',
      '    leftCode: (left.querySelector("pre code") || {}).textContent || "",',
      '    rightCode: (clone.querySelector("pre code") || {}).textContent || "",',
      '    rightNoTranslate: (clone.querySelector("[translate=\\"no\\"]") || {}).textContent || "",',
      '    leftTable: left.querySelectorAll("table td").length,',
      '    rightTable: clone.querySelectorAll("table td").length,',
      '    leftLinks: left.querySelectorAll("a[href]").length,',
      '    rightLinks: clone.querySelectorAll("a[href]").length,',
      '    cloneHasScript: !!clone.querySelector("script"),',
      '    bodyOverflow: getComputedStyle(document.body).overflow,',
      '    htmlOverflow: getComputedStyle(document.documentElement).overflow,',
      '    h1Font: getComputedStyle(left.querySelector("h1")).fontFamily,',
      '    titleKept: document.title',
      '  };',
      '})()'
    ].join('\n'));

    check('分屏容器为 flex 行布局', st.display === 'flex' && st.flexDirection === 'row', st.display + '/' + st.flexDirection);
    check('分屏容器 fixed 覆盖整个视口', st.position === 'fixed', st.position);
    check('分屏比例已记录在根节点 data-stt-ratio（默认 50）', st.rootRatio === '50', st.rootRatio);
    check('原文栏尺寸已按比例换算为像素并记录', /^6\d\d$/.test(st.rootFixedSize || ''), String(st.rootFixedSize));
    check('原文栏被写入像素级内联 flex 值', /flex(-basis)?:\s*(0 0 )?6\d\dpx/.test(st.origInlineStyle), st.origInlineStyle.slice(0, 110));    check('右栏 flex-grow 撑满剩余空间', st.rightFlexGrow === '1', st.rightFlexGrow);
    check('左栏可滚动', /auto|scroll/.test(st.leftOverflow), st.leftOverflow);
    check('页面本身停止滚动（body/html overflow:hidden）',
      /hidden/.test(st.bodyOverflow) && /hidden/.test(st.htmlOverflow),
      'body=' + st.bodyOverflow + ' html=' + st.htmlOverflow);
    check('存在中间分隔线', st.hasDivider === true);
    check('存在右栏状态条', st.hasStatusbar === true);

    check('左栏登记翻译段（>4 段）', st.leftSegments > 4, String(st.leftSegments));
    check('右栏镜像段落数与左栏完全一致', st.leftSegments === st.rightSegments,
      'left ' + st.leftSegments + ' / right ' + st.rightSegments);

    check('左栏保留法文原文', /renard|for\u00eat|Pourquoi/i.test(st.leftH1), st.leftH1);
    check('右栏对应元素已替换为中文', /\u4e2d/.test(st.rightH1), st.rightH1);

    const stripPane = (c) => String(c)
      .replace(/^DIV\.split-translate-root>DIV\.st-pane-(original|translated)>/, '')
      .replace(/^DIV\.st-clone-body>/, '');
    check('镜像保持原有 DOM 层级（相对两栏的祖先链一致）',
      stripPane(st.leftChain) === stripPane(st.rightChain) && stripPane(st.leftChain).length > 0,
      stripPane(st.leftChain) + ' vs ' + stripPane(st.rightChain));
    check('左栏 h1 仍使用原站字体（CSS 未被破坏）', /Georgia|serif/i.test(st.h1Font), st.h1Font);
    check('镜像中已移除 <script>', st.cloneHasScript === false);

    check('代码块未被翻译（左栏）', /console\.log/.test(st.leftCode), st.leftCode.slice(0, 40));
    check('代码块未被翻译（右栏）',
      /console\.log/.test(st.rightCode) && st.rightCode.indexOf('\u4e2d') < 0, st.rightCode.slice(0, 40));
    check('translate="no" 区域未被翻译', /ne doit pas \u00eatre traduit/.test(st.rightNoTranslate),
      st.rightNoTranslate.slice(0, 50));
    check('表格结构完整镜像', st.leftTable === st.rightTable && st.leftTable > 0,
      'left ' + st.leftTable + ' / right ' + st.rightTable);
    check('链接（含 mailto）完整镜像', st.leftLinks === st.rightLinks && st.leftLinks > 0,
      'left ' + st.leftLinks + ' / right ' + st.rightLinks);
    check('页面 title 未被破坏', typeof st.titleKept === 'string' && st.titleKept.length > 0, st.titleKept);

    /* ============================================================ */
    console.log('\n[5] 接口调用与批量合并');
    /* ============================================================ */

    const report = await httpGetJson('http://127.0.0.1:' + PORT + '/__report');
    check('确实调用了 OpenAI 兼容的 /v1/chat/completions', report.calls > 0, 'calls=' + report.calls);
    check('请求做了批量合并（批次数 < 段落数）', report.calls < st.leftSegments,
      'batches=' + report.calls + ' segments=' + st.leftSegments + ' sizes=' + JSON.stringify(report.batches));
    check('每批不超过 batchSize=8', report.batches.every((n) => n <= 8), JSON.stringify(report.batches));
    check('请求体是待翻译原文数组', typeof report.sample === 'string' && report.sample.length > 0,
      String(report.sample).slice(0, 60));

    /* ============================================================ */
    console.log('\n[6] 拖动分隔线改变比例');
    /* ============================================================ */

    const drag = await cdp.evaluate(sessionId, [
      '(() => {',
      '  const root = document.querySelector(".split-translate-root");',
      '  const divider = root.querySelector(".st-divider");',
      '  const pane = root.querySelector(".st-pane-original");',
      '  const snap = () => ({ ratio: root.getAttribute("data-stt-ratio"),',
      '                        fixedSize: root.getAttribute("data-stt-fixed-size"),',
      '                        basis: getComputedStyle(pane).flexBasis,',
      '                        paneInline: pane.getAttribute("style") || "" });',
      '  const before = snap();',
      '  const r = divider.getBoundingClientRect();',
      '  const cx = Math.round(root.clientWidth * 0.72);',
      '  divider.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: r.left + 3, clientY: 100 }));',
      '  const maskShown = !!document.querySelector("[data-stt-mask]");',
      '  const draggingClass = divider.className.indexOf("st-dragging") >= 0;',
      '  document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: cx, clientY: 100 }));',
      '  const during = snap();',
      '  let maskRect = null;',
      '  const mask = document.querySelector("[data-stt-mask]");',
      '  if (mask) { const mr = mask.getBoundingClientRect(); maskRect = Math.round(mr.width) + "x" + Math.round(mr.height); }',
      '  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: cx, clientY: 100 }));',
      '  let saved = null;',
      '  try { saved = localStorage.getItem("splitTranslateRatio"); } catch (e) { saved = null; }',
      '  return { before: before, during: during, maskRect: maskRect, rootWidth: root.clientWidth,',
      '    maskShown: maskShown, draggingClass: draggingClass,',
      '    maskGone: !document.querySelector("[data-stt-mask]"),',
      '    draggingCleared: divider.className.indexOf("st-dragging") < 0,',
      '    savedRatio: saved,',
      '    rootAfter: root.getAttribute("data-stt-ratio") };',
      '})()'
    ].join('\n'));

    check('鼠标按下分隔线进入拖动状态（加 st-dragging 类）', drag.draggingClass === true);
    check('拖动期间显示透明遮罩层', drag.maskShown === true);
    check('遮罩层覆盖整个视口', drag.maskRect !== null && drag.maskRect.indexOf('1254x') === 0, String(drag.maskRect));
    check('拖动改变分屏比例（data-stt-ratio）', drag.before.ratio !== drag.during.ratio,
      drag.before.ratio + ' -> ' + drag.during.ratio);
    check('拖动比例换算为像素并记录（data-stt-fixed-size）',
      drag.during.fixedSize !== drag.before.fixedSize, drag.before.fixedSize + 'px -> ' + drag.during.fixedSize + 'px');
    check('像素尺寸与 72% 容器尺寸吻合',
      Math.abs(parseInt(drag.during.fixedSize, 10) - drag.rootWidth * 0.72) < 8,
      drag.during.fixedSize + 'px 期望≈' + Math.round(drag.rootWidth * 0.72) + 'px（容器 ' + drag.rootWidth + 'px）');
    check('原文栏内联样式被写入像素级 flex 值',
      /flex(-basis)?:\s*(0 0 )?\d+px/.test(drag.during.paneInline), drag.during.paneInline.slice(0, 110));
    check('拖动结束后移除遮罩层', drag.maskGone === true);
    check('拖动结束后清除 dragging 类', drag.draggingCleared === true);
    check('分屏比例持久化到 localStorage', drag.savedRatio === '72', String(drag.savedRatio));

    /* ============================================================ */
    console.log('\n[6.5] 译文栏链接可点（核心修复）');
    /* ============================================================ */

    // 先看清镜像里有哪些链接，并确认它们指向哪里
    const linkInfo = await cdp.evaluate(sessionId, [
      '(() => {',
      '  const clone = document.querySelector(".st-clone-body");',
      '  const left = document.querySelector(".st-pane-original");',
      '  const links = [...clone.querySelectorAll("a[href]")].map(a => ({',
      '    text: a.textContent.trim().slice(0, 20),',
      '    raw: a.getAttribute("href"),',
      '    abs: a.href,',
      '    target: a.getAttribute("target") || ""',
      '  }));',
      '  return { links: links, leftLinks: left.querySelectorAll("a[href]").length,',
      '           origin: location.origin, host: location.host };',
      '})()'
    ].join('\n'));
    check('译文镜像里存在可点击的链接', linkInfo.links.length >= 3,
      linkInfo.links.map((l) => l.raw).join(', '));
    check('普通链接都解析出绝对地址（mailto 除外）',
      linkInfo.links.filter((l) => String(l.raw).indexOf('mailto:') !== 0)
        .every((l) => String(l.abs).indexOf('http') === 0),
      'count=' + linkInfo.links.length + ' failing=' +
      JSON.stringify(linkInfo.links.filter((l) => String(l.raw).indexOf('mailto:') !== 0 &&
        String(l.abs).indexOf('http') !== 0).map((l) => l.abs)));
    check('相对链接已按 baseURI 解析为本站绝对地址',
      linkInfo.links.some((l) => l.raw === '/' && String(l.abs).indexOf(linkInfo.host) >= 0),
      JSON.stringify(linkInfo.links.filter((l) => l.raw === '/').map((l) => l.abs)));
    check('mailto 链接保持原样（不会被当成网页导航）',
      linkInfo.links.some((l) => String(l.raw).indexOf('mailto:') === 0),
      JSON.stringify(linkInfo.links.map((l) => l.raw)));

    /*
     * 真实点击译文里的链接。
     * 点击会真的导航、CDP 求值上下文随即失效，所以：
     *   1) 先用 TEST_NAV_HOOK 拿到「会往哪跳」的决策（不真的跳）；
     *   2) 再用一个一次性临时标签页做真实点击，验证确实跳转成功。
     */
    const hookOn = await cdp.evaluateIsolated(sessionId, [
      'new Promise((resolve) => {',
      '  chrome.runtime.sendMessage({ type: "TAB_ACTION", action: "TEST_NAV_HOOK", enable: true }, (resp) => {',
      '    if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });',
      '    resolve({ ok: !!(resp && resp.result && resp.result.enabled), raw: JSON.stringify(resp) });',
      '  });',
      '})'
    ].join('\n'));
    check('已启用导航决策测试钩子', hookOn.ok === true, JSON.stringify(hookOn));

    const decide = await cdp.evaluate(sessionId, [
      'new Promise((resolve) => {',
      '  const clone = document.querySelector(".st-clone-body");',
      '  const links = [...clone.querySelectorAll("a[href]")];',
      '  const same = links.find(x => { try { return new URL(x.getAttribute("href"), location.href).host === location.host; } catch (e) { return false; } });',
      '  if (!same) return resolve({ ok: false, why: "no-same-link" });',
      '  document.documentElement.removeAttribute("data-stt-nav-log");',
      '  same.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));',
      '  setTimeout(() => {',
      '    let log = [];',
      '    try { log = JSON.parse(document.documentElement.getAttribute("data-stt-nav-log") || "[]"); } catch (e) { log = []; }',
      '    resolve({ ok: log.length > 0, log: log, stillSplit: !!document.querySelector(".split-translate-root") });',
      '  }, 500);',
      '})'
    ].join('\n'));
    check('点击译文站内链接会走扩展导航通道', decide.ok === true, JSON.stringify(decide).slice(0, 220));
    check('站内链接决策为「当前标签页」(sameTab)',
      (decide.log || []).some((e) => e.disposition === 'sameTab'), JSON.stringify(decide.log || []));
    check('被拦截后页面没有跳走（仍处于分屏）', decide.stillSplit === true, String(decide.stillSplit));

    // 外站链接用同一条链路验证分离策略（钩子拦截，不会真的新开标签页）
    const crossDecide = await cdp.evaluate(sessionId, [
      'new Promise((resolve) => {',
      '  const clone = document.querySelector(".st-clone-body");',
      '  const cross = [...clone.querySelectorAll("a[href]")].find(x => {',
      '    try { const u = new URL(x.getAttribute("href"), location.href); return u.host !== location.host && u.protocol.indexOf("http") === 0; } catch (e) { return false; }',
      '  });',
      '  if (!cross) return resolve({ ok: false, why: "no-cross-link" });',
      '  document.documentElement.removeAttribute("data-stt-nav-log");',
      '  cross.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));',
      '  setTimeout(() => {',
      '    let log = [];',
      '    try { log = JSON.parse(document.documentElement.getAttribute("data-stt-nav-log") || "[]"); } catch (e) { log = []; }',
      '    resolve({ ok: true, log: log });',
      '  }, 500);',
      '})'
    ].join('\n'));
    check('外站链接决策为「新开标签页」(newTab)',
      (crossDecide.log || []).some((e) => e.disposition === 'newTab'), JSON.stringify(crossDecide.log || []));

    // 关掉钩子，恢复真实行为
    await cdp.evaluate(sessionId, [
      'new Promise((resolve) => {',
      '  chrome.runtime.sendMessage({ type: "TAB_ACTION", action: "TEST_NAV_HOOK", enable: false }, () => resolve(1));',
      '})'
    ].join('\n'));

    // background 直接拒绝危险协议
    const badNav = await cdp.evaluate(sessionId, [
      'new Promise((resolve) => {',
      '  chrome.runtime.sendMessage({ type: "NAVIGATE", url: "javascript:alert(1)" }, (resp) => {',
      '    resolve({ ok: !!(resp && resp.ok), error: resp && resp.error });',
      '  });',
      '})'
    ].join('\n'));
    check('javascript: 协议被 background 拒绝', badNav.ok === false, JSON.stringify(badNav));

    // 用一次性临时标签页做真实点击，验证「点了真的会跳」
    const navProbe = await cdp.newTab('about:blank');
    await sleep(600);
    await cdp.navigate(navProbe.sessionId, pageUrl);
    // 先确保这个标签页进入分屏：不依赖自动模式，直接点提示条上的「翻译」
    await cdp.waitFor(navProbe.sessionId, [
      '(() => {',
      '  const btn = [...document.querySelectorAll(".st-banner button")].find(b => b.textContent.trim() === "\u7ffb\u8bd1");',
      '  if (!btn) return { ok: false };',
      '  btn.click();',
      '  return { ok: true };',
      '})()'
    ].join('\n'), 30000, '临时页点击提示条翻译');
    await cdp.waitFor(navProbe.sessionId, TRANSLATED_PROBE, 60000, '临时页等待译文回填');
    const realClick = await cdp.evaluate(navProbe.sessionId, [
      '(() => {',
      '  const clone = document.querySelector(".st-clone-body");',
      '  const a = [...clone.querySelectorAll("a[href]")].find(x => {',
      '    try { const u = new URL(x.getAttribute("href"), location.href); return u.pathname === "/" && u.host === location.host; } catch (e) { return false; }',
      '  });',
      '  if (!a) return { ok: false, why: "no-link" };',
      '  const url = a.href;',
      '  a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));',
      '  return { ok: true, clicked: url };',
      '})()'
    ].join('\n'));
    check('能真实点击译文栏里的链接', realClick.ok === true, JSON.stringify(realClick));
    check('被点击的链接是本站绝对地址', String(realClick.clicked || '').indexOf(pageUrl) === 0, String(realClick.clicked));

    /*
     * 点击后标签页会重新加载。导航会让 CDP 会话上下文重建，
     * 所以这里等页面加载完、提示条重新出现，再点一次「翻译」确认
     * 「导航之后的页面依然能被翻译」——这正是用户点新闻链接后想要的结果。
     */
    let navOk = false;
    try {
      await cdp.waitFor(navProbe.sessionId, [
        '(() => {',
        '  const btn = [...document.querySelectorAll(".st-banner button")].find(b => b.textContent.trim() === "\u7ffb\u8bd1");',
        '  if (!btn) return { ok: false };',
        '  btn.click();',
        '  return { ok: true };',
        '})()'
      ].join('\n'), 40000, '导航后重新点翻译');
      await cdp.waitFor(navProbe.sessionId, TRANSLATED_PROBE, 60000, '导航后新页面再次分屏翻译');
      navOk = true;
    } catch (err) { navOk = false; }
    check('点击译文链接后页面真的重新加载并可再次分屏翻译', navOk === true);
    try { await cdp.send('Target.closeTarget', { targetId: navProbe.targetId }); } catch (e) { /* ignore */ }

    // 回到测试页继续后面的用例（切到完全自动，省去再点一次提示条）
    await seedSettings(cdp, sessionId, Object.assign({}, BASE_SETTINGS, { autoMode: 'auto' }));
    await cdp.navigate(sessionId, 'about:blank');
    await sleep(400);
    await cdp.navigate(sessionId, pageUrl);
    await cdp.waitFor(sessionId, SPLIT_PROBE, 45000, '回到测试页并重新分屏');
    await cdp.waitFor(sessionId, TRANSLATED_PROBE, 45000, '等待译文回填');

    /* ============================================================ */
    console.log('\n[6.6] 四种分屏版面');
    /* ============================================================ */

    const LAYOUTS_TO_TEST = [
      ['original-top', 'column', true, true],
      ['original-bottom', 'column', false, true],
      ['original-right', 'row', false, true],
      ['original-left', 'row', true, true]
    ];
    for (const [layout, expectedDir, originalFirst] of LAYOUTS_TO_TEST) {
      // 用 background 的 TAB_ACTION 通道下发（与 popup 完全一致的路径），最稳
      const raw = await cdp.evaluate(sessionId, [
        'new Promise((resolve) => {',
        '  chrome.runtime.sendMessage({ type: "TAB_ACTION", action: "SET_LAYOUT", layout: ' + JSON.stringify(layout) + ' }, (resp) => {',
        '    if (chrome.runtime.lastError) return resolve({ err: chrome.runtime.lastError.message });',
        '    resolve({ resp: resp === undefined ? "undefined" : JSON.stringify(resp).slice(0, 160) });',
        '  });',
        '})'
      ].join('\n'));
      console.log('    · TAB_ACTION SET_LAYOUT(' + layout + ') → ' + JSON.stringify(raw));
      await sleep(700);
      const r = await cdp.evaluate(sessionId, [
        '(() => {',
        '  const root = document.querySelector(".split-translate-root");',
        '  if (!root) return { noRoot: true, bodyChildren: document.body.children.length };',
        '  const kids = [...root.children].map(c => c.getAttribute("data-stt-pane") || "divider");',
        '  const orig = root.querySelector(".st-pane-original");',
        '  return { layout: root.getAttribute("data-stt-layout"),',
        '    direction: getComputedStyle(root).flexDirection,',
        '    order: kids,',
        '    origFirst: kids.indexOf("original") < kids.indexOf("translated"),',
        '    fixedSize: root.getAttribute("data-stt-fixed-size"),',
        '    axis: root.getAttribute("data-stt-axis"),',
        '    origInline: orig ? (orig.getAttribute("style") || "") : "",',
        '    dividerCursor: root.querySelector(".st-divider") ? getComputedStyle(root.querySelector(".st-divider")).cursor : "" };',
        '})()'
      ].join('\n'));
      check(`版面 ${layout}：data-stt-layout 已更新`, r.layout === layout, String(r.layout));
      check(`版面 ${layout}：主轴方向为 ${expectedDir}`, r.direction === expectedDir, String(r.direction));
      check(`版面 ${layout}：原文${originalFirst ? '在' : '不在'}前`,
        r.origFirst === originalFirst, r.order.join(' | '));
      check(`版面 ${layout}：固定份额一栏写入了像素尺寸`,
        /^\d+$/.test(String(r.fixedSize)) && /px/.test(r.origInline), String(r.fixedSize));
      check(`版面 ${layout}：滚动轴记录为 ${expectedDir === 'row' ? 'x' : 'y'}`,
        r.axis === (expectedDir === 'row' ? 'x' : 'y'), String(r.axis));
      check(`版面 ${layout}：分隔线光标为 ${expectedDir === 'row' ? 'col-resize' : 'row-resize'}`,
        r.dividerCursor === (expectedDir === 'row' ? 'col-resize' : 'row-resize'), String(r.dividerCursor));
    }

    /* ============================================================ */
    console.log('\n[6.7] 译文独立小窗（Document Picture-in-Picture）');
    /* ============================================================ */

    const pipProbe = await cdp.evaluate(sessionId,
      '(() => ({ supported: typeof documentPictureInPicture !== "undefined" && typeof documentPictureInPicture.requestWindow === "function" }))()');
    check('浏览器暴露了 Document Picture-in-Picture API', pipProbe.supported === true, JSON.stringify(pipProbe));

    // 无头环境里 requestWindow 需要用户手势，用测试钩子注入一个等价的小窗来验证搬运逻辑
    const hookState = await cdp.evaluate(sessionId, [
      'new Promise((resolve) => {',
      '  chrome.runtime.sendMessage({ type: "TAB_ACTION", action: "TEST_DETACH_WINDOW", enable: true }, (resp) => {',
      '    resolve({ ok: !!(resp && resp.result && resp.result.enabled) });',
      '  });',
      '})'
    ].join('\n'));
    check('已注入独立小窗测试替身', hookState.ok === true, JSON.stringify(hookState));

    const detach = await cdp.evaluate(sessionId, [
      'new Promise((resolve) => {',
      '  chrome.runtime.sendMessage({ type: "TAB_ACTION", action: "DETACH" }, (resp) => {',
      '    if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });',
      '    resolve({ ok: !!(resp && resp.ok), raw: JSON.stringify(resp).slice(0, 120) });',
      '  });',
      '})'
    ].join('\n'));
    check('译文栏成功放入独立小窗', detach.ok === true, JSON.stringify(detach));
    await sleep(1200);

    const detachedState = await cdp.evaluate(sessionId, [
      '(() => {',
      '  const root = document.querySelector(".split-translate-root");',
      '  const orig = root.querySelector(".st-pane-original");',
      '  const frame = document.querySelector("iframe[data-stt-fake-pip]");',
      '  const win = frame ? frame.contentWindow : null;',
      '  let inPip = null, cloneInPip = null, text = "", styleCount = -1;',
      '  try {',
      '    inPip = !!(win && win.document.querySelector(".st-pane-translated"));',
      '    cloneInPip = !!(win && win.document.querySelector(".st-clone-body"));',
      '    text = win ? win.document.body.textContent.slice(0, 200) : "";',
      '    styleCount = win ? win.document.querySelectorAll("style, link[rel=stylesheet]").length : -1;',
      '  } catch (e) { inPip = "err:" + e.message; }',
      '  return { hasFrame: !!frame, inPip: inPip, cloneInPip: cloneInPip, translatedText: text,',
      '    paneStillInMainDoc: !!document.querySelector(".split-translate-root .st-pane-translated"),',
      '    originalStillThere: !!orig, styleCount: styleCount,',
      '    detachedClass: win && win.document.querySelector(".st-detached") ? true : false };',
      '})()'
    ].join('\n'));
    check('译文栏已被搬进小窗文档', detachedState.inPip === true, JSON.stringify(detachedState).slice(0, 220));
    check('小窗里带着译文镜像内容', detachedState.cloneInPip === true, String(detachedState.cloneInPip));
    check('小窗里的译文文本非空', String(detachedState.translatedText).length > 10,
      String(detachedState.translatedText).slice(0, 60));
    check('小窗中已复制样式表', detachedState.styleCount > 0, String(detachedState.styleCount));
    check('原文栏仍留在主页面', detachedState.originalStillThere === true);
    check('译文栏已从小窗文档中的主容器移除',
      detachedState.paneStillInMainDoc === false, String(detachedState.paneStillInMainDoc));

    const undetach = await cdp.evaluate(sessionId, [
      'new Promise((resolve) => {',
      '  chrome.runtime.sendMessage({ type: "TAB_ACTION", action: "UNDETACH" }, (resp) => {',
      '    resolve({ ok: !!(resp && resp.ok), detached: resp && resp.result && resp.result.detached });',
      '  });',
      '})'
    ].join('\n'));
    check('可以收回独立小窗', undetach.ok === true, JSON.stringify(undetach));
    await sleep(900);
    const backState = await cdp.evaluate(sessionId, [
      '(() => {',
      '  const root = document.querySelector(".split-translate-root");',
      '  return { paneBack: !!root.querySelector(".st-pane-translated"),',
      '           cloneBack: !!root.querySelector(".st-clone-body"),',
      '           origPresent: !!root.querySelector(".st-pane-original"),',
      '           layout: root.getAttribute("data-stt-layout"),',
      '           ratio: root.getAttribute("data-stt-ratio"),',
      '           frameGone: !document.querySelector("iframe[data-stt-fake-pip]") };',
      '})()'
    ].join('\n'));
    check('收回后译文栏回到分屏容器内', backState.paneBack === true && backState.cloneBack === true,
      JSON.stringify(backState));
    check('收回后原文栏仍在', backState.origPresent === true);
    check('收回后版面与比例仍有效', !!backState.layout && !!backState.ratio, JSON.stringify(backState));

    // 关掉替身，恢复真实行为
    await cdp.evaluate(sessionId, [
      'new Promise((resolve) => {',
      '  chrome.runtime.sendMessage({ type: "TAB_ACTION", action: "TEST_DETACH_WINDOW", enable: false }, () => resolve(1));',
      '})'
    ].join('\n'));

    /* ============================================================ */
    console.log('\n[6.8] 思考强度 reasoning_effort');
    /* ============================================================ */

    const effortSaved = await seedSettings(cdp, sessionId,
      Object.assign({}, BASE_SETTINGS, { autoMode: 'auto', reasoningEffort: 'high' }));
    check('设置里可以选择思考强度 high', effortSaved && effortSaved.ok === true, JSON.stringify(effortSaved).slice(0, 120));

    // 用一条全新的文本，避免命中缓存而不发请求
    const effortCall = await cdp.evaluateIsolated(sessionId, [
      'new Promise((resolve) => {',
      '  chrome.runtime.sendMessage({ type: "TRANSLATE_BATCH", texts: ["Reasoning effort probe sentence number one."] }, (resp) => {',
      '    resolve({ ok: !!(resp && resp.ok), err: chrome.runtime.lastError ? chrome.runtime.lastError.message : (resp && resp.error) });',
      '  });',
      '})'
    ].join('\n'));
    check('带 reasoning_effort 的翻译请求成功', effortCall.ok === true, JSON.stringify(effortCall));

    const reportEffort = await httpGetJson('http://127.0.0.1:' + PORT + '/__report');
    check('请求体里带上了 reasoning_effort=high',
      reportEffort.efforts.indexOf('high') >= 0, JSON.stringify(reportEffort.efforts.slice(-4)));

    // 关掉后不应再发送该字段
    await seedSettings(cdp, sessionId, Object.assign({}, BASE_SETTINGS, { autoMode: 'auto', reasoningEffort: '' }));
    await cdp.evaluateIsolated(sessionId, [
      'new Promise((resolve) => {',
      '  chrome.runtime.sendMessage({ type: "TRANSLATE_BATCH", texts: ["Reasoning effort probe sentence number two."] }, () => resolve(1));',
      '})'
    ].join('\n'));
    const reportOff = await httpGetJson('http://127.0.0.1:' + PORT + '/__report');
    check('关闭思考强度后不再发送该字段',
      reportOff.efforts[reportOff.efforts.length - 1] === '(\u672a\u53d1\u9001)',
      JSON.stringify(reportOff.efforts.slice(-3)));

    /* ============================================================ */
    console.log('\n[7] 恢复原页面');
    /* ============================================================ */

    const restored = await cdp.evaluate(sessionId, [
      '(() => {',
      '  const btn = [...document.querySelectorAll(".st-statusbar button")].find(b => b.textContent.indexOf("\u6062\u590d") >= 0);',
      '  if (!btn) return { ok: false, why: "no-restore-button" };',
      '  btn.click();',
      '  return new Promise((resolve) => setTimeout(() => resolve({',
      '    ok: true,',
      '    rootGone: !document.querySelector(".split-translate-root"),',
      '    bodyH1: !!document.querySelector("body h1"),',
      '    h1: (document.querySelector("h1") || {}).textContent || "",',
      '    bodyScroll: getComputedStyle(document.body).overflow,',
      '    htmlScroll: getComputedStyle(document.documentElement).overflow,',
      '    tables: document.querySelectorAll("table td").length,',
      '    links: document.querySelectorAll("a[href]").length',
      '  }), 800));',
      '})()'
    ].join('\n'));
    check('点击状态条「恢复原页面」生效', restored.ok === true, JSON.stringify(restored).slice(0, 120));
    check('恢复后分屏容器被移除', restored.rootGone === true);
    check('恢复后原始 DOM 回到 body（h1 存在）', restored.bodyH1 === true, restored.h1);
    check('恢复后页面仍是法文原文', /renard|for\u00eat|Pourquoi/i.test(restored.h1), restored.h1);
    check('恢复后滚动能力交还页面',
      !/hidden/.test(restored.bodyScroll) && !/hidden/.test(restored.htmlScroll),
      'body=' + restored.bodyScroll + ' html=' + restored.htmlScroll);
    check('恢复后表格与链接结构完好', restored.tables > 0 && restored.links > 0,
      'td=' + restored.tables + ' a=' + restored.links);

    /* ============================================================ */
    console.log('\n[8] 完全自动模式 + 缓存');
    /* ============================================================ */

    const autoSaved = await seedSettings(cdp, sessionId, Object.assign({}, BASE_SETTINGS, { autoMode: 'auto' }));
    check('切换到 autoMode=auto 成功', autoSaved.autoMode === 'auto', autoSaved.autoMode);

    const callsBefore = (await httpGetJson('http://127.0.0.1:' + PORT + '/__report')).calls;
    const autoResult = await openPageAndWait(cdp, sessionId, pageUrl);
    check('完全自动模式下无需点击即分屏并完成翻译', autoResult.ok === true, JSON.stringify(autoResult));
    check('完全自动模式下不显示提示条',
      (await cdp.evaluate(sessionId, '!document.querySelector(".st-banner")')) === true);

    const report2 = await httpGetJson('http://127.0.0.1:' + PORT + '/__report');
    check('二次翻译命中缓存（未新增接口调用）', report2.calls === callsBefore,
      'before=' + callsBefore + ' after=' + report2.calls);

    /* ============================================================ */
    console.log('\n[9] 动态加载内容续翻');
    /* ============================================================ */

    const dynSaved = await seedSettings(cdp, sessionId,
      Object.assign({}, BASE_SETTINGS, { autoMode: 'auto', autoTranslateDynamic: true }));
    check('开启 autoTranslateDynamic', dynSaved.autoTranslateDynamic === true);
    await openPageAndWait(cdp, sessionId, pageUrl);

    const dynamicText = await cdp.evaluate(sessionId,
      '(() => { const fn = window.__addDynamic; return typeof fn === "function" ? fn() : null; })()');
    check('测试页成功注入动态段落', !!dynamicText, String(dynamicText).slice(0, 50));

    const dynamicDone = await cdp.waitFor(sessionId, [
      '(() => {',
      '  const clone = document.querySelector(".st-clone-body");',
      '  if (!clone) return { ok: false, why: "no-clone" };',
      '  const t = clone.textContent;',
      '  const mirrored = t.indexOf("dynamiquement") >= 0;',
      '  const translated = t.indexOf("[\u4e2d]Un paragraphe") >= 0;',
      '  return { ok: mirrored || translated, mirrored: mirrored, translated: translated };',
      '})()'
    ].join('\n'), 30000, '等待动态内容被续翻');

    check('动态新增内容出现在右栏镜像中', dynamicDone.mirrored === true, JSON.stringify(dynamicDone));
    check('动态新增段落被续翻为中文', dynamicDone.translated === true, JSON.stringify(dynamicDone));

    /* ============================================================ */
    console.log('\n[10] 排除名单');
    /* ============================================================ */

    await seedSettings(cdp, sessionId, Object.assign({}, BASE_SETTINGS, { excludeList: '127.0.0.1' }));
    await cdp.navigate(sessionId, 'about:blank');
    await sleep(400);
    await cdp.navigate(sessionId, pageUrl);
    await sleep(4500);
    const excluded = await cdp.evaluate(sessionId,
      '(() => ({ split: !!document.querySelector(".split-translate-root"), banner: !!document.querySelector(".st-banner") }))()');
    check('命中排除名单时不自动分屏', excluded.split === false, JSON.stringify(excluded));
    check('命中排除名单时不显示提示条', excluded.banner === false, JSON.stringify(excluded));

    /* ============================================================ */
    console.log('\n[11] 运行期无未捕获异常');
    /* ============================================================ */

    const realExceptions = cdp.exceptions.filter((e) => String(e).indexOf('chrome.runtime') < 0);
    check('页面与内容脚本没有抛出未捕获异常', realExceptions.length === 0,
      realExceptions.slice(0, 2).map((e) => String(e).split('\n')[0]).join(' | '));

  } catch (err) {
    fail++;
    failures.push(err.message);
    console.log('\n  [FAIL] 测试过程异常：' + err.message + '（发生在：' + currentStep + '）');
    if (cdp) {
      if (cdp.console.length) {
        console.log('  页面控制台（尾部 20 条）：');
        cdp.console.slice(-20).forEach((l) => console.log('    ' + l.slice(0, 220)));
      }
      if (cdp.exceptions.length) {
        console.log('  未捕获异常：');
        cdp.exceptions.slice(-5).forEach((l) => console.log('    ' + String(l).split('\n').slice(0, 4).join(' | ')));
      }
    }
    if (browserLog) {
      const tail = browserLog.split('\n').filter((l) => l.trim() && !/DevTools listening/.test(l)).slice(-8);
      if (tail.length) console.log('  浏览器日志尾部：\n' + tail.map((l) => '    ' + l).join('\n'));
    }
  } finally {
    try { if (cdp) cdp.ws.close(); } catch (e) { /* ignore */ }
    child.kill();
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* ignore */ } }, 900);
    server.close();
  }

  console.log('\n结果：' + pass + ' 项通过，' + fail + ' 项失败');
  if (failures.length) {
    console.log('\n失败项：');
    failures.forEach((f) => console.log('  - ' + f));
  }
  await sleep(700);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('驱动脚本异常：', err);
  process.exit(2);
});
