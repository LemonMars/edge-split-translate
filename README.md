# 分屏翻译 · Split Translate

一个 Microsoft Edge / Chrome 浏览器扩展（Chromium **Manifest V3**）：自动检测网页主要语言，
非简体中文时把页面从中间分开 —— **一边原文、一边简体中文译文**，保持原网页 HTML 结构与
CSS 样式不变，只替换文本内容。翻译走任意 **OpenAI 兼容**的 Chat Completions 接口，
内置 DeepSeek 与 MiniMax 预设，也可自定义。

```
┌───────────────────────┬───────────────────────┐
│  原文（原始 DOM）      │  译文（镜像 DOM）      │
│  原站 CSS 完全生效      │  逐段替换为简体中文     │
│  可滚动 / 可点链接      │  链接同样可点           │
└───────────────────────┴───────────────────────┘
        ← 中间分隔线可拖动，双击回到 50 : 50 →
```

## 功能一览

### 核心
- **自动语言检测**：Unicode 文字系统统计 + 拉丁语系停用词打分 + 简繁特征字判定，
  可区分英/法/德/西/葡/意/荷/越/印尼/土/波/俄/阿/希/泰/日/韩/简体中文/繁体中文
- **不破坏原页面**：左侧放的是**原始 DOM 节点**（不是复制品），原站 CSS 完全生效；
  右侧是结构完全一致的深拷贝镜像，逐段回填译文
- **只翻译该翻译的**：自动跳过 `script/style/code/pre`、`translate="no"`、`.notranslate`、
  `contenteditable`、隐藏元素、纯数字/纯标点/URL/邮箱/代码片段
- **批量请求**：按「段数 + 字符数」双阈值合批，同文去重，串行发送避免触发限流
- **本地缓存**：按「服务商 + 模型 + 目标语言」哈希缓存到 `chrome.storage.local`，
  二次访问同一页面零请求

### 交互
- **译文栏链接可直接点击**：站内链接当前标签页打开，站外链接自动新开标签页，
  `Ctrl`/中键强制新开；页内锚点滚动原文栏；`javascript:`/`data:` 等协议一律拒绝
- **四种版面**：原文可在左 / 右 / 上 / 下。上下版面时分隔线自动变成横向可拖动
- **独立小窗**：基于 Document Picture-in-Picture，把译文放进可拖动的小窗（默认关闭）
- **思考强度**：可选 `reasoning_effort`（低/中/高），接口不认时自动去掉参数重试，不会翻译失败
- **悬停对照**：悬停译文显示原文气泡，并高亮原文栏对应段落
- **原文/译文角标**：两栏左上角标注，滚动后自动淡出

### 自动化程度
| 模式 | 行为 |
|---|---|
| 智能提示（默认） | 顶部出现「检测到 XXX 页面，是否翻译为简体中文？」提示条，含翻译 / 忽略 / 设置 |
| 完全自动 | 直接分屏翻译，不询问 |
| 仅手动 | 只响应工具栏按钮 / 右键菜单 |
| 关闭扩展 | 不检测不提示 |

### 其它
- 动态加载内容续翻（`MutationObserver`，可选）
- 「全语言识别 API」：页面正文是图片时，调用多模态模型先取字再翻译；未配置则降级提示
- 工具栏弹窗：手动翻译、恢复原页面、重新翻译、版面切换、比例调节、独立小窗
- 右键菜单：分屏翻译此页面 / 翻译选中文本（通知展示）/ 设置
- 设置页支持测试连接、拉取模型列表、导入导出设置、清空缓存
- 页面级字符预算（默认 15 万字符），防止动态页面把 API 额度吃光

## 目录结构

```
edge-split-translate/
├── manifest.json              MV3 清单
├── background.js              Service Worker：接口代理、缓存、导航、右键菜单、按需注入
├── content/
│   ├── content.js             内容脚本：检测→分屏→扫描→翻译→回填→动态续翻
│   └── content.css            注入样式（分屏 / 提示条 / 状态条 / 角标 / 小窗）
├── lib/
│   ├── lang.js                语言检测（可独立复用）
│   └── engine.js              OpenAI 兼容接口封装、预设、批处理、缓存、多模态 OCR
├── popup/                     工具栏弹窗（html / js / css）
├── options/                   设置页（html / js / css）
├── icons/                     图标（PNG，含 SVG 源文件）
├── _locales/zh_CN/            i18n 文案
├── tools/                     开发工具（扩展不加载）
│   ├── make-icons.js          纯 Node 生成 PNG 图标（自带 zlib + PNG 编码器）
│   ├── verify-icons.js        图标解码自检
│   └── self-test.js           无浏览器自检（140 项）
└── tests/                     端到端测试（扩展不加载）
    ├── e2e.js                 无头 Edge + CDP 驱动（131 项断言）
    └── fixture-fr.html        测试用法文页面
```

> `tools/` 与 `tests/` 不在 `manifest.json` 里，浏览器不会加载它们；
> 打包上架时可以直接删掉。`tests/e2e.js` 自己会剥掉这两个目录再加载扩展。

