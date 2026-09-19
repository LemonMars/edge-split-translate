/**
 * content/content.js —— 内容脚本主逻辑
 *
 * 职责：
 *   1. 检测页面语言，决定是否提示 / 自动翻译；
 *   2. 扫描 DOM，把可翻译的文本节点登记为「翻译段」（segment），并在原节点外包一层
 *      <span data-stt-id="N">，这样右侧镜像可以精确、按结构地回填译文；
 *   3. 分屏：左栏放原始 DOM（整棵子树搬进容器，原 CSS 完全生效），右栏放 deep clone 的镜像；
 *   4. 批量调用 AI 接口翻译，逐段回填；
 *   5. 支持动态加载内容（MutationObserver）、可选图片取字、可拖动分隔线、滚动同步。
 */
(function () {
  'use strict';

  // 防止脚本被重复注入（例如 popup 里手动 executeScript 过）
  if (window.__SPLIT_TRANSLATE_LOADED__) return;
  window.__SPLIT_TRANSLATE_LOADED__ = true;

  var Lang = self.SplitTranslateLang;
  var Engine = self.SplitTranslate;

  /* ================================================================== */
  /* 0. 运行状态                                                         */
  /* ================================================================== */

  var state = {
    settings: null,
    tabId: null,
    detection: null,
    splitActive: false,
    translating: false,
    ratio: 50,
    segmentMap: new Map(),   // segId(number) -> { node: Element, text: string, image: boolean }
    doneCount: 0,
    totalCount: 0,
    error: '',
    lastSentState: ''
  };

  /** 已包裹过的文本节点（WeakSet，元素被移除后自动回收） */
  var wrappedNodes = new WeakSet();
  /** 已处理过的 <img> */
  var handledImages = new WeakSet();
  var segSeq = 1;

  var ui = {
    root: null, left: null, right: null, divider: null,
    cloneBody: null, banner: null, statusbar: null, statusText: null,
    progressBar: null, toast: null, styleEl: null, scrollLock: false
  };

  var observer = null;
  var pendingRoots = new Set();
  var flushTimer = null;
  var ocrTimer = null;
  var lastUrl = location.href;

  /** 页面级翻译预算，防止动态页面把 API 额度吃光 */
  var BUDGET = { used: 0, max: 150000 };

  if (!Lang || !Engine) {
    console.warn('[分屏翻译] 依赖库未加载，脚本退出');
    return;
  }

  /* ================================================================== */
  /* 1. 通用小工具                                                       */
  /* ================================================================== */

  function log() { Engine.log.apply(null, arguments); }

  function $(sel, ctx) { return (ctx || document).querySelector(sel); }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  /** 极简 toast 提示 */
  function toast(msg, isError, ms) {
    try {
      if (!ui.toast) {
        ui.toast = el('div', 'st-toast');
        (document.body || document.documentElement).appendChild(ui.toast);
      }
      ui.toast.textContent = msg;
      ui.toast.className = 'st-toast' + (isError ? ' st-error' : '');
      // 强制重排以便重放动画
      void ui.toast.offsetWidth;
      ui.toast.classList.add('st-show');
      clearTimeout(ui.toast.__timer);
      ui.toast.__timer = setTimeout(function () {
        if (ui.toast) ui.toast.classList.remove('st-show');
      }, ms || 2600);
    } catch (e) { /* ignore */ }
  }

  /** 取消所有网页自带动画/过渡，避免分屏时出现跳动 */
  function injectStyleOnce() {
    if (document.getElementById('split-translate-style')) return;
    var s = document.createElement('style');
    s.id = 'split-translate-style';
    s.textContent =
      '.split-translate-root *, .split-translate-root *::before, .split-translate-root *::after {' +
      ' animation-duration: 0.001s !important; animation-delay: 0s !important;' +
      ' transition-duration: 0.001s !important; transition-delay: 0s !important;' +
      ' scroll-behavior: auto !important; }';
    (document.head || document.documentElement).appendChild(s);
  }

  /** 确保 content.css 一定存在（iframe 注入等场景的兜底） */
  function ensureStylesheet() {
    try {
      var href = chrome.runtime.getURL('content/content.css');
      var found = [].some.call(document.querySelectorAll('link[rel="stylesheet"]'), function (l) {
        return l.href === href || (l.getAttribute('href') || '').indexOf('content/content.css') >= 0;
      });
      if (!found) {
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        (document.head || document.documentElement).appendChild(link);
      }
    } catch (e) { /* ignore */ }
  }

  /** 把原页面 <head> 里的样式搬进左栏，保证左侧原文渲染与原页面一致 */
  function moveStylesInto(container) {
    var nodes = document.head ? document.head.querySelectorAll('style, link[rel="stylesheet"]') : [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.id === 'split-translate-style' || n.id === 'split-translate-clone-style') continue;
      if (n.closest && n.closest('.split-translate-root')) continue; // 已在容器内
      container.appendChild(n); // appendChild 对已存在节点等价于移动
    }
  }

  function looksLikeUrl(t) {
    return /^(https?:\/\/|www\.)\S+$/i.test(t.trim()) || /^[\w.+-]+@[\w-]+\.[\w.]+$/.test(t.trim());
  }
  function looksLikeCode(t) {
    return /[{}<>();=]{2,}/.test(t) || /^\s*(function|const|let|var|import|export|class|def|SELECT|INSERT)\b/.test(t);
  }
  function hasCjk(t) { return /[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(t); }

  /** 该文本段是否值得送去翻译 */
  function isWorthTranslating(text) {
    var t = text.trim();
    if (t.length < 2) return false;
    if (looksLikeUrl(t)) return false;
    if (/^[\d\s\p{P}\p{S}]+$/u.test(t)) return false;          // 纯数字 / 纯标点
    if (!hasCjk(t) && t.replace(/[^A-Za-z\u00C0-\u024F]/g, '').length < 2) return false; // 有效字母太少
    if (t.length > 40 && looksLikeCode(t)) return false;
    return true;
  }

  /* ================================================================== */
  /* 2. DOM 扫描：登记翻译段                                             */
  /* ================================================================== */

  /** 判断元素是否被隐藏（不参与翻译） */
  function isHidden(elNode) {
    if (!elNode || elNode.nodeType !== 1) return false;
    if (elNode.hasAttribute('hidden')) return true;
    if (elNode.getAttribute('aria-hidden') === 'true') return true;
    try {
      var cs = getComputedStyle(elNode);
      if (cs.display === 'none' || cs.visibility === 'hidden') return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  /** 诊断：统计整页文本节点数量（仅在需要排查时被调用） */
  function countAllTextNodes() {
    try {
      var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      var n = 0, nonBlank = 0, t;
      while ((t = w.nextNode())) {
        n++;
        if (t.nodeValue && t.nodeValue.trim()) nonBlank++;
      }
      return { all: n, nonBlank: nonBlank };
    } catch (e) { return { all: -1, nonBlank: -1, error: String(e) }; }
  }

  /** 是否处于跳过区域（代码块、编辑器、no-translate 标记） */
  function inSkipZone(node, stopAt) {
    var n = node.parentElement;
    var depth = 0;
    while (n && n !== stopAt && depth++ < 60) {
      var tag = n.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE' ||
          tag === 'CODE' || tag === 'PRE' || tag === 'KBD' || tag === 'SAMP' ||
          tag === 'SVG' || tag === 'CANVAS' || tag === 'MATH' || tag === 'TEXTAREA' ||
          tag === 'INPUT' || tag === 'SELECT' || tag === 'OPTION') {
        return true;
      }
      if (n.isContentEditable) return true;
      if (n.classList && (n.classList.contains('notranslate') || n.classList.contains('st-no-translate'))) return true;
      if (n.getAttribute && n.getAttribute('translate') === 'no') return true;
      n = n.parentElement;
    }
    return false;
  }

  /** 找到文本节点所属的「块级上下文」（译文按块分批，保证上下文连贯） */
  var INLINE_TAGS = {
    A: 1, SPAN: 1, EM: 1, STRONG: 1, B: 1, I: 1, U: 1, S: 1, SMALL: 1, BIG: 1, SUB: 1, SUP: 1,
    CODE: 1, KBD: 1, SAMP: 1, VAR: 1, MARK: 1, ABBR: 1, CITE: 1, Q: 1, TIME: 1, LABEL: 1,
    BDI: 1, BDO: 1, WBR: 1, FONT: 1, INS: 1, DEL: 1, TT: 1, NOBR: 1, RUBY: 1, RT: 1, RP: 1,
    IMG: 1, BR: 1, BUTTON: 1, ACRONYM: 1, DFN: 1, DATA: 1, OUTPUT: 1, SLOT: 1
  };
  var SKIP_BLOCK_TAGS = { CODE: 1, PRE: 1, KBD: 1, SAMP: 1, VAR: 1, TEXTAREA: 1 };

  function isBlockish(node, stopAt) {
    if (!node || node.nodeType !== 1) return false;
    if (node === stopAt) return false;
    var tag = node.tagName;
    if (SKIP_BLOCK_TAGS[tag]) return false;
    if (node.classList && node.classList.contains('split-translate-root')) return false;
    if (INLINE_TAGS[tag]) return false;
    // 自定义元素/web component 按 display 判断
    if (tag.indexOf('-') > 0) {
      try {
        var d = getComputedStyle(node).display;
        return !(d === 'inline' || d === 'contents' || d === 'inline-block');
      } catch (e) { return true; }
    }
    return true;
  }

  function nearestBlock(node, stopAt) {
    var n = node.parentElement;
    var last = node.parentElement;
    var depth = 0;
    while (n && n !== stopAt && depth++ < 40) {
      if (isBlockish(n, stopAt)) return n;
      last = n;
      n = n.parentElement;
    }
    return last || stopAt;
  }

  function getLetterSpacingInEm(elem) {
    try {
      var ls = getComputedStyle(elem).letterSpacing;
      if (!ls || ls === 'normal') return 0;
      var px = parseFloat(ls);
      if (!px) return 0;
      var fs = parseFloat(getComputedStyle(elem).fontSize) || 16;
      return px / fs;
    } catch (e) { return 0; }
  }

  /**
   * 给单个文本节点包一层 <span data-stt-id>，返回登记好的 segment。
   * 若该节点已包裹或不该翻译，返回 null。
   */
  function wrapTextNode(node, block) {
    if (!node || node.nodeType !== 3) return null;
    if (wrappedNodes.has(node)) return null;
    var text = node.nodeValue;
    if (!text || !text.trim()) return null;
    if (!isWorthTranslating(text)) return null;
    var parent = node.parentElement;
    if (!parent) return null;
    if (isHidden(parent) || inSkipZone(node, block)) return null;

    var segId = segSeq++;
    var span = document.createElement('span');
    span.setAttribute('data-stt-id', String(segId));
    span.className = 'st-seg';
    span.textContent = text;
    // 保留原文本节点的排版特性，避免行内元素之间出现间距
    try {
      var ls = getLetterSpacingInEm(parent);
      if (ls) span.style.letterSpacing = ls + 'em';
      span.style.whiteSpace = 'pre-wrap';
    } catch (e) { /* ignore */ }

    try {
      parent.insertBefore(span, node);
      parent.removeChild(node);
    } catch (e) {
      return null;
    }
    wrappedNodes.add(span.firstChild || node);
    var seg = { id: segId, node: span, text: text, image: false };
    state.segmentMap.set(segId, seg);
    return seg;
  }

  /** 扫描统计（用于诊断：为什么某些文本没被登记） */
  var scanStats = { visited: 0, text: 0, wrapped: 0, blank: 0, notWorth: 0, hidden: 0, skipped: 0 };

  /** 不参与翻译的标签（连同子树一起跳过） */
  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, IFRAME: 1, CANVAS: 1,
    SVG: 1, MATH: 1, TEXTAREA: 1, INPUT: 1, SELECT: 1, OPTION: 1, OPTGROUP: 1
  };

  /**
   * 递归扫描子树，登记新的翻译段。
   *
   * 注意：不用 document.createTreeWalker —— 其 FILTER_REJECT 在处理被包裹过的
   * 子树时行为容易出错，自己递归更可控（也能顺手跳过不翻译的标签）。
   *
   * @param {Node} root 起始节点
   * @param {Element} block 当前所处的块级上下文
   * @param {Element} stopAt 扫描边界（通常是 body）
   * @param {Array} out 结果收集数组
   */
  function walkAndWrap(root, block, stopAt, out) {
    if (!root) return;
    if (root.nodeType === 3) {
      scanStats.text++;
      var seg = wrapTextNode(root, block);
      if (seg) { scanStats.wrapped++; out.push(seg); }
      return;
    }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;

    // 已经是分屏容器自己的节点，跳过
    if (root.nodeType === 1 && root.classList && root.classList.contains('split-translate-root')) return;

    var node = root.firstChild;
    while (node) {
      var next = node.nextSibling;   // 先取下一个兄弟：包裹文本节点会改变兄弟关系
      if (node.nodeType === 1) {
        if (SKIP_TAGS[node.tagName]) { node = next; continue; }
        // 不翻译的区域（code / pre / translate=no / contenteditable / 隐藏元素）
        if (node.getAttribute && node.getAttribute('translate') === 'no') { node = next; continue; }
        if (node.classList && (node.classList.contains('notranslate') || node.classList.contains('st-no-translate'))) {
          node = next; continue;
        }
        if (node.isContentEditable) { node = next; continue; }
        if (isHidden(node)) { scanStats.hidden++; node = next; continue; }
        var childBlock = isBlockish(node, stopAt) ? node : block;
        // 跳过整棵子树的情况交给 wrapTextNode 里的 inSkipZone 兜底
        walkAndWrap(node, childBlock || node, stopAt, out);
      } else if (node.nodeType === 3) {
        walkAndWrap(node, block, stopAt, out);
      }
      node = next;
    }
  }

  /** 扫描 root 子树，登记所有新的翻译段 */
  function scanRoot(root, stopAt) {
    stopAt = stopAt || document.body || document.documentElement;
    if (!root || !stopAt) return [];
    scanStats.visited++;
    var out = [];
    walkAndWrap(root, isBlockish(root, stopAt) ? root : (root.parentElement || root), stopAt, out);
    return out;
  }

  /** 收集页面图片（用于可选的「全语言识别 API」） */
  function collectImages(limit) {
    var out = [];
    var seen = Object.create(null);
    var imgs = document.querySelectorAll('img, picture img, [style*="background-image"]');
    for (var i = 0; i < imgs.length && out.length < (limit || 12); i++) {
      var node = imgs[i];
      if (node.tagName === 'IMG') {
        if (handledImages.has(node)) continue;
        if (!node.currentSrc && !node.getAttribute('src') && !node.getAttribute('data-src')) continue;
        var w = node.naturalWidth || node.width || 0;
        var h = node.naturalHeight || node.height || 0;
        if (w && h && w * h < 64 * 64) continue;          // 忽略图标
        var src = node.getAttribute('data-src') || node.getAttribute('data-original') ||
                  node.currentSrc || node.getAttribute('src') || '';
        if (!src || /^data:image\/gif/i.test(src)) continue;
        if (src.slice(0, 5) === 'blob:') continue;
        if (!/^(https?:|data:image\/)/i.test(src)) {
          try { src = new URL(src, location.href).href; } catch (e) { continue; }
        }
        if (seen[src]) continue;
        seen[src] = true;
        handledImages.add(node);
        out.push({ node: node, src: src, alt: node.getAttribute('alt') || '' });
      } else {
        // 背景图元素：没有 <img>，无法在镜像里替换，仅登记提示
        if (handledImages.has(node)) continue;
        var bg = '';
        try {
          bg = getComputedStyle(node).backgroundImage || '';
        } catch (e) { bg = ''; }
        var m = /url\(["']?(https?:[^"')]+)["']?\)/.exec(bg);
        if (!m) continue;
        if (seen[m[1]]) continue;
        seen[m[1]] = true;
        handledImages.add(node);
        out.push({ node: node, src: m[1], alt: '', background: true });
      }
    }
    return out;
  }

  /* ================================================================== */
  /* 3. 分屏 UI                                                          */
  /* ================================================================== */


  /** 窗口尺寸变化后，按当前比例重算像素尺寸 */
  var resizeTimer = null;
  function onWindowResize() {
    if (!state.splitActive) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (!state.splitActive) return;
      applyRatio(state.ratio);
      positionBadges();
    }, 150);
  }

  function initDrag() {
    if (!ui.divider) return;
    var dragging = false;
    var mask = null;
    var cursor = 'col-resize';

    var onMove = function (clientX, clientY) {
      if (!dragging || !ui.root) return;
      if (isVerticalSplit()) {
        var wr = ui.root.getBoundingClientRect();
        if (wr.width <= 0) return;
        applyRatio(((clientX - wr.left) / wr.width) * 100);
      } else {
        var hr = ui.root.getBoundingClientRect();
        if (hr.height <= 0) return;
        applyRatio(((clientY - hr.top) / hr.height) * 100);
      }
    };
    var move = function (e) {
      if (!dragging) return;
      var t = e.touches && e.touches[0] ? e.touches[0] : e;
      onMove(t.clientX, t.clientY);
      e.preventDefault();
      e.stopPropagation();
    };
    var up = function () {
      if (!dragging) return;
      dragging = false;
      if (ui.divider) ui.divider.classList.remove('st-dragging');
      if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
      mask = null;
      document.documentElement.style.removeProperty('cursor');
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('mouseup', up, true);
      document.removeEventListener('touchmove', move, true);
      document.removeEventListener('touchend', up, true);
    };
    var down = function (e) {
      dragging = true;
      cursor = currentLayout().cursor;
      if (ui.divider) ui.divider.classList.add('st-dragging');
      document.documentElement.style.setProperty('cursor', cursor);
      // 拖动期间盖一层透明遮罩：避免鼠标进入左右栏后触发 iframe / 文本选择等干扰
      mask = document.createElement('div');
      mask.setAttribute('data-stt-mask', '1');
      mask.style.cssText = 'position:fixed!important;inset:0!important;z-index:2147483601!important;' +
        'cursor:' + cursor + '!important;background:transparent!important;';
      (document.body || document.documentElement).appendChild(mask);
      document.addEventListener('mousemove', move, true);
      document.addEventListener('mouseup', up, true);
      document.addEventListener('touchmove', move, { capture: true, passive: false });
      document.addEventListener('touchend', up, true);
      e.preventDefault();
      e.stopPropagation();
    };

    ui.divider.addEventListener('mousedown', down);
    ui.divider.addEventListener('touchstart', down, { passive: false });
    // 双击分隔线回到 50 / 50
    ui.divider.addEventListener('dblclick', function () { applyRatio(50); });
  }

  /* ================================================================== */
  /* 3.2 译文栏可交互：链接可点、表单只读、悬停高亮原文                   */
  /* ================================================================== */

  /**
   * 处理译文栏里的点击。
   *
   * 之前这里把所有交互都 preventDefault 掉了，导致「译文里的链接点不动」。
   * 现在改成：
   *   - 链接 → 交给 background 真正导航（同站沿用当前标签页，外站 / 新窗口则新开标签页）
   *   - 按钮 / 输入框 / 下拉框 → 仍然屏蔽（避免在镜像里误触发表单提交或改动页面状态）
   *   - 页内锚点（#xxx）→ 直接滚动原文栏到对应位置
   */
  function onCloneClick(e) {
    var t = e.target;
    if (!t || !t.closest) return;

    var anchor = t.closest('a[href]');
    if (anchor) {
      e.preventDefault();
      e.stopPropagation();
      var raw = anchor.getAttribute('href') || '';
      if (!raw || raw.charAt(0) === '#') {
        // 页内锚点：把原文栏滚到对应位置
        var id = raw.slice(1);
        var target = null;
        try {
          target = id && ui.original ? ui.original.querySelector('[id="' + id.replace(/"/g, '\\"') + '"]') : null;
        } catch (err) { target = null; }
        if (target && target.scrollIntoView) target.scrollIntoView({ block: 'start' });
        else if (ui.original) ui.original.scrollTop = 0;
        return;
      }
      if (/^(javascript|data|blob|file):/i.test(raw)) return;   // 不跟随危险协议
      var abs;
      try {
        abs = new URL(raw, anchor.baseURI || location.href).href;
      } catch (err) {
        return;
      }
      if (!/^https?:\/\//i.test(abs)) return;
      var wantNewTab = anchor.getAttribute('target') === '_blank' ||
        e.ctrlKey || e.metaKey || e.button === 1;
      // 外站链接默认新开标签页，避免把正在对照的页面顶掉
      if (!wantNewTab) {
        try {
          wantNewTab = new URL(abs).host !== location.host;
        } catch (err) { /* ignore */ }
      }
      navigateTo(abs, wantNewTab ? 'newTab' : 'sameTab');
      return;
    }

    // 表单类控件在镜像里保持只读
    if (t.closest('button, input, select, textarea, [role="button"], [contenteditable="true"]')) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  /** 让 background 执行真正的导航（content script 无权改标签页 URL） */
  function navigateTo(url, disposition) {
    /*
     * 测试钩子：允许自动化测试在真正跳转前拿到「会往哪跳」的决策。
     * 钩子返回 true 表示已拦截，本次不再真正导航。
     */
    if (typeof state.navigateHook === 'function') {
      var intercepted = false;
      try { intercepted = state.navigateHook(url, disposition) === true; } catch (e) { intercepted = false; }
      if (intercepted) return;
    }
    try {
      chrome.runtime.sendMessage({ type: 'NAVIGATE', url: url, disposition: disposition }, function (resp) {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          // 兜底：扩展侧失败时用普通跳转
          if (disposition === 'newTab') window.open(url, '_blank', 'noopener');
          else location.href = url;
        }
      });
    } catch (e) {
      location.href = url;
    }
  }

  /** 译文栏与原文栏结构一致，按相同下标路径反查原文元素 */
  function findOriginalOf(cloneEl) {
    if (!ui.cloneBody || !ui.original || !cloneEl) return null;
    var descriptor = [];
    var cur = cloneEl;
    var depth = 0;
    while (cur && cur !== ui.cloneBody && depth++ < 80) {
      var parent = cur.parentElement;
      if (!parent) break;
      descriptor.unshift(Array.prototype.indexOf.call(parent.children, cur));
      cur = parent;
    }
    if (cur !== ui.cloneBody) return null;
    var node = ui.original;
    for (var i = 0; i < descriptor.length; i++) {
      if (!node.children || !node.children[descriptor[i]]) return null;
      node = node.children[descriptor[i]];
    }
    return node === ui.original ? null : node;
  }

  /** 悬停译文时高亮原文栏对应元素，方便对照 */
  function initHoverLink() {
    if (!ui.cloneBody || !ui.original) return;
    var last = null;
    ui.cloneBody.addEventListener('mouseover', function (e) {
      if (!state.settings || !state.settings.highlightOriginal) return;
      var node = e.target && e.target.closest ? e.target.closest('[data-stt-id]') : null;
      if (!node || node === last) return;
      clearHoverHighlight();
      var origin = findOriginalOf(node);
      if (origin && origin.classList) {
        origin.classList.add('st-hover-origin');
        last = node;
      }
    }, true);
    ui.cloneBody.addEventListener('mouseleave', clearHoverHighlight);
  }

  function clearHoverHighlight() {
    if (!ui.original) return;
    var marked = ui.original.querySelectorAll('.st-hover-origin');
    for (var i = 0; i < marked.length; i++) marked[i].classList.remove('st-hover-origin');
  }

  /* ================================================================== */
  /* 3.3 独立小窗（Document Picture-in-Picture，默认关闭）               */
  /* ================================================================== */

  var pipWin = null;
  var pipPlaceholder = null;

  function detachSupported() {
    return typeof window.documentPictureInPicture !== 'undefined' &&
      typeof window.documentPictureInPicture.requestWindow === 'function';
  }

  /**
   * 把译文栏（含已翻译内容）挪进一个独立的小窗口。
   *
   * 用 documentPictureInPicture：它给的是一个真正的 Document，直接 appendChild
   * 就能把现有 DOM 搬过去，译文保持实时状态，关掉小窗再搬回来。
   * 不支持该 API 时退化为 window.open 的小弹窗（只读快照）。
   */
  function detachTranslatedPane() {
    if (!state.splitActive || !ui.translated) {
      toast('请先开始分屏翻译，再打开独立小窗', true);
      return;
    }
    if (pipWin) { closeDetachedPane(); return; }

    var requestWindow = null;
    if (typeof state.detachWindowFactory === 'function') {
      // 测试钩子：用一个隐藏 iframe 的 window 充当小窗，验证搬运 / 回收逻辑
      requestWindow = state.detachWindowFactory;
    } else if (detachSupported()) {
      requestWindow = function () {
        return window.documentPictureInPicture.requestWindow({ width: 520, height: 720 });
      };
    } else {
      openDetachedFallback();
      return;
    }

    Promise.resolve()
      .then(function () { return requestWindow(); })
      .then(function (win) {
        pipWin = win;
        // 把扩展样式与页面样式带进小窗，保持与原页面一致的排版
        copyStylesTo(win.document);
        win.document.title = '译文 · ' + (document.title || location.hostname);
        win.document.documentElement.lang = 'zh-CN';

        pipPlaceholder = document.createComment('译文栏已挪到独立小窗');
        ui.translated.parentNode.insertBefore(pipPlaceholder, ui.translated);
        win.document.body.appendChild(ui.translated);
        ui.translated.classList.add('st-detached');
        // 小窗里没有分隔线，让译文栏铺满
        ui.translated.style.setProperty('flex', '1 1 auto', 'important');
        ui.translated.style.setProperty('width', '100%', 'important');
        ui.translated.style.setProperty('height', '100%', 'important');

        win.addEventListener('pagehide', function () { restoreFromDetached(); }, { once: true });
        toast('译文已放入独立小窗，关闭小窗即可复原');
        reportState();
      })
      .catch(function (err) {
        toast('无法打开独立小窗：' + ((err && err.message) || err) + '，改用弹窗形式', true);
        openDetachedFallback();
      });
  }

  /** 不支持 documentPictureInPicture 时的降级：普通弹窗展示译文快照 */
  function openDetachedFallback() {
    var win = window.open('', 'st-detached',
      'popup=yes,width=560,height=760,left=' + Math.max(0, screen.width - 600) + ',top=80');
    if (!win) {
      toast('浏览器拦截了弹窗，请允许本站弹出窗口', true);
      return;
    }
    var doc = win.document;
    copyStylesTo(doc);
    doc.title = '译文 · ' + (document.title || '');
    doc.documentElement.lang = 'zh-CN';
    var wrap = doc.createElement('div');
    wrap.className = 'st-pane-translated st-pane-detached';
    wrap.style.cssText = 'position:static;width:auto;height:auto;overflow:auto;padding:16px 18px 60px;';
    var clone = ui.cloneBody ? ui.cloneBody.cloneNode(true) : null;
    if (clone) {
      clone.style.removeProperty('font-size');
      clone.style.removeProperty('line-height');
      wrap.appendChild(clone);
    } else {
      wrap.textContent = '当前没有可显示的译文。';
    }
    doc.body.appendChild(wrap);
    toast('已用弹窗形式打开译文（该环境不支持可交互小窗）');
  }

  function closeDetachedPane() {
    if (pipWin) {
      try { pipWin.close(); } catch (e) { /* ignore */ }
      restoreFromDetached();
    }
  }

  /** 把小窗里的译文栏搬回原来位置 */
  function restoreFromDetached() {
    if (!ui.translated) { pipWin = null; return; }
    try {
      if (pipPlaceholder && pipPlaceholder.parentNode) {
        pipPlaceholder.parentNode.insertBefore(ui.translated, pipPlaceholder);
        pipPlaceholder.parentNode.removeChild(pipPlaceholder);
      }
      ui.translated.classList.remove('st-detached');
      ui.translated.style.removeProperty('flex');
      ui.translated.style.removeProperty('width');
      ui.translated.style.removeProperty('height');
    } catch (e) { /* ignore */ }
    pipPlaceholder = null;
    pipWin = null;
    if (state.splitActive) {
      applyLayout(state.layout, true);
      applyRatio(state.ratio || 50);
    }
    reportState();
  }

  /** 复制样式表到另一个 document（小窗里没有原页面的 CSS） */
  function copyStylesTo(doc) {
    var nodes = document.querySelectorAll('style, link[rel="stylesheet"]');
    for (var i = 0; i < nodes.length; i++) {
      try {
        doc.head.appendChild(nodes[i].cloneNode(true));
      } catch (e) { /* ignore */ }
    }
    // 基础排版兜底，避免原站样式缺失时难以阅读
    var base = doc.createElement('style');
    base.textContent =
      'html,body{margin:0;padding:0;background:#fff;}' +
      '.st-pane-translated{overflow:auto;}' +
      '.st-detached{padding:16px 18px 60px!important;box-sizing:border-box;}' +
      '.st-clone-body{min-height:100%;}';
    doc.head.appendChild(base);
  }

  function syncScroll() {
    if (!ui.original || !ui.translated) return;
    var from = ui.original, to = ui.translated;
    from.addEventListener('scroll', function () {
      if (ui.scrollLock) return;
      ui.scrollLock = true;
      if (isVerticalSplit()) {
        var a = from.scrollHeight - from.clientHeight;
        var b = to.scrollHeight - to.clientHeight;
        if (a > 0 && b > 0) {
          to.scrollTop = (from.scrollTop / a) * b;
          to.scrollLeft = from.scrollLeft;
        }
      } else {
        var c = from.scrollWidth - from.clientWidth;
        var d = to.scrollWidth - to.clientWidth;
        if (c > 0 && d > 0) {
          to.scrollLeft = (from.scrollLeft / c) * d;
          to.scrollTop = from.scrollTop;
        }
      }
      requestAnimationFrame(function () { ui.scrollLock = false; });
    }, { passive: true });
  }

  /* ================================================================== */
  /* 3.5 版面方向：原文在左 / 右 / 上 / 下                                */
  /* ================================================================== */

  /** 四种版面：谁占固定份额、分隔线怎么拖、滚动轴是哪一根 */
  var LAYOUTS = {
    'original-left': { vertical: true, fixed: 'original', before: true, cursor: 'col-resize' },
    'original-right': { vertical: true, fixed: 'translated', before: false, cursor: 'col-resize' },
    'original-top': { vertical: false, fixed: 'original', before: true, cursor: 'row-resize' },
    'original-bottom': { vertical: false, fixed: 'translated', before: false, cursor: 'row-resize' }
  };

  function isValidLayout(name) { return Object.prototype.hasOwnProperty.call(LAYOUTS, name); }

  function currentLayout() {
    var name = state.layout || (state.settings && state.settings.layout) || 'original-left';
    return LAYOUTS[name] ? LAYOUTS[name] : LAYOUTS['original-left'];
  }

  /** 当前是否为左右分屏（垂直分隔线） */
  function isVerticalSplit() { return currentLayout().vertical; }

  /**
   * 按版面重新排列两栏顺序。
   * @param {string} name original-left / original-right / original-top / original-bottom
   * @param {boolean} [force] true 表示初始化（不重算比例）
   */
  function applyLayout(name, force) {
    if (!isValidLayout(name)) name = 'original-left';
    var changed = state.layout !== name;
    state.layout = name;
    var cfg = LAYOUTS[name];

    if (ui.root) {
      ui.root.setAttribute('data-stt-layout', name);
      ui.root.style.setProperty('flex-direction', cfg.vertical ? 'row' : 'column', 'important');
    }
    if (ui.original && ui.translated && ui.root) {
      if (cfg.before) {
        ui.root.insertBefore(ui.original, ui.root.firstChild);
        ui.root.insertBefore(ui.translated, ui.divider ? ui.divider.nextSibling : ui.original.nextSibling);
      } else {
        ui.root.insertBefore(ui.translated, ui.root.firstChild);
        ui.root.insertBefore(ui.original, ui.divider ? ui.divider.nextSibling : ui.translated.nextSibling);
      }
    }
    if (ui.divider) {
      ui.divider.title = cfg.vertical
        ? '拖动调整左右比例，双击回到 50 / 50'
        : '拖动调整上下比例，双击回到 50 / 50';
      try { ui.divider.style.setProperty('cursor', cfg.cursor, 'important'); } catch (e) { /* ignore */ }
    }
    if (!force && changed) applyRatio(state.ratio || 50);
    positionBadges();
    reportState();
  }

  /**
   * 应用分屏比例（当前版面下「原文栏」所占的比例）。
   *
   * 实现方式说明（踩过的坑）：
   *   - 只改 CSS 变量 `--st-ratio` 不够：样式表里 `flex-basis: var(--st-ratio, 50%) !important`
   *     在部分 Chromium 版本上不会随变量变化重新解析（换成 flex 长写属性也一样），
   *     比例会一直停在初始值。
   *   - 因此这里做两件事：
   *       1) 在固定的那一栏上直接写内联的像素级 flex 值，另一栏 flex:1 撑满；
   *       2) 把比例与像素尺寸记录到根节点的 data-stt-* 属性上，作为可观测、可样式化的事实来源。
   *   - 上下版面用高度换算，左右版面用宽度换算。
   */
  function applyRatio(pct) {
    pct = Math.max(15, Math.min(85, Math.round(pct)));
    state.ratio = pct;
    var cfg = currentLayout();
    var total = 0;
    if (ui.root) {
      total = cfg.vertical
        ? (ui.root.clientWidth || Math.round(ui.root.getBoundingClientRect().width) || 0)
        : (ui.root.clientHeight || Math.round(ui.root.getBoundingClientRect().height) || 0);
    }
    var px = total > 0 ? Math.round(total * pct / 100) : 0;

    if (ui.root) {
      ui.root.style.setProperty('--st-ratio', pct + '%');
      ui.root.setAttribute('data-stt-ratio', String(pct));
      if (px > 0) ui.root.setAttribute('data-stt-fixed-size', String(px));
      ui.root.setAttribute('data-stt-axis', cfg.vertical ? 'x' : 'y');
    }

    // 固定份额的那一栏按比例给像素尺寸，另一栏 flex:1 吃掉剩余空间
    var fixed = cfg.fixed === 'original' ? ui.original : ui.translated;
    var grow = cfg.fixed === 'original' ? ui.translated : ui.original;
    var axis = cfg.vertical ? { basis: 'flex-basis', size: 'width' } : { basis: 'flex-basis', size: 'height' };

    if (fixed && px > 0) {
      fixed.style.setProperty('flex-grow', '0', 'important');
      fixed.style.setProperty('flex-shrink', '0', 'important');
      fixed.style.setProperty('flex-basis', px + 'px', 'important');
      fixed.style.setProperty(axis.size, px + 'px', 'important');
      fixed.style.setProperty('max-' + axis.size, 'none', 'important');
      fixed.style.setProperty('min-' + axis.size, '0', 'important');
      if (cfg.vertical) {
        fixed.style.setProperty('height', '100%', 'important');
      } else {
        fixed.style.setProperty('width', '100%', 'important');
      }
    }
    if (grow) {
      grow.style.setProperty('flex-grow', '1', 'important');
      grow.style.setProperty('flex-shrink', '1', 'important');
      grow.style.setProperty('flex-basis', '0', 'important');
      grow.style.setProperty('min-' + axis.size, '0', 'important');
      grow.style.removeProperty('max-' + axis.size);
      if (cfg.vertical) {
        grow.style.setProperty('height', '100%', 'important');
      } else {
        grow.style.setProperty('width', '100%', 'important');
      }
    }
    try {
      localStorage.setItem('splitTranslateRatio', String(pct));
    } catch (e) { /* ignore */ }
  }

  /**
   * 建立分屏：一栏放原始 DOM，另一栏放 deep clone 镜像并就地翻译。
   * 谁在左/右/上/下由 layout 设置决定（见 applyLayout）。
   */
  function splitMode() {
    if (state.splitActive) return true;
    var body = document.body;
    if (!body) {
      toast('页面尚未加载完成，无法分屏', true);
      return false;
    }
    if (body.getAttribute('data-stt-no-split') === '1' || body.classList.contains('st-no-split')) {
      toast('该页面不允许分屏（页面自带限制）', true);
      return false;
    }

    injectStyleOnce();
    ensureStylesheet();

    // 先把提示条收起来，避免它被克隆进译文镜像（hideBanner 会把它从 DOM 移除）
    hideBanner();

    var s = state.settings;
    var root = el('div', 'split-translate-root');
    root.setAttribute('data-stt-root', '1');
    root.setAttribute('data-stt-layout', s.layout || 'original-left');

    var original = el('div', 'st-pane-original');
    original.setAttribute('data-stt-pane', 'original');
    var divider = el('div', 'st-divider');
    divider.title = '拖动调整比例，双击回到 50 / 50';
    var translated = el('div', 'st-pane-translated');
    translated.setAttribute('data-stt-pane', 'translated');

    root.appendChild(original);
    if (s.showDivider) root.appendChild(divider);
    root.appendChild(translated);

    try {
      root.style.setProperty('--st-bg', getComputedStyle(body).backgroundColor || '#fff');
    } catch (e) { /* ignore */ }

    ui.root = root;
    ui.original = original;
    ui.translated = translated;
    ui.divider = divider;

    // ---- 译文镜像：深拷贝原始 DOM（此时 <span data-stt-id> 已经就位） ----
    // 关键：此时 body 的子节点还没被搬走，直接克隆整棵子树即可，
    // 绝不能克隆 body 自身（那会把刚建好的分屏容器一起克隆进去）。
    var clone = body.cloneNode(false);
    clone.removeAttribute('id');
    clone.classList.add('st-clone-body');
    [].forEach.call(body.childNodes, function (child) {
      if (child.nodeType === 1 && child.classList && child.classList.contains('split-translate-root')) return;
      clone.appendChild(child.cloneNode(true));
    });
    if (s.readingStyle) clone.classList.add('st-reading');
    try {
      clone.style.setProperty('font-size', s.fontSize + 'px', 'important');
      clone.style.setProperty('line-height', String(s.lineHeight), 'important');
    } catch (e) { /* ignore */ }

    // 清理镜像中的可执行内容与表单状态
    [].forEach.call(clone.querySelectorAll('script, noscript, template, link[rel="preload"]'), function (n) {
      if (n.parentNode) n.parentNode.removeChild(n);
    });
    [].forEach.call(clone.querySelectorAll('input, textarea, select'), function (n) {
      if (n.tagName === 'TEXTAREA') n.textContent = '';
      else if (n.tagName !== 'SELECT') n.setAttribute('value', '');
      n.setAttribute('tabindex', '-1');
      n.setAttribute('readonly', 'readonly');
    });
    [].forEach.call(clone.querySelectorAll('iframe, frame, object, embed'), function (n) {
      var ph = el('div', 'st-imgnote st-imgnote-empty', '［此区域为内嵌框架，无法镜像显示，请查看原文栏］');
      if (n.parentNode) n.parentNode.replaceChild(ph, n);
    });

    // 译文栏交互：链接可点（导航交给 background），表单控件保持只读
    clone.addEventListener('click', onCloneClick, true);
    clone.addEventListener('auxclick', onCloneClick, true);   // 中键点击链接
    clone.addEventListener('submit', function (e) { e.preventDefault(); }, true);
    clone.addEventListener('beforeinput', function (e) {
      if (e.target && e.target.closest && e.target.closest('input, textarea, [contenteditable="true"]')) {
        e.preventDefault();
      }
    }, true);

    // ---- 把原始 DOM 搬进原文栏（appendChild 直接移动，保持原有 DOM 层级） ----
    while (body.firstChild) original.appendChild(body.firstChild);
    moveStylesInto(original);

    // 提示条已在建分屏前收起，这里再兜一次，防止异步流程又把它插回来
    hideBanner();

    // 状态条
    if (s.showStatusBar) {
      var bar = el('div', 'st-statusbar');
      bar.setAttribute('data-status', 'ready');
      bar.appendChild(el('span', 'st-dot'));
      var st = el('span', 'st-status-text', '已进入分屏对照模式');
      bar.appendChild(st);
      var prog = el('div', 'st-progress');
      var progInner = el('i');
      prog.appendChild(progInner);
      bar.appendChild(prog);
      var acts = el('div', 'st-status-actions');
      var btnRetry = el('button', '', '重新翻译');
      var btnDetach = el('button', '', '独立小窗');
      btnDetach.title = '把译文放进一个可拖动的小窗口，方便边看边做别的事';
      var btnRestore = el('button', '', '恢复原页面');
      btnRetry.addEventListener('click', function () { retranslate(); });
      btnDetach.addEventListener('click', function () { detachTranslatedPane(); });
      btnRestore.addEventListener('click', function () { restore(); });
      acts.appendChild(btnRetry);
      acts.appendChild(btnDetach);
      acts.appendChild(btnRestore);
      bar.appendChild(acts);
      translated.appendChild(bar);
      ui.statusbar = bar;
      ui.statusText = st;
      ui.progressBar = progInner;
      ui.progress = prog;
      ui.detachButton = btnDetach;
    }

    // 「原文 / 译文」角标，位置随版面变化
    addPaneBadge(original, '原文');
    addPaneBadge(translated, '译文');

    ui.cloneBody = clone;
    translated.appendChild(clone);

    // 版面方向：原文在左/右/上/下（见 LAYOUTS），决定主轴上谁占固定份额
    applyLayout(s.layout || 'original-left', true);

    document.body.appendChild(root);
    // 上面 applyLayout 时 root 还没进 DOM，拿不到尺寸，入 DOM 后按比例重算一次
    applyRatio(state.ratio || s.defaultRatio || 50);
    // 尺寸变化后按新尺寸重算像素比例
    window.addEventListener('resize', onWindowResize);

    // 页面滚动交给两栏自己处理
    document.documentElement.style.setProperty('overflow', 'hidden');
    body.style.setProperty('overflow', 'hidden', 'important');
    body.classList.add('st-split-active');
    if (s.showDivider) initDrag();
    if (s.syncScroll) syncScroll();
    if (s.highlightOriginal) initHoverLink();

    state.splitActive = true;
    hideBanner();
    positionBadges();
    reportState();
    log('已进入分屏模式（版面：' + state.layout + '）');
    return true;
  }

  /** 给某一栏加「原文 / 译文」角标，并把位置贴到该栏的可见左上角 */
  function addPaneBadge(pane, text) {
    if (!state.settings || !state.settings.showPaneBadge) return;
    var badge = el('span', 'st-pane-badge', text);
    badge.setAttribute('data-stt-badge', pane.getAttribute('data-stt-pane') || '');
    pane.appendChild(badge);
    pane.addEventListener('scroll', function () { positionBadges(); }, { passive: true });
  }

  /**
   * 把角标贴在各自栏目的可见左上角。
   * 两栏都是 overflow:auto 的滚动容器，absolute 元素会跟着内容滚走，
   * 所以把坐标算成「当前滚动位置 + 一点边距」，等效于钉在可见区左上角。
   */
  function positionBadges() {
    if (!state.settings || !state.settings.showPaneBadge) return;
    var panes = [ui.original, ui.translated];
    for (var i = 0; i < panes.length; i++) {
      var pane = panes[i];
      if (!pane) continue;
      var badge = pane.querySelector(':scope > .st-pane-badge');
      if (!badge) continue;
      badge.style.position = 'absolute';
      badge.style.left = Math.round(pane.scrollLeft + 6) + 'px';
      badge.style.top = Math.round(pane.scrollTop + 6) + 'px';
      // 开始滚动后淡出，避免一直挡着正文
      badge.classList.toggle('st-badge-dim', pane.scrollTop > 120 || pane.scrollLeft > 120);
    }
  }

  /** 退出分屏，把原始 DOM 还回 body */
  function restore() {
    if (!state.splitActive) {
      hideBanner();
      return false;
    }
    stopObserver();
    // 先把译文栏从小窗搬回来，再整体拆除容器
    if (pipWin) {
      try { pipWin.close(); } catch (e) { /* ignore */ }
      restoreFromDetached();
    }
    try {
      if (ui.original) {
        var body = document.body;
        while (ui.original.firstChild) body.appendChild(ui.original.firstChild);
      }
    } catch (e) {
      log('恢复失败', e);
    }
    try {
      if (ui.root && ui.root.parentNode) ui.root.parentNode.removeChild(ui.root);
    } catch (e) { /* ignore */ }
    document.documentElement.style.removeProperty('overflow');
    try { window.removeEventListener('resize', onWindowResize); } catch (e) { /* ignore */ }
    if (document.body) {
      document.body.style.removeProperty('overflow');
      document.body.classList.remove('st-split-active');
    }
    ui.root = ui.original = ui.translated = ui.divider = null;
    ui.cloneBody = null;
    ui.statusbar = ui.statusText = ui.progressBar = ui.detachButton = null;
    state.splitActive = false;
    state.translating = false;
    reportState();
    toast('已恢复原页面');
    return true;
  }

  /* ================================================================== */
  /* 4. 顶部提示条                                                       */
  /* ================================================================== */

  function showBanner(detection) {
    if (!state.settings || !state.settings.showBanner) return;
    if (state.splitActive) return;
    if (ui.banner) return;

    var name = detection && detection.name ? detection.name : '外语';
    var declared = detection && detection.declared ? detection.declared : '';

    var bar = el('div', 'st-banner');
    bar.setAttribute('role', 'dialog');
    bar.appendChild(el('span', 'st-banner-icon', '译'));

    var txt = el('span', 'st-banner-text');
    txt.appendChild(document.createTextNode('检测到'));
    var em = el('em', '', name + (declared && declared !== detection.code ? '（' + declared + '）' : ''));
    txt.appendChild(em);
    txt.appendChild(document.createTextNode('页面，是否翻译为简体中文？'));
    bar.appendChild(txt);

    var actions = el('div', 'st-banner-actions');
    var btnGo = el('button', 'st-primary', '翻译');
    var btnIgnore = el('button', 'st-ghost', '忽略');
    var btnSetting = el('button', 'st-ghost', '设置');
    actions.appendChild(btnGo);
    actions.appendChild(btnIgnore);
    actions.appendChild(btnSetting);
    bar.appendChild(actions);

    btnGo.addEventListener('click', function () {
      btnGo.disabled = true;
      btnGo.textContent = '正在翻译…';
      translate({ reason: 'banner' });
    });
    btnIgnore.addEventListener('click', function () {
      markSiteIgnored();
      hideBanner();
    });
    btnSetting.addEventListener('click', function () {
      try { chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' }); } catch (e) { /* ignore */ }
    });

    var host = document.body || document.documentElement;
    host.appendChild(bar);
    ui.banner = bar;
  }

  function hideBanner() {
    if (ui.banner && ui.banner.parentNode) ui.banner.parentNode.removeChild(ui.banner);
    ui.banner = null;
  }

  function markSiteIgnored() {
    try {
      var key = 'st_ignored_' + location.hostname;
      var obj = {};
      obj[key] = Date.now();
      chrome.storage.session.set(obj);
    } catch (e) { /* ignore */ }
  }

  function isSiteIgnored() {
    return new Promise(function (resolve) {
      try {
        var key = 'st_ignored_' + location.hostname;
        chrome.storage.session.get(key, function (res) { resolve(!!(res && res[key])); });
      } catch (e) { resolve(false); }
    });
  }

  /* ================================================================== */
  /* 5. 翻译主流程                                                       */
  /* ================================================================== */

  function setStatus(status, text) {
    if (ui.statusbar) {
      ui.statusbar.setAttribute('data-status', status || 'ready');
      if (text && ui.statusText) ui.statusText.textContent = text;
    }
  }

  function updateProgress() {
    if (!ui.progressBar) return;
    var pct = state.totalCount ? Math.round((state.doneCount / state.totalCount) * 100) : 0;
    ui.progressBar.style.width = pct + '%';
    if (ui.statusText) {
      ui.statusText.textContent = '翻译中 ' + state.doneCount + ' / ' + state.totalCount + ' 段（' + pct + '%）';
    }
  }

  /**
   * 点击「翻译」后的主入口
   * @param {{reason?:string}} opts
   */
  function translate(opts) {
    opts = opts || {};
    if (state.translating) {
      toast('正在翻译中，请稍候…');
      return Promise.resolve(false);
    }
    if (Engine.isExcluded(location.href, state.settings)) {
      if (opts.reason !== 'auto') toast('当前页面在排除名单中，已跳过翻译', true);
      return Promise.resolve(false);
    }

    return Engine.getSettings(true).then(function (s) {
      state.settings = s;
      if (!s.apiKey) {
        toast('尚未配置 API Key，请先在设置中填写', true);
        try { chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' }); } catch (e) { /* ignore */ }
        return false;
      }

      state.translating = true;
      state.error = '';
      state.doneCount = 0;
      state.totalCount = 0;
      reportState();

      // 1) 扫描 + 建分屏
      scanRoot(document.body, document.body);
      log('已登记 ' + state.segmentMap.size + ' 个翻译段');
      if (!splitMode()) {
        state.translating = false;
        reportState();
        return false;
      }
      setStatus('translating', '正在准备翻译…');
      state.totalCount = state.segmentMap.size;
      state.doneCount = 0;
      updateProgress();

      // 2) 文本翻译 + 图片取字并行
      var textTask = runTextTranslation();
      var ocrTask = s.ocrEnabled ? runImageOcr() : Promise.resolve({ ok: 0, fail: 0, skipped: 0 });

      return Promise.all([textTask, ocrTask]).then(function (res) {
        var r = res[0] || { ok: 0, fail: 0, errors: [] };
        var ocr = res[1] || { ok: 0, skipped: 0 };
        state.translating = false;

        var parts = ['已翻译 ' + r.ok + ' / ' + state.totalCount + ' 段'];
        if (ocr.ok) parts.push('图片取字 ' + ocr.ok + ' 张');
        if (r.fail) parts.push(r.fail + ' 段失败');
        if (s.ocrEnabled && ocr.skipped) parts.push('跳过图片 ' + ocr.skipped + ' 张');
        setStatus(r.fail && !r.ok ? 'error' : 'ready', parts.join('，'));

        if (r.errors && r.errors.length) {
          state.error = r.errors[0];
          toast('部分内容翻译失败：' + r.errors[0], true, 6000);
        } else if (!r.ok && state.totalCount > 0) {
          toast('翻译失败，请检查 API 配置或网络', true);
        }

        if (s.autoTranslateDynamic) startObserver();
        // 设置了「自动放入独立小窗」时，翻译完成后自动弹小窗（默认关闭）
        if (s.detachWindow && detachSupported() && !pipWin) {
          setTimeout(function () { detachTranslatedPane(); }, 400);
        }
        reportState();
        // 翻译完成后顺手推送一次就绪提示
        try {
          chrome.runtime.sendMessage({ type: 'STATE_CHANGED', state: publicState() });
        } catch (e) { /* ignore */ }
        return true;
      });
    }).catch(function (err) {
      state.translating = false;
      var msg = (err && err.message) || String(err);
      state.error = msg;
      setStatus('error', '翻译失败：' + msg);
      toast('翻译失败：' + msg, true, 6000);
      reportState();
      return false;
    });
  }

  /** 逐块翻译已登记的文本段（每块约 20 段，便于显示进度） */
  function runTextTranslation() {
    return new Promise(function (resolve) {
      var items = [];
      state.segmentMap.forEach(function (seg) {
        if (!seg.image) items.push(seg);
      });
      log('待翻译文本段：' + items.length);
      if (!items.length) return resolve({ ok: 0, fail: 0, errors: [] });

      // 预算控制
      var accepted = [];
      for (var i = 0; i < items.length; i++) {
        if (BUDGET.used >= BUDGET.max) {
          toast('已达到本页翻译字符上限（' + BUDGET.max + '），剩余内容未翻译', true, 5000);
          break;
        }
        BUDGET.used += items[i].text.length;
        accepted.push(items[i]);
      }

      var CHUNK = 20;
      var ok = 0, fail = 0;
      var errors = [];
      var index = 0;

      function next() {
        if (index >= accepted.length) {
          log('文本翻译完成：成功 ' + ok + ' 段，失败 ' + fail + ' 段');
          return resolve({ ok: ok, fail: fail, errors: errors });
        }
        var chunk = accepted.slice(index, index + CHUNK);
        index += CHUNK;
        var texts = chunk.map(function (x) { return x.text; });

        Engine.translateTexts(texts, state.settings, {
          kind: 'tx',
          onProgress: function () { /* 段级进度在 applyResults 里统计 */ }
        }).then(function (res) {
          var map = (res && res.map) || {};
          var chunkOk = 0;
          chunk.forEach(function (seg) {
            var translated = map[seg.text];
            if (translated && translated !== seg.text) {
              applyTranslation(seg, translated);
              ok++;
              chunkOk++;
            } else {
              markFailed(seg);
              fail++;
            }
            state.doneCount++;
          });
          if (res && res.errors) {
            for (var i = 0; i < res.errors.length; i++) {
              if (errors.indexOf(res.errors[i]) < 0) errors.push(res.errors[i]);
            }
          }
          log('本批 ' + chunk.length + ' 段，成功 ' + chunkOk + ' 段');
          updateProgress();
          next();
        }).catch(function (err) {
          errors.push((err && err.message) || String(err));
          chunk.forEach(function (seg) { markFailed(seg); fail++; state.doneCount++; });
          updateProgress();
          next();
        });
      }
      next();
    });
  }

  /** 把译文写回右栏镜像中对应的元素 */
  function applyTranslation(seg, translated) {
    try {
      var target = ui.cloneBody && ui.cloneBody.querySelector('[data-stt-id="' + seg.id + '"]');
      if (!target) return;
      target.textContent = translated;
      target.classList.add('st-done');
      if (state.settings.showOriginalOnHover) {
        var orig = seg.text.length > 300 ? seg.text.slice(0, 300) + '…' : seg.text;
        target.setAttribute('data-stt-original', orig);
      }
    } catch (e) { /* ignore */ }
  }

  function markFailed(seg) {
    try {
      var target = ui.cloneBody && ui.cloneBody.querySelector('[data-stt-id="' + seg.id + '"]');
      if (target) target.classList.add('st-failed');
    } catch (e) { /* ignore */ }
  }

  /** 重新翻译整页（先清掉右栏译文标记，再跑一遍） */
  function retranslate() {
    if (state.translating) return;
    if (!state.totalCount && state.segmentMap.size === 0) {
      toast('页面没有可翻译的内容');
      return;
    }
    state.doneCount = 0;
    state.translating = true;
    setStatus('translating', '重新翻译中…');
    updateProgress();
    runTextTranslation().then(function (r) {
      state.translating = false;
      setStatus(r.fail && !r.ok ? 'error' : 'ready', '重新翻译完成：成功 ' + r.ok + ' 段，失败 ' + r.fail + ' 段');
      if (r.errors && r.errors.length) toast(r.errors[0], true);
      reportState();
    });
  }

  /* ================================================================== */
  /* 6. 图片取字（可选的「全语言识别 API」）                             */
  /* ================================================================== */

  function runImageOcr() {
    var s = state.settings;
    if (!s || !s.ocrEnabled) return Promise.resolve({ ok: 0, fail: 0, skipped: 0 });
    var images = collectImages(12);
    if (!images.length) return Promise.resolve({ ok: 0, fail: 0, skipped: 0 });

    var stats = { ok: 0, fail: 0, skipped: 0 };
    var concurrency = 2;
    var cursor = 0;

    function worker() {
      if (cursor >= images.length) return Promise.resolve();
      var img = images[cursor++];
      return Engine.recognizeImage({ src: img.src, alt: img.alt }, s).then(function (text) {
        if (!text) {
          stats.skipped++;
          return;
        }
        // 图片文字再走一次翻译
        return Engine.translateTexts([text], s, { kind: 'tx' }).then(function (res) {
          var translated = (res.map && res.map[text]) || text;
          renderImageNote(img, text, translated);
          stats.ok++;
        }).catch(function () {
          renderImageNote(img, text, text);
          stats.ok++;
        });
      }).catch(function () { stats.fail++; }).then(worker);
    }

    var pool = [];
    for (var i = 0; i < Math.min(concurrency, images.length); i++) pool.push(worker());
    return Promise.all(pool).then(function () { return stats; });
  }

  /**
   * 在右栏镜像里，把图片替换成「图片原文 + 中文译文」卡片
   * 没有配置识别 API 时给出降级提示。
   */
  function renderImageNote(img, originalText, translatedText) {
    var target = null;
    try {
      if (img.background) {
        // 背景图：在镜像中找不到对应节点，退化为在原元素后面插入提示
        target = null;
      } else if (ui.cloneBody) {
        // 镜像里的 img 与页面上的 img 顺序一致，用 src 匹配
        var candidates = ui.cloneBody.querySelectorAll('img');
        for (var i = 0; i < candidates.length; i++) {
          var s1 = candidates[i].getAttribute('data-stt-src') || candidates[i].getAttribute('src') || '';
          if (s1 && img.src && (s1 === img.src || s1.indexOf(img.src) >= 0 || img.src.indexOf(s1) >= 0)) {
            target = candidates[i];
            break;
          }
        }
      }
    } catch (e) { target = null; }
    if (!target) return;

    var card = el('div', 'st-imgnote');
    var tag = el('span', 'st-imgnote-tag', '图片文字');
    card.appendChild(tag);
    card.appendChild(document.createTextNode(translatedText || originalText));
    if (translatedText && translatedText !== originalText) {
      var det = el('details');
      var sum = el('summary', '', '查看图片原文');
      var p = el('p', '', originalText);
      det.appendChild(sum);
      det.appendChild(p);
      card.appendChild(det);
    }
    try {
      target.parentNode.replaceChild(card, target);
    } catch (e) { /* ignore */ }
  }

  /* ================================================================== */
  /* 7. 动态内容观察                                                     */
  /* ================================================================== */

  function startObserver() {
    if (observer || !state.splitActive || !ui.original) return;
    observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        for (var j = 0; j < m.addedNodes.length; j++) {
          var n = m.addedNodes[j];
          if (n.nodeType === 1 || n.nodeType === 3) {
            if (n.nodeType === 1 && n.classList && n.classList.contains('split-translate-root')) continue;
            pendingRoots.add(n);
          }
        }
      }
      if (pendingRoots.size) scheduleFlush();
    });
    observer.observe(ui.original, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (observer) { observer.disconnect(); observer = null; }
    pendingRoots.clear();
    clearTimeout(flushTimer);
  }

  function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flushPending, 1000);
  }

  function flushPending() {
    if (!state.splitActive || !ui.original || state.translating) {
      // 正在翻译时稍后再来
      if (pendingRoots.size) scheduleFlush();
      return;
    }
    var roots = Array.from(pendingRoots);
    pendingRoots.clear();

    var newSegs = [];
    var chars = 0;
    for (var i = 0; i < roots.length; i++) {
      var segs = scanRoot(roots[i], ui.original);
      for (var j = 0; j < segs.length; j++) {
        if (chars + segs[j].text.length > 4000) break;
        chars += segs[j].text.length;
        newSegs.push(segs[j]);
      }
      if (chars >= 4000) break;
    }
    if (!newSegs.length) return;

    // 镜像新节点（只镜像新加入的，避免整页重排）
    try {
      for (var k = 0; k < roots.length; k++) {
        mirrorNewSubtree(roots[k]);
      }
    } catch (e) { log('镜像新节点失败', e); }

    state.totalCount += newSegs.length;
    updateProgress();
    state.translating = true;
    Engine.translateTexts(newSegs.map(function (x) { return x.text; }), state.settings, { kind: 'tx' })
      .then(function (res) {
        var map = res.map || {};
        newSegs.forEach(function (seg) {
          var t = map[seg.text];
          if (t && t !== seg.text) applyTranslation(seg, t);
          state.doneCount++;
        });
        updateProgress();
      })
      .catch(function (err) { log('动态内容翻译失败', err); })
      .then(function () {
        state.translating = false;
        setStatus('ready', '动态内容已更新（共 ' + state.totalCount + ' 段）');
      });
  }

  /**
   * 从「左栏中的某个元素」出发，按相同的子元素下标路径在右栏镜像里找到对应节点。
   * 每一层都会核对标签名，任何一层对不上就放弃（宁可少镜像，也不要把内容放错位置）。
   * @returns {Element|null}
   */
  function findMirror(candidates, inClone) {
    if (!ui.original || !ui.cloneBody) return null;
    for (var c = 0; c < candidates.length; c++) {
      var node = candidates[c];
      var descriptor = [];
      var cur = node;
      var depth = 0;
      while (cur && cur !== ui.original && depth++ < 80) {
        var parent = cur.parentElement;
        if (!parent) break;
        descriptor.unshift(Array.prototype.indexOf.call(parent.children, cur));
        cur = parent;
      }
      if (cur !== ui.original || !descriptor.length) continue;

      var curClone = inClone || ui.cloneBody;
      var ok = true;
      for (var i = 0; i < descriptor.length; i++) {
        if (!curClone.children || !curClone.children[descriptor[i]]) { ok = false; break; }
        curClone = curClone.children[descriptor[i]];
      }
      if (!ok) continue;
      // 路径解析到的节点必须与左栏的原节点标签一致，否则说明结构已错位
      if (!inClone && curClone.tagName !== node.tagName) continue;
      return curClone;
    }
    return null;
  }

  /** 把新增子树按结构镜像到右栏对应位置 */
  function mirrorNewSubtree(node) {
    if (!ui.cloneBody || !node.parentElement) return;
    var candidates = [];
    if (node.nodeType === 1) candidates.push(node);
    candidates.push(node.parentElement);
    var target = findMirror(candidates);
    if (!target) return;   // 镜像中找不到对应位置：跳过，不影响左栏
    var parent = node.nodeType === 1 ? target.parentElement : target;
    if (!parent) return;
    var clone = node.cloneNode(true);
    [].forEach.call(clone.querySelectorAll ? clone.querySelectorAll('script, noscript, template') : [], function (n) {
      if (n.parentNode) n.parentNode.removeChild(n);
    });
    try {
      // 若是镜像对应元素本身（而不是它的父节点），直接替换整棵子树，保证结构一致
      if (node.nodeType === 1 && target.tagName === node.tagName && target.parentElement === (findMirror([node.parentElement]) || target.parentElement)) {
        target.parentElement.replaceChild(clone, target);
      } else {
        parent.appendChild(clone);
      }
    } catch (e) {
      log('镜像动态内容失败：' + e.message);
    }
  }

  /* ================================================================== */
  /* 8. 状态上报 / 消息处理                                              */
  /* ================================================================== */

  function publicState() {
    return {
      installed: true,
      splitActive: state.splitActive,
      translating: state.translating,
      ratio: state.ratio,
      layout: state.layout || (state.settings && state.settings.layout) || 'original-left',
      detached: !!pipWin,
      detachSupported: detachSupported(),
      done: state.doneCount,
      total: state.totalCount,
      error: state.error,
      detection: state.detection ? {
        code: state.detection.code,
        name: state.detection.name,
        confidence: state.detection.confidence,
        isSimplifiedChinese: state.detection.isSimplifiedChinese
      } : null,
      provider: state.settings ? state.settings.provider : '',
      model: state.settings ? state.settings.model : '',
      reasoningEffort: state.settings ? state.settings.reasoningEffort : '',
      ocrEnabled: state.settings ? !!state.settings.ocrEnabled : false,
      url: location.href,
      title: document.title
    };
  }

  function reportState() {
    var s = publicState();
    var json = JSON.stringify(s);
    if (json === state.lastSentState) return;
    state.lastSentState = json;
    try {
      chrome.runtime.sendMessage({ type: 'STATE_CHANGED', state: s }, function () { void chrome.runtime.lastError; });
    } catch (e) { /* ignore */ }
  }

  function handleMessage(msg, sender, sendResponse) {
    msg = msg || {};
    switch (msg.type) {
      case 'PING':
        sendResponse({ ok: true, installed: true, state: publicState() });
        return false;
      case 'GET_STATE':
        sendResponse({ ok: true, state: publicState() });
        return false;
      case 'TRANSLATE':
        translate({ reason: msg.reason || 'manual' }).then(function (r) {
          sendResponse({ ok: !!r, state: publicState() });
        });
        return true;
      case 'RESTORE':
        var done = restore();
        sendResponse({ ok: done, state: publicState() });
        return false;
      case 'SET_RATIO':
        applyRatio(msg.ratio);
        sendResponse({ ok: true, ratio: state.ratio });
        return false;
      case 'SET_LAYOUT':
        applyLayout(msg.layout, false);
        sendResponse({ ok: true, layout: state.layout });
        return false;
      case 'DETACH':
        detachTranslatedPane();
        sendResponse({ ok: true, detached: !!pipWin, supported: detachSupported() });
        return false;
      case 'UNDETACH':
        closeDetachedPane();
        sendResponse({ ok: true, detached: !!pipWin });
        return false;
      /*
       * 测试钩子：把「译文栏链接会往哪跳」的决策记录到 DOM 属性上，并拦截本次导航。
       * 注意：内容脚本运行在隔离世界，它的 window 与页面主世界是两个对象，
       * 所以记录必须挂在 DOM 上，页面侧的自动化测试才读得到。
       */
      case 'TEST_NAV_HOOK':
        if (msg.enable) {
          state.navigateHook = function (url, disposition) {
            try {
              var host = document.documentElement;
              var log = [];
              try { log = JSON.parse(host.getAttribute('data-stt-nav-log') || '[]'); } catch (e) { log = []; }
              log.push({ url: url, disposition: disposition, at: Date.now() });
              host.setAttribute('data-stt-nav-log', JSON.stringify(log.slice(-20)));
            } catch (e) { /* ignore */ }
            return true;   // 拦截本次导航，只记录不跳转
          };
        } else {
          state.navigateHook = null;
          try { document.documentElement.removeAttribute('data-stt-nav-log'); } catch (e) { /* ignore */ }
        }
        sendResponse({ ok: true, enabled: !!state.navigateHook });
        return false;
      case 'TEST_NAV_LOG': {
        var rawLog = '[]';
        try { rawLog = document.documentElement.getAttribute('data-stt-nav-log') || '[]'; } catch (e) { rawLog = '[]'; }
        var parsedLog = [];
        try { parsedLog = JSON.parse(rawLog); } catch (e) { parsedLog = []; }
        sendResponse({ ok: true, log: parsedLog });
        return false;
      }
      /*
       * 测试钩子：用隐藏 iframe 的 window 冒充「独立小窗」。
       * 无头环境里 documentPictureInPicture.requestWindow 需要用户手势，
       * 无法自动化触发；这个钩子让搬运 / 回收 DOM 的逻辑仍然可被真实验证。
       */
      case 'TEST_DETACH_WINDOW':
        if (msg.enable) {
          state.detachWindowFactory = function () {
            var frame = document.createElement('iframe');
            frame.setAttribute('data-stt-fake-pip', '1');
            frame.style.cssText = 'position:fixed;right:0;bottom:0;width:420px;height:620px;' +
              'opacity:0.01;pointer-events:none;z-index:2147483001;border:0;';
            document.body.appendChild(frame);
            var doc = frame.contentDocument;
            doc.open();
            doc.write('<!DOCTYPE html><html><head><meta charset="utf-8"><title>pip</title></head><body></body></html>');
            doc.close();
            var win = frame.contentWindow;
            var origClose = win.close.bind(win);
            win.close = function () {
              origClose();
              try { frame.parentNode.removeChild(frame); } catch (e) { /* ignore */ }
            };
            return win;
          };
        } else {
          state.detachWindowFactory = null;
          var frames = document.querySelectorAll('[data-stt-fake-pip]');
          for (var i = 0; i < frames.length; i++) {
            if (frames[i].parentNode) frames[i].parentNode.removeChild(frames[i]);
          }
        }
        sendResponse({ ok: true, enabled: !!state.detachWindowFactory });
        return false;
      case 'RETRANSLATE':
        retranslate();
        sendResponse({ ok: true });
        return false;
      case 'SETTINGS_CHANGED':
        Engine.invalidateSettings();
        Engine.getSettings(true).then(function (s) {
          var prevLayout = state.settings && state.settings.layout;
          var prevHighlight = state.settings && state.settings.highlightOriginal;
          state.settings = s;
          if (ui.cloneBody) {
            ui.cloneBody.classList.toggle('st-reading', !!s.readingStyle);
            ui.cloneBody.style.setProperty('font-size', s.fontSize + 'px', 'important');
            ui.cloneBody.style.setProperty('line-height', String(s.lineHeight), 'important');
          }
          // 版面在设置页改了 → 立即重排
          if (state.splitActive && s.layout && s.layout !== prevLayout) {
            applyLayout(s.layout, false);
          }
          // 角标开关
          if (state.splitActive) {
            var wanted = !!s.showPaneBadge;
            [ui.original, ui.translated].forEach(function (pane) {
              if (!pane) return;
              var badge = pane.querySelector(':scope > .st-pane-badge');
              if (wanted && !badge) addPaneBadge(pane, pane.getAttribute('data-stt-pane') === 'original' ? '原文' : '译文');
              else if (!wanted && badge && badge.parentNode) badge.parentNode.removeChild(badge);
            });
            positionBadges();
          }
          // 悬停高亮开关切换
          if (state.splitActive && !!s.highlightOriginal !== !!prevHighlight) {
            if (s.highlightOriginal) initHoverLink();
            else clearHoverHighlight();
          }
          reportState();
          sendResponse({ ok: true });
        });
        return true;
      // 允许页面侧（同一扩展的其它上下文）通过内容脚本保存设置。
      // 浏览器只允许本扩展自身的上下文发送这类消息，网页脚本无法伪造。
      case 'SAVE_SETTINGS':
        Engine.saveSettings(msg.settings || {}).then(function (s) {
          state.settings = s;
          try { chrome.runtime.sendMessage({ type: 'SETTINGS_CHANGED' }); } catch (e) { /* ignore */ }
          sendResponse({ ok: true, settings: s });
        });
        return true;
      case 'DETECT_AGAIN':
        runDetection(true).then(function (d) { sendResponse({ ok: true, detection: d }); });
        return true;
      default:
        return false;
    }
  }

  /* ================================================================== */
  /* 9. 语言检测与自动触发                                               */
  /* ================================================================== */

  /**
   * 页面语言检测。
   *
   * 流程（按用户要求实现）：
   *   1) 先抽取页面上「所有能直接提取的文字」（整页遍历，不再是前 4000 字符的采样），
   *      统计汉字 / 假名 / 谚文 / 拉丁等文字系统的占比；
   *   2) 用「谁占主导」而不是「有没有达到阈值」判断语言；
   *   3) 网页声明（<html lang> 等）与整页统计一致时，直接采信声明；
   *   4) 仍不确定（置信度低、或声明与统计冲突）且用户允许时，调用 AI 接口兜底识别。
   *
   * @param {boolean} [force]
   * @returns {Promise<object>}
   */
  function runDetection(force) {
    var s = state.settings || {};
    var det = Lang.detectDocument(document);

    /* ---- 第 3 步：声明与统计一致，采信声明 ---- */
    if (!force && det.declared && det.declarationAgrees) {
      det = Lang.declaredResult(det);
      det.sampleChars = det.sampleChars;
      finished(det);
      return Promise.resolve(det);
    }

    /* ---- 第 4 步：判不准时用 API 兜底 ---- */
    var mode = s.languageDetect || 'local';
    var lowConfidence = det.confidence < (s.minConfidence || 0.5);
    var conflicted = !!(det.declared && !det.declarationAgrees);
    var needApi = mode === 'api' || (mode === 'local-api' && (lowConfidence || conflicted));

    if (!force && needApi && s.apiKey) {
      log('语言检测不确定（' + det.code + ' ' + det.confidence.toFixed(2) +
        '，页面声明 ' + (det.declared || '无') + '），改用 AI 识别兜底');
      var sample = Lang.collectPageText(document).text;
      return Engine.detectLanguageViaApi(sample, s).then(function (r) {
        if (r && r.code) {
          det.code = r.code;
          det.name = Lang.LANG_NAME[r.code] || r.code;
          det.isChinese = r.code === 'zh_Hans' || r.code === 'zh_Hant';
          det.isSimplifiedChinese = r.code === 'zh_Hans';
          det.confidence = 0.92;
          det.source = 'api';
          det.apiRaw = r.raw;
          det.script = '';
          log('AI 识别结果：' + r.code + '（原始返回："' + r.raw + '"）');
        } else {
          det.source = 'local';
        }
        return finished(det);
      });
    }

    det.source = det.source || 'local';
    return Promise.resolve(finished(det));

    function finished(d) {
      // 记录判定依据，便于 popup / 日志排查
      d.hanCount = d.hanCount || 0;
      d.hangulCount = d.hangulCount || 0;
      d.kanaCount = d.kanaCount || 0;
      state.detection = d;
      reportState();
      log('语言检测：' + d.name + '（' + d.code + '，置信度 ' + d.confidence.toFixed(2) +
        '，来源 ' + (d.source || (d.fromDeclaration ? '声明' : '统计')) +
        '，汉字 ' + d.hanCount + ' / 谚文 ' + d.hangulCount + ' / 假名 ' + d.kanaCount +
        '，采样 ' + (d.sampleChars || 0) + ' 字）');
      return d;
    }
  }

  function maybeAutoActivate() {
    var s = state.settings;
    if (!s || s.autoMode === 'off') return Promise.resolve();

    return runDetection().then(function (det) {
      if (!Lang.shouldTranslate(det)) {
        log('页面主要语言为' + det.name + '，无需翻译');
        return;
      }
      if (det.confidence < s.minConfidence) {
        log('语言检测置信度过低（' + det.confidence.toFixed(2) + '），不自动提示');
        return;
      }
      if (Engine.isExcluded(location.href, s)) return Promise.resolve();

      if (s.autoMode === 'auto') return translate({ reason: 'auto' });

      if (s.autoMode === 'smart') {
        return isSiteIgnored().then(function (ignored) {
          if (ignored) return;
          // 稍等一下再显示，避免与页面首屏动画抢注意力
          setTimeout(function () { showBanner(det); }, 600);
        });
      }
      // manual：什么都不做
    });
  }

  /* ================================================================== */
  /* 10. 启动                                                            */
  /* ================================================================== */

  function watchUrlChange() {
    setInterval(function () {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      // SPA 路由切换后重新检测；如果正在分屏，保持现状
      if (state.splitActive) return;
      hideBanner();
      setTimeout(function () { maybeAutoActivate(); }, 800);
    }, 1500);
  }

  function init() {
    // 恢复用户上次设定的分屏比例
    try {
      var saved = parseFloat(localStorage.getItem('splitTranslateRatio'));
      if (saved > 0) state.ratio = saved;
    } catch (e) { /* ignore */ }

    Engine.getSettings(true).then(function (s) {
      state.settings = s;
      state.ratio = state.ratio || s.defaultRatio || 50;
      state.lastSentState = '';
      reportState();
      maybeAutoActivate();

      // 监听设置变化，实时生效
      try {
        chrome.storage.onChanged.addListener(function (changes, area) {
          if (area === 'local' && changes[Engine.STORAGE_SETTINGS]) {
            Engine.invalidateSettings();
            Engine.getSettings(true).then(function (ns) {
              var prevProvider = state.settings && state.settings.provider;
              state.settings = ns;
              if (ns.autoMode === 'off') hideBanner();
              reportState();
              if (prevProvider !== ns.provider) log('翻译服务商已切换为 ' + ns.provider);
            });
          }
        });
      } catch (e) { /* ignore */ }
    });

    try {
      chrome.runtime.onMessage.addListener(handleMessage);
    } catch (e) { /* ignore */ }

    // 页面卸载时清理（避免 bfcache 恢复后残留）
    window.addEventListener('pagehide', function () {
      stopObserver();
    });
    window.addEventListener('pageshow', function (e) {
      if (e.persisted && state.splitActive) reportState();
    });

    watchUrlChange();
    log('内容脚本已就绪');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
