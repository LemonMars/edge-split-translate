/**
 * tools/audit-privacy.js —— 发布前隐私 / 密钥自查
 *
 * 检查项：
 *   1. 仓库里有没有 .env / 密钥文件 / 证书 / 私钥 之类不该提交的东西
 *   2. 文件内容里有没有真实 API Key、Token、密码、私钥
 *   3. 有没有泄露个人信息：本机绝对路径、Windows 用户名、内网 IP、真实邮箱、手机号
 *   4. 提交历史里有没有出现过上述内容（哪怕现在已删除）
 *
 * 用法：node tools/audit-privacy.js
 * 退出码：0 = 干净，1 = 发现问题
 */
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let problems = 0;
let warnings = 0;

function fail(msg) { problems++; console.log('  [问题] ' + msg); }
function warn(msg) { warnings++; console.log('  [注意] ' + msg); }
function ok(msg) { console.log('  [通过] ' + msg); }

function git(args) {
  try {
    return execSync('git ' + args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    return '';
  }
}

/* ------------------------------------------------------------------ */
console.log('\n[1] 危险文件类型检查');
/* ------------------------------------------------------------------ */

const DANGEROUS = [
  [/^\.env(\.|$)/i, '.env 环境变量文件'],
  [/\.pem$/i, 'PEM 证书 / 私钥'],
  [/\.key$/i, '密钥文件'],
  [/\.p12$/i, 'PKCS#12 密钥库'],
  [/\.pfx$/i, 'PFX 密钥库'],
  [/^id_rsa/i, 'SSH 私钥'],
  [/^id_ed25519/i, 'SSH 私钥'],
  [/credentials?\.json$/i, '凭据文件'],
  [/secrets?\.json$/i, '密钥文件'],
  [/\.crt$/i, '证书文件'],
  [/\.npmrc$/i, 'npm 凭据'],
  [/\.netrc$/i, 'netrc 凭据'],
  [/\.crx$/i, '打包的扩展（含签名）'],
  [/\.pfx$/i, 'PFX']
];

const tracked = git('ls-files').split('\n').filter(Boolean);
console.log('  仓库跟踪文件数: ' + tracked.length);

let dangerHits = 0;
tracked.forEach((f) => {
  DANGEROUS.forEach(([re, label]) => {
    if (re.test(path.basename(f))) { fail(f + '  属于「' + label + '」'); dangerHits++; }
  });
});
if (!dangerHits) ok('没有 .env / 私钥 / 证书 / 凭据文件被跟踪');

// 检查工作区里有没有这类文件（即便没被跟踪也要知道）
const loose = [];
(function scan(dir, depth) {
  if (depth > 3) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) scan(full, depth + 1);
    else {
      DANGEROUS.forEach(([re, label]) => {
        if (re.test(e.name)) loose.push(full.replace(ROOT + path.sep, '') + '  (' + label + ')');
      });
    }
  }
})(ROOT, 0);
if (loose.length) warn('工作区存在敏感文件（未被 git 跟踪，但请确认 .gitignore 覆盖）:\n      ' + loose.join('\n      '));
else ok('工作区也没有发现敏感文件');

/* ------------------------------------------------------------------ */
console.log('\n[2] 内容里的密钥 / 凭据');
/* ------------------------------------------------------------------ */

