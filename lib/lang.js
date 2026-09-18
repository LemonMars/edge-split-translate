/**
 * lib/lang.js —— 轻量级语言检测（无外部依赖，可在 content script / service worker / 普通页面中复用）
 *
 * 策略：
 *   1) 先看 <html lang> 与 meta 标签（最可靠的提示）；
 *   2) 再对页面主要文本做 Unicode 文字系统（script）统计；
 *   3) 拉丁字母再叠加一份「停用词 + 变音符号」打分，区分英/法/德/西/葡/意/越/印尼等；
 *   4) 中日文本用假名 / 谚文 / 简繁特征字区分。
 *
 * 同时导出一套「是否为简体中文」的判定，供自动翻译流程使用。
 */
(function (root) {
  'use strict';

  /** 有明确 Unicode 区段的文字系统 */
  var SCRIPT_RANGES = [
    ['han',      /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/],
    ['kana',     /[\u3040-\u309F\u30A0-\u30FF\u31F0-\u31FF]/],
    ['hangul',   /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/],
    ['cyrillic', /[\u0400-\u04FF\u0500-\u052F]/],
    ['arabic',   /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/],
    ['hebrew',   /[\u0590-\u05FF]/],
    ['thai',     /[\u0E00-\u0E7F]/],
    ['devanagari', /[\u0900-\u097F]/],
    ['bengali',  /[\u0980-\u09FF]/],
    ['greek',    /[\u0370-\u03FF\u1F00-\u1FFF]/],
    ['latin',    /[A-Za-z\u00C0-\u024F\u1E00-\u1EFF]/]
  ];

  var SCRIPT_LANG = {
    cyrillic: 'ru', arabic: 'ar', hebrew: 'he', thai: 'th',
    devanagari: 'hi', bengali: 'bn', greek: 'el', hangul: 'ko', kana: 'ja', han: 'zh'
  };
  var SCRIPT_NAME = {
    han: '中文', kana: '日语', hangul: '韩语', cyrillic: '俄语/西里尔文', arabic: '阿拉伯语',
    hebrew: '希伯来语', thai: '泰语', devanagari: '印地语', bengali: '孟加拉语',
    greek: '希腊语', latin: '拉丁字母文字', other: '未知语言'
  };
  var LANG_NAME = {
    en: '英语', fr: '法语', de: '德语', es: '西班牙语', pt: '葡萄牙语', it: '意大利语',
    nl: '荷兰语', vi: '越南语', id: '印尼语', tr: '土耳其语', pl: '波兰语', ro: '罗马尼亚语',
    sv: '瑞典语', da: '丹麦语', cs: '捷克语', hu: '匈牙利语', fi: '芬兰语',
    ru: '俄语', ar: '阿拉伯语', he: '希伯来语', th: '泰语', hi: '印地语', bn: '孟加拉语',
    el: '希腊语', ko: '韩语', ja: '日语', zh: '中文', zh_Hant: '繁体中文', zh_Hans: '简体中文'
  };

  /** 拉丁语系停用词打分表 */
  var LATIN_STOPWORDS = {
    en: ['the', 'and', 'of', 'to', 'in', 'is', 'that', 'for', 'it', 'with', 'as', 'was', 'on', 'are', 'you', 'this', 'be', 'or', 'by', 'not', 'from', 'at', 'have'],
    fr: ['le', 'la', 'les', 'des', 'est', 'et', 'une', 'un', 'pour', 'dans', 'que', 'qui', 'sur', 'pas', 'plus', 'au', 'ce', 'sont', 'avec', 'vous', 'nous', 'par', 'mais'],
    de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ein', 'eine', 'mit', 'für', 'auf', 'sich', 'den', 'dem', 'des', 'auch', 'werden', 'wird', 'bei', 'aus', 'oder', 'aber', 'von', 'zu'],
    es: ['el', 'la', 'los', 'las', 'de', 'que', 'y', 'en', 'un', 'una', 'es', 'por', 'con', 'para', 'no', 'se', 'su', 'al', 'del', 'como', 'más', 'pero', 'este', 'son'],
    pt: ['de', 'que', 'não', 'em', 'um', 'uma', 'para', 'com', 'os', 'as', 'do', 'da', 'é', 'se', 'por', 'mais', 'como', 'mas', 'foi', 'são', 'você', 'também'],
    it: ['il', 'lo', 'la', 'gli', 'le', 'di', 'che', 'e', 'un', 'una', 'per', 'con', 'non', 'sono', 'del', 'della', 'più', 'come', 'anche', 'questo', 'si', 'ma'],
    nl: ['de', 'het', 'een', 'van', 'en', 'is', 'dat', 'op', 'te', 'voor', 'met', 'niet', 'zijn', 'aan', 'ook', 'om', 'als', 'maar', 'door', 'wordt'],
    vi: ['của', 'và', 'là', 'các', 'có', 'không', 'được', 'trong', 'cho', 'với', 'này', 'một', 'những', 'để', 'khi', 'người', 'trên', 'cũng'],
    id: ['yang', 'dan', 'di', 'itu', 'dengan', 'untuk', 'tidak', 'ini', 'dari', 'dalam', 'akan', 'pada', 'juga', 'adalah', 'ke', 'oleh', 'bisa'],
    tr: ['bir', 've', 'bu', 'için', 'ile', 'de', 'da', 'çok', 'daha', 'olarak', 'olan', 'var', 'ama', 'gibi', 'kadar'],
    pl: ['nie', 'się', 'jest', 'że', 'na', 'do', 'to', 'ale', 'jak', 'po', 'tak', 'oraz', 'przez', 'tylko', 'przy'],
    ro: ['și', 'este', 'nu', 'care', 'pentru', 'din', 'mai', 'sunt', 'dar', 'sau', 'acest', 'prin', 'fost'],
    sv: ['och', 'att', 'det', 'som', 'för', 'med', 'inte', 'har', 'den', 'till', 'är', 'på', 'av'],
    da: ['og', 'att', 'det', 'som', 'for', 'med', 'ikke', 'har', 'den', 'til', 'er', 'på', 'af'],
    cs: ['je', 'se', 'na', 'to', 'že', 'ale', 'jako', 'pro', 'která', 'který', 'jsou', 'byl'],
    hu: ['és', 'hogy', 'nem', 'egy', 'az', 'van', 'meg', 'mint', 'vagy', 'csak', 'már'],
    fi: ['ja', 'on', 'ei', 'se', 'että', 'oli', 'kun', 'myös', 'voi', 'mutta', 'ovat']
  };

  /** 变音符号 / 特有字母的特征位 */
  var LATIN_MARKS = [
    ['de', /[äöüß]/i],
    ['fr', /[àâçéèêëîïôùûüÿœæ]/i],
    ['es', /[ñ¿¡]/i],
    ['pt', /[ãõáâàçéêíóôú]/i],
    ['it', /[àèéìòù]/i],
    ['vi', /[ăâđêôơư]/i],
    ['tr', /[ğışİĞŞ]/],
    ['pl', /[ąćęłńóśźż]/i],
    ['ro', /[ăâîșț]/i],
    ['sv', /[åäö]/i],
    ['da', /[æøå]/i],
    ['cs', /[ěščřžýáíéúů]/i],
    ['hu', /[őűáéíóöü]/i],
    ['fi', /[äö]/i]
  ];

  /** 繁体特征字（页面里出现这些字基本都是繁体） */
  var TRAD_ONLY = '這個們來時對過還讓那麼樣種語學國會體實現親愛錢願覺應該點兒機車馬鳥龍龜萬億絲網線級給結統經綠紅紙約與說後進發開關為';
  /** 简体特征字 */
  var SIMP_ONLY = '这个们来时对过还让那么样种语学国会体实现亲爱钱愿觉应该点儿机车马鸟龙龟万亿丝网线级给结统经绿红纸约与说后进发开关为';

  /* ------------------------------------------------------------------ */
  /* 基础统计                                                            */
  /* ------------------------------------------------------------------ */

  /** 统计 0~0x2E80 之外的非 ASCII 字符数量，用于粗略判断「非拉丁文本」 */
  function countNonAscii(text) {
    var n = 0;
    for (var i = 0; i < text.length; i++) if (text.charCodeAt(i) > 127) n++;
    return n;
  }

  /**
   * 对文本做文字系统统计。
   * @returns {{counts:Object, total:number, letters:number}}
   */
  function countScripts(text) {
    var counts = { han: 0, kana: 0, hangul: 0, cyrillic: 0, arabic: 0, hebrew: 0, thai: 0, devanagari: 0, bengali: 0, greek: 0, latin: 0, digit: 0, punct: 0, other: 0 };
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\u3000') continue;
      if (ch >= '0' && ch <= '9') { counts.digit++; continue; }
      var matched = false;
      for (var j = 0; j < SCRIPT_RANGES.length; j++) {
        if (SCRIPT_RANGES[j][1].test(ch)) { counts[SCRIPT_RANGES[j][0]]++; matched = true; break; }
      }
      if (matched) continue;
      if (/[.,;:!?'"“”‘’()\[\]{}<>/\\|@#$%^&*_+=~`-]/.test(ch)) counts.punct++;
      else counts.other++;
    }
    var letters = counts.han + counts.kana + counts.hangul + counts.cyrillic + counts.arabic +
      counts.hebrew + counts.thai + counts.devanagari + counts.bengali + counts.greek + counts.latin;
    return { counts: counts, total: text.length, letters: letters };
  }

  /** 简繁判定：正数偏繁体，负数偏简体 */
  function traditionalScore(cjkText) {
    var t = 0, s = 0;
    for (var i = 0; i < cjkText.length; i++) {
      if (TRAD_ONLY.indexOf(cjkText[i]) >= 0) t++;
      if (SIMP_ONLY.indexOf(cjkText[i]) >= 0) s++;
    }
    return t - s;
  }

  /** 拉丁字母语言打分 */
  function scoreLatin(text) {
    var lower = text.toLowerCase();
    var words = lower.split(/[^a-z\u00C0-\u024F]+/).filter(function (w) { return w.length > 1; });
    var scores = {};
    var lang;
    for (lang in LATIN_STOPWORDS) {
      if (!Object.prototype.hasOwnProperty.call(LATIN_STOPWORDS, lang)) continue;
      scores[lang] = 0;
    }
    for (var i = 0; i < words.length; i++) {
      for (lang in LATIN_STOPWORDS) {
        if (LATIN_STOPWORDS[lang].indexOf(words[i]) >= 0) scores[lang]++;
      }
      // 特征字符额外加权
      for (var k = 0; k < LATIN_MARKS.length; k++) {
        if (LATIN_MARKS[k][1].test(words[i])) scores[LATIN_MARKS[k][0]] = (scores[LATIN_MARKS[k][0]] || 0) + 2;
      }
    }
    var best = 'en', bestScore = 0, sum = 0;
    for (lang in scores) {
      sum += scores[lang];
      if (scores[lang] > bestScore) { bestScore = scores[lang]; best = lang; }
    }
    // 没有任何停用词命中时，默认英文（拉丁字母 + 未识别）
    var confidence = sum > 0 ? bestScore / sum : 0;
    if (bestScore === 0) { best = 'en'; confidence = 0.25; }
    return { code: best, confidence: Math.min(0.99, 0.45 + confidence * 0.5) };
  }

  /* ------------------------------------------------------------------ */
  /* 主检测函数                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * 检测一段文本的主要语言。
   * @param {string} text 纯文本（建议 200~5000 字符）
   * @param {string} [hint] <html lang> 之类的提示，如 "en-US"
   * @returns {{code:string, lang:string, name:string, confidence:number, mixed:boolean, isChinese:boolean, isSimplifiedChinese:boolean}}
   */
  function detectText(text, hint) {
    text = String(text || '').slice(0, 8000);
    var st = countScripts(text);
    var c = st.counts;
    var hintCode = normalizeLangCode(hint);

    // 语言名称兜底
    function pack(code, confidence, mixed, scriptKey) {
      var isZh = code === 'zh' || code === 'zh_Hans' || code === 'zh_Hant' || (scriptKey === 'han');
      return {
        code: code,
        lang: code,
        name: LANG_NAME[code] || SCRIPT_NAME[scriptKey] || code || '未知',
        confidence: Math.max(0, Math.min(1, confidence)),
        mixed: !!mixed,
        isChinese: isZh,
        isSimplifiedChinese: code === 'zh' || code === 'zh_Hans'
      };
    }

    // 假名 / 谚文优先（这两种文字不会与中文混淆）
    if (c.kana >= 4 || (c.kana >= 2 && c.kana * 20 >= c.han)) return pack('ja', 0.95, false, 'kana');
    if (c.hangul >= 4) return pack('ko', 0.95, false, 'hangul');

    // 中文（汉字）
    if (c.han >= 4) {
      var cjk = text.replace(/[^\u4E00-\u9FFF\u3400-\u4DBF]/g, '');
      var tradScore = traditionalScore(cjk);
      var otherScripts = c.latin + c.cyrillic + c.arabic + c.hebrew + c.thai + c.devanagari + c.greek;
      var mixed = otherScripts > c.han * 0.5;
      var conf = Math.min(0.99, 0.6 + c.han / Math.max(1, c.han + otherScripts) * 0.39);
      if (tradScore > 0) return pack('zh_Hant', conf, mixed, 'han');
      return pack('zh_Hans', conf, mixed, 'han');
    }

    // 西里尔 / 阿拉伯 / 泰 / 希伯来 / 天城文
    var order = ['cyrillic', 'arabic', 'hebrew', 'thai', 'devanagari', 'bengali', 'greek'];
    for (var i = 0; i < order.length; i++) {
      var key = order[i];
      if (c[key] >= 4) return pack(SCRIPT_LANG[key], 0.9, false, key);
    }

    // 拉丁字母
    if (c.latin >= 4) {
      var r = scoreLatin(text);
      // <html lang> 提示与打分一致时提高置信度
      if (hintCode && hintCode === r.code) r.confidence = Math.min(0.99, r.confidence + 0.15);
      return pack(r.code, r.confidence, c.han > 0, 'latin');
    }

    // 文本太短（例如只有 "OK" 或纯数字）
    if (hintCode) return pack(hintCode, 0.35, false, 'other');
    return pack('und', 0.1, false, 'other');
  }

  /** 把 html lang / meta 里的语言标记规范化 */
  function normalizeLangCode(raw) {
    if (!raw) return '';
    var s = String(raw).trim().toLowerCase().replace(/_/g, '-');
    if (!s || s === 'und' || s === 'unknown') return '';
    if (s.indexOf('zh') === 0) {
      // zh-Hant / zh-TW / zh-HK / zh-MO → 繁体
      if (/hant|tw|hk|mo/.test(s)) return 'zh_Hant';
      return 'zh_Hans';
    }
    return s.split('-')[0];
  }

  /**
   * 检测当前文档的主要语言：结合 html lang、meta、以及正文文本。
   * @param {Document} doc
   * @returns {object} 同 detectText 的返回值，并附加 declared（网页声明的语言）
   */
  function detectDocument(doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (!doc) return detectText('');
    var declared = '';
    try {
      declared = (doc.documentElement && doc.documentElement.getAttribute('lang')) || '';
      if (!declared) {
        var meta = doc.querySelector('meta[http-equiv="content-language" i]');
        if (meta) declared = meta.getAttribute('content') || '';
      }
      if (!declared) {
        var og = doc.querySelector('meta[property="og:locale"]');
        if (og) declared = og.getAttribute('content') || '';
      }
    } catch (e) { /* ignore */ }

    var text = collectSampleText(doc, 4000);
    var res = detectText(text, declared);
    res.declared = declared ? normalizeLangCode(declared) : '';
    res.sampleLength = text.length;

    // 样本过少时信任网页声明
    if (text.replace(/\s+/g, '').length < 24 && res.declared) {
      var byDeclared = detectText('', res.declared);
      byDeclared.declared = res.declared;
      byDeclared.sampleLength = res.sampleLength;
      byDeclared.confidence = 0.5;
      return byDeclared;
    }
    return res;
  }

  /** 抽取页面可见文本样本（跳过脚本、样式、代码块） */
  function collectSampleText(doc, limit) {
    limit = limit || 4000;
    var out = [];
    var total = 0;
    var walker = doc.createTreeWalker(
      doc.body || doc.documentElement,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: function (node) {
          var p = node.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          var tag = p.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'CODE' ||
              tag === 'PRE' || tag === 'TEMPLATE' || tag === 'SVG' || tag === 'CANVAS') {
            return NodeFilter.FILTER_REJECT;
          }
          if (p.closest && p.closest('[aria-hidden="true"], .notranslate, [translate="no"]')) {
            return NodeFilter.FILTER_REJECT;
          }
          var t = node.nodeValue;
          if (!t || !t.trim()) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    var n;
    while ((n = walker.nextNode())) {
      var t = n.nodeValue.trim();
      out.push(t);
      total += t.length;
      if (total >= limit) break;
    }
    return out.join(' ').slice(0, limit * 1.5);
  }

  /** 判断检测结果是否应当触发翻译 */
  function shouldTranslate(det) {
    if (!det) return false;
    // 日文 / 韩文里虽然含汉字，但仍是外语
    if (det.code === 'ja' || det.code === 'ko') return true;
    return !det.isSimplifiedChinese;
  }

  var api = {
    SCRIPT_NAME: SCRIPT_NAME,
    LANG_NAME: LANG_NAME,
    detectText: detectText,
    detectDocument: detectDocument,
    normalizeLangCode: normalizeLangCode,
    countScripts: countScripts,
    countNonAscii: countNonAscii,
    scoreLatin: scoreLatin,
    traditionalScore: traditionalScore,
    collectSampleText: collectSampleText,
    shouldTranslate: shouldTranslate
  };

  // 同时挂到 self / window / globalThis，兼容 content script、service worker(importScripts) 与普通页面
  root.SplitTranslateLang = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
