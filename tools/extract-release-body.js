/**
 * tools/extract-release-body.js —— 从 docs/release-notes.md 里抽出「可直接粘贴」的正文
 *
 * 背景：在 GitHub 上从 markdown 的渲染视图（Preview）里复制，会把 ## 、代码围栏、表格
 * 全部丢成纯文本。这个脚本把围栏里的原始 markdown 原样导出成 .txt，
 * 打开后全选复制即可，格式一个字符都不会丢。
 *
 * 用法：node tools/extract-release-body.js [版本号，默认读 manifest.json]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'docs', 'release-notes.md');

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const version = process.argv[2] || manifest.version;
const OUT = path.join(ROOT, 'docs', 'release-body-v' + version + '.txt');

const raw = fs.readFileSync(SRC, 'utf8');
const NL = String.fromCharCode(10);   // 不写 "`n"，避免被 shell 吞掉

const startMarker = '## 模板正文（复制以下全部）';
const startIdx = raw.indexOf(startMarker);
if (startIdx < 0) {
  console.error('在 ' + SRC + ' 里找不到「' + startMarker + '」这一段');
  process.exit(1);
}
const rest = raw.slice(startIdx);

const fenceOpen = rest.indexOf('````markdown');
if (fenceOpen < 0) {
  console.error('模板段里找不到 ````markdown 围栏（外层围栏应为四个反引号）');
  process.exit(1);
}
const bodyStart = rest.indexOf(NL, fenceOpen) + 1;

/*
 * 找闭合围栏：必须是「整行恰好四个反引号」。
 * 外层围栏用四个反引号，正文里的 ```bash / ```json 等内层块才不会造成歧义。
 */
const afterOpen = rest.slice(bodyStart);
const afterLines = afterOpen.split(NL);
let closeLine = -1;
for (let i = 0; i < afterLines.length; i++) {
  if (afterLines[i].trim() === '````') { closeLine = i; break; }
}
if (closeLine < 0) {
  console.error('围栏没有闭合（找不到只含四个反引号的行）');
  process.exit(1);
}
let body = afterLines.slice(0, closeLine).join(NL);
// 版本号对齐：把正文里所有 vX.Y.Z 与 zip 名替换成当前版本
const stale = ['v1.1.0', 'v1.1.1', 'v1.0.0'].filter((v) => v !== 'v' + version);
if (stale.length) {
  const re = new RegExp(stale.map((s) => s.replace(/\./g, '\\.')).join('|'), 'g');
  body = body.replace(re, 'v' + version);
}

fs.writeFileSync(OUT, body, 'utf8');

const lines = body.split(NL);
const count = (re) => lines.filter((l) => re.test(l)).length;

console.log('已生成: ' + OUT);
console.log('字符数: ' + body.length + '  (' + (body.length / 1024).toFixed(1) + ' KB)');
console.log('');
console.log('结构自检:');
console.log('  标题行(#~###) : ' + count(/^#{2,3} /));
console.log('  表格行        : ' + count(/^\|/));
console.log('  代码围栏      : ' + count(/^```/) + '  (应为偶数)');
console.log('  列表项        : ' + count(/^- /));
console.log('');
console.log('章节列表:');
lines.filter((l) => /^#{2,3} /.test(l)).forEach((l) => console.log('  ' + l));
console.log('');
console.log('关键内容校验:');
const must = [
  ['安装说明', '方式一：直接下载安装'],
  ['首次配置', '## 首次配置'],
  ['服务商表格', '| DeepSeek |'],
  ['本版修复', '## 本版修复'],
  ['功能总览', '## 功能总览'],
  ['验证结果', '## 验证'],
  ['已知限制', '## 已知限制'],
  ['反馈入口', '## 反馈'],
  ['附件包名 ' + 'v' + version, 'edge-split-translate-v' + version + '.zip']
];
must.forEach(([name, needle]) => {
  console.log('  ' + (body.indexOf(needle) >= 0 ? '[OK]  ' : '[缺失] ') + name);
});
const first = lines.filter((l) => l.trim())[0];
const last = lines.filter((l) => l.trim()).slice(-1)[0];
console.log('');
console.log('首行: ' + first);
console.log('尾行: ' + last);