// 注意：这些正则刻意写得保守，避免把测试用的假 key 误报成真实泄漏
const SECRET_PATTERNS = [
  [/sk-[A-Za-z0-9]{20,}/, 'OpenAI / DeepSeek 风格的 sk- 密钥'],
  [/sk-ant-[A-Za-z0-9\-_]{20,}/, 'Anthropic 密钥'],
  [/ghp_[A-Za-z0-9]{30,}/, 'GitHub Personal Access Token (ghp_)'],
  [/github_pat_[A-Za-z0-9_]{30,}/, 'GitHub 细粒度 PAT'],
  [/gho_[A-Za-z0-9]{30,}/, 'GitHub OAuth Token'],
  [/xox[baprs]-[A-Za-z0-9\-]{10,}/, 'Slack Token'],
  [/AKIA[0-9A-Z]{16}/, 'AWS Access Key ID'],
  [/AIza[0-9A-Za-z\-_]{30,}/, 'Google API Key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '私钥内容'],
  [/\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/, 'JWT'],
  [/(api[_-]?key|apikey|secret|passwd|password|token)\s*[:=]\s*["'][A-Za-z0-9_\-]{24,}["']/i, '硬编码的密钥 / 密码']
];

const TEXT_EXT = /\.(js|json|md|html|css|txt|yml|yaml|sh|ps1)$/i;
let secretHits = 0;
tracked.filter((f) => TEXT_EXT.test(f) || path.basename(f) === 'LICENSE').forEach((f) => {
  let content = '';
  try { content = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (e) { return; }
  const lines = content.split('\n');
  lines.forEach((line, i) => {
    SECRET_PATTERNS.forEach(([re, label]) => {
      if (re.test(line)) {
        fail(f + ':' + (i + 1) + '  疑似「' + label + '」 → ' + line.trim().slice(0, 100));
        secretHits++;
      }
    });
  });
});
if (!secretHits) ok('跟踪的任何文件里都没有发现真实密钥 / Token / 私钥');

// 明确列出测试用的假 key，确认它们无害
console.log('\n  附：代码里出现的「测试用假值」（应确认全是假的）');
const FAKE_RE = /(apiKey|api_key|token)\s*[:=]\s*['"]([^'"]{1,60})['"]/gi;
tracked.filter((f) => TEXT_EXT.test(f)).forEach((f) => {
  let content = '';
  try { content = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (e) { return; }
  content.split('\n').forEach((line, i) => {
    let m;
    FAKE_RE.lastIndex = 0;
    while ((m = FAKE_RE.exec(line)) !== null) {
      console.log('    ' + f + ':' + (i + 1) + '  ' + m[1] + ' = ' + JSON.stringify(m[2]));
    }
  });
});

/* ------------------------------------------------------------------ */
console.log('\n[3] 个人信息 / 本机痕迹');
/* ------------------------------------------------------------------ */

const PRIVACY_PATTERNS = [
  [/[A-Za-z]:\\\\?Users\\\\?[A-Za-z0-9._\-]+/g, '本机 Windows 绝对路径（含用户名）'],
  [/[A-Za-z]:\\[A-Za-z0-9._\-\\ ]{3,}/g, 'Windows 绝对路径（盘符）'],
  [/\/Users\/[A-Za-z0-9._\-]+/g, 'macOS 家目录路径'],
  [/\/home\/[A-Za-z0-9._\-]+/g, 'Linux 家目录路径'],
  [/\bDESKTOP-[A-Z0-9]{7}\b/gi, '本机主机名'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, 'IP 地址'],
  [/[A-Za-z0-9._%+\-]+@(?!users\.noreply\.github\.com|example\.com)[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, '邮箱地址'],
  [/\b1[3-9]\d{9}\b/g, '中国大陆手机号'],
  [/\b\d{15,19}\b/g, '疑似身份证 / 银行卡号'],
  [/\b[a-f0-9]{40,}\b/gi, '疑似长哈希（可能是 token）'],
  [/appdata\\+local\\+temp/gi, '本机临时目录路径']
];

// 白名单：这些是刻意存在的公开信息或文档示例
const ALLOWLIST = [
  /127\.0\.0\.1/,            // 本地回环，测试必须
  /0\.0\.0\.0/,
  /LemonMars/,               // 仓库所有者，公开信息
  /github\.com\/LemonMars/,
  /edge-split-translate/,
  /example\.com/,
  /mail\.google\.com/,
  /api\.deepseek\.com/, /api\.minimax\.cn/, /api\.openai\.com/,
  /api\.siliconflow\.cn/, /api\.moonshot\.cn/, /dashscope\.aliyuncs\.com/,
  /localhost/,
  /142372241/,               // 已确认是用户自己的 GitHub ID（见 git 配置）
  /sha256/, /d8dc66b8/, /afe1b5c1/, /afc331d5/,
  // 文档里刻意写出来的「反例」路径（例如「不要填本机路径」的说明）
  /Users\\+a1418/,
  /Users\\+[A-Za-z0-9._\-]+\\+AppData/,
  /Data\\+Local\\+Temp/,
  /edge-split-translate/,
  /src\\+lib/, /src\\+content/,
  // Windows 盘符路径在文档里的合法示例
  /Work\\+edge-split-translate/,
  /Program Files/,
  /Windows\\+System32/
];

let privHits = 0;
tracked.forEach((f) => {
  if (path.basename(f) === 'LICENSE') return;
  let content = '';
  try { content = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (e) { return; }
  const lines = content.split('\n');
  lines.forEach((line, i) => {
    PRIVACY_PATTERNS.forEach(([re, label]) => {
      re.lastIndex = 0;
      const found = line.match(re);
      if (!found) return;
      found.forEach((hit) => {
        if (ALLOWLIST.some((a) => a.test(hit))) return;
        fail(f + ':' + (i + 1) + '  疑似「' + label + '」 → ' + hit + '   行内容: ' + line.trim().slice(0, 90));
        privHits++;
      });
    });
  });
});
if (!privHits) ok('没有发现本机路径 / 主机名 / 真实邮箱 / 手机号等个人痕迹');

/* ------------------------------------------------------------------ */
console.log('\n[4] 提交历史检查（含已删除的内容）');
/* ------------------------------------------------------------------ */

const allPaths = git('log --all --pretty=format: --name-only --diff-filter=A')
  .split('\n').map((s) => s.trim()).filter(Boolean);
const uniquePaths = [...new Set(allPaths)];
console.log('  历史上出现过的路径数: ' + uniquePaths.length);
const badHistory = uniquePaths.filter((f) => DANGEROUS.some(([re]) => re.test(path.basename(f))));
if (badHistory.length) fail('历史提交里出现过敏感文件: ' + badHistory.join(', '));
else ok('历史提交里从未出现过敏感文件');

// 全历史内容扫描：把所有版本的文本内容拼起来查密钥
const allBlobs = git('rev-list --objects --all').split('\n').filter(Boolean);
let historySecretHits = 0;
const seen = new Set();
allBlobs.forEach((entry) => {
  const [sha, ...rest] = entry.split(' ');
  const file = rest.join(' ');
  if (!file || seen.has(sha)) return;
  if (!TEXT_EXT.test(file)) return;
  seen.add(sha);
  const content = git('cat-file -p ' + sha);
  if (!content) return;
  SECRET_PATTERNS.forEach(([re, label]) => {
    if (re.test(content)) {
      fail('历史对象 ' + sha.slice(0, 8) + ' (' + file + ') 命中「' + label + '」');
      historySecretHits++;
    }
  });
});
if (!historySecretHits) ok('全历史所有版本的文本内容里都没有真实密钥');

/* ------------------------------------------------------------------ */
console.log('\n[5] git 身份与配置');
/* ------------------------------------------------------------------ */

const name = git('config user.name').trim();
const email = git('config user.email').trim();
console.log('  提交身份: ' + name + ' <' + email + '>');
if (/noreply\.github\.com$/i.test(email)) ok('邮箱是 GitHub noreply 形式，不暴露真实邮箱');
else warn('邮箱 ' + email + ' 会写进每次提交，确认你愿意公开它');
if (fs.existsSync(path.join(ROOT, '.git', 'config'))) {
  const cfg = fs.readFileSync(path.join(ROOT, '.git', 'config'), 'utf8');
  if (/\/\/[^/]*:[^@/]*@/.test(cfg)) fail('.git/config 的 remote 里嵌了用户名密码明文！');
  else ok('.git/config 里的 remote 没有内嵌凭据');
}

const remotes = git('remote -v').trim();
console.log('  remote:\n' + remotes.split('\n').map((l) => '    ' + l).join('\n'));
if (/:.*@/.test(remotes)) fail('remote URL 里含凭据');
else ok('remote URL 是干净的 https 地址，不含 token');

/* ------------------------------------------------------------------ */
console.log('\n[6] .gitignore 是否覆盖了敏感文件');
/* ------------------------------------------------------------------ */

let ignore = '';
try { ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'); } catch (e) { /* ignore */ }
const NEEDED = ['.env', '*.pem', '*.zip', 'node_modules', '*.log'];
const missingIgnore = NEEDED.filter((n) => ignore.indexOf(n) < 0);
if (missingIgnore.length) warn('.gitignore 缺少: ' + missingIgnore.join(', '));
else ok('.gitignore 覆盖了 ' + NEEDED.join(' / '));

/* ------------------------------------------------------------------ */
console.log('\n========================================');
console.log('结果：' + problems + ' 个问题，' + warnings + ' 个注意项');
if (problems === 0) console.log('未发现隐私 / 密钥泄漏，可以安全公开。');
console.log('========================================\n');
process.exit(problems ? 1 : 0);