## 快速开始

### 1. 加载扩展

1. 打开 `edge://extensions/`（Chrome 是 `chrome://extensions/`）
2. 打开左下角 **开发人员模式**
3. 点 **加载解压缩的扩展**，选择本仓库根目录（含 `manifest.json` 的那一层）

### 2. 配置 API Key

首次安装会自动打开设置页，也可以右键扩展图标 → 「扩展选项」：

1. **服务商预设** 选 `DeepSeek` 或 `MiniMax`（自动填好 Base URL 与模型名）

   | 服务商 | Base URL | 模型 |
   |---|---|---|
   | DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
   | MiniMax | `https://api.minimax.cn/v1` | `MiniMax-M3` |
   | 其他 | 任何 OpenAI 兼容地址 | 自行填写 |

2. 填入 **API Key**
3. 点 **测试连接**，看到「连接成功」即可
4. 点 **保存设置**

> Base URL 只填到 `/v1`，扩展会自动补 `/chat/completions`；直接粘完整地址也可以。
> API Key 只存在本机 `chrome.storage.local`，不会上传到任何第三方。

### 3. 使用

打开任意外语页面 → 顶部提示条点「翻译」→ 分屏对照。
工具栏图标可手动触发、换版面、调比例、开独立小窗；右键菜单支持划词翻译。

## 开发者验证

仓库自带两套可复现的验证，不需要装任何依赖（只用 Node 内置模块）：

```bash
# 1) 无浏览器自检：清单完整性、语言检测准确率、译文解析器、表单字段一致性
node tools/self-test.js          # 期望：140 项通过，0 项失败

# 2) 真实浏览器端到端：无头 Edge + CDP，法文页面 → 提示条 → 分屏 → 翻译 → 交互
node tests/e2e.js                # 期望：131 项通过，0 项失败

# 3) 发布前隐私自查：密钥、本机路径、真实邮箱、.env 等
node tools/audit-privacy.js      # 期望：0 个问题，0 个注意项

# 4) 重新生成图标（改过 icons/icon128.svg 之后）
node tools/make-icons.js
node tools/verify-icons.js       # 期望：全部图标校验通过
```

`tests/e2e.js` 会自己起一个本地 mock 的 OpenAI 兼容接口（译文统一加 `[中]` 前缀），
然后用 CDP 驱动无头 Edge 完成整条用户路径并断言 DOM 结构，包括：

- 提示条文案/按钮/定位、分屏容器是 `flex` 还是 `column`、两栏比例换算
- 镜像与原文的**祖先链一致性**、代码块与 `translate="no"` 未被翻译、表格与链接数量一致
- 请求确实被批量合并（批次数 < 段落数，每批 ≤ batchSize）
- 拖动分隔线改比例、恢复原页面、二次访问命中缓存
- 译文栏链接点击决策（站内 `sameTab` / 站外 `newTab`）、四种版面重排
- 独立小窗搬运与回收（用隐藏 iframe 冒充 PiP 窗口，绕开无头环境的用户手势限制）
- `reasoning_effort` 真的出现在请求体里，关掉后确实不发送

环境要求：Node 18+，机器上装有 Edge 或 Chrome（脚本会自动探测路径）。
若想跳过浏览器部分，只跑 `node tools/self-test.js` 即可。

## 技术要点

**分屏为什么用「移动原 DOM」而不是 iframe**：iframe 会重新加载页面、丢失登录态与滚动位置，
且很多站点设置 `X-Frame-Options` 拒绝被嵌。这里把 `document.body` 的子节点整体搬进
`position:fixed` 的分屏容器，原站 CSS 依旧生效；右侧克隆一份镜像用于回填译文。

**译文如何精确回填**：扫描阶段给每个待翻译文本节点外包一层 `<span data-stt-id="N">`，
克隆镜像后按同一个 id 用 `querySelector` 定位，语义上保证「结构一一对应」。

**几个踩过的坑**（代码里有注释）：
- `document.createTreeWalker` 的 `FILTER_REJECT` 在动态包裹子树的场景下行为不可靠，
  改用自己写的递归遍历
- 必须在**搬移 body 子节点之前**克隆镜像，否则会把刚建好的分屏容器一起克隆进去
- 提示条要在建分屏前收起，否则会被克隆进译文栏
- `flex-basis: var(--st-ratio) !important` 在部分 Chromium 上不随变量变化重新解析，
  比例会锁死；改为运行时直接写内联像素级 flex 值，并把结果记录在 `data-stt-*` 属性上

## 已知限制

- 浏览器内置页（`edge://`、扩展商店等）无法注入脚本
- 跨域 iframe 内部无法注入，对应位置显示占位提示
- `<canvas>` / WebGL 渲染的文字无法提取
- 正文为图片的页面需配置「全语言识别 API」（多模态模型）
- 独立小窗依赖 Document Picture-in-Picture（Edge/Chrome 116+），不支持的浏览器降级为普通小窗快照

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

[MIT](LICENSE) © 2026 LemonMars

可自由使用、修改、分发、商用，只需保留版权声明与许可证原文。
