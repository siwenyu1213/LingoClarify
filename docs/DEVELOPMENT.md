# 说文 · LingoClarify 开发、运行与验收

当前扩展版本 **1.0.0**。用户功能和文件职责见 [README](../README.md)。本手册描述现有入口与验收方法；交接材料和逐次任务QA、审查、环境记录仅本地保存，不随GitHub分发。

## 环境与目录

原生JavaScript / HTML / CSS的Manifest V3扩展，根目录直接加载，不需要构建、开发服务器或npm安装。Marked与DOMPurify固定版本保存在 `vendor/`，不能在运行时加载CDN脚本；来源和许可证见 [vendor说明](../vendor/README.md)。

运行需要支持MV3的Edge；静态与模拟使用Node.js，版本管理使用Git。浏览器工具使用本机已有Playwright，不给扩展新增运行依赖。Chrome及其他浏览器需另行验收。

| 路径 | 用途 |
| --- | --- |
| 根目录、`vendor/` | 运行源码、本地依赖与许可证 |
| `_locales/zh_CN/`、`_locales/en/` | 商店名称/简介的语言资源，默认简体中文；不代表设置界面已英文翻译 |
| `scripts/` | 可复用验证工具 |
| `PRIVACY.md` | 公开隐私政策，说明实际数据流、第三方接收方、存储、权限及用户控制 |
| `docs/DEVELOPMENT.md` | 公开开发说明与必要验收摘要 |
| `docs/materials/` | 有来源说明的公开、合成材料 |
| `.local/materials/` | 私有网页样本、逐次任务记录及交接材料 |
| `.local/tmp/` | 一次性脚本、缓存、下载 |
| `.local/browser-profile/` | 隔离浏览器配置 |
| `artifacts/qa/`、`artifacts/releases/` | 生成证据与分发产物，不进入Git |

克隆后进入包含 `manifest.json` 的仓库根目录，例如：

```powershell
Set-Location -LiteralPath '<本机仓库目录>'
```

GitHub入口为 `https://github.com/siwenyu1213/LingoClarify`。本地目录与品牌名可以不同，继续使用既有加载路径。存在 `Description.md` 时同步维护，保持本地忽略、不提交。

## 加载与更新

1. 打开 `edge://extensions`，开启开发人员模式。
2. 加载包含 `manifest.json` 的根目录。
3. 在“说文 · LingoClarify”设置页分别配置解释与翻译的厂家、Key、模型和语言；自定义连接先保存地址。
4. 修改源码或更新Git后重新加载扩展，并刷新测试网页。
5. 核对管理页错误，必要时打开服务工作线程开发者工具。

用普通HTTP/HTTPS页面测试，浏览器内部页面和受限制商店页不能作为注入验收样本。

设置页首选390px宽，高度随内容自然增减；主页面无可见滚动条，受限视口仍支持滚轮和键盘访问底部操作。自绘菜单长列表独立滚动。

## 当前调用关系

- 后台加载 `model-catalog.js`、`config.js`、`selection.js`、`selection-prompts.js`；只使用选区模块的无DOM分析。
- 自动内容注入：`theme.js` → `selection.js` → Marked → DOMPurify → `markdown.js` → `content.js`，样式为 `theme.css`、`content.css`。
- 设置页加载 `model-catalog.js`、`config.js`、`theme.js`、`popup.js`、`select-menu.js`，共用配置与查询逻辑。外观模块独立保存 `uiTheme`，只更新扩展根元素，默认纸本文笺；cobalt/playful/vellum分别对应纸本文笺、清浅青、冷灰蓝，三配色共用词典布局，字体本地打包。
- 全文由后台按需注入 `content-fullpage.js`，通过端口取得单条或批量结果。
- 全文工具栏桌面宽度为视口的约三分之一、水平居中，窄屏最小宽度受视口限制。下方单个 `ds-tb-toggle` 方框箭头控制 `ds-tb-panel` 整体收起/展开，按钮持续保留且焦点不变；收起内容设为inert并从辅助技术隐藏。180ms收起/浮现动画遵从减少动画偏好，任务、进度与主题继续运行。隐藏状态再次注入时只打开当前工具栏；取消移除整个入口，新启动默认展开，不保存全局偏好。

划词本地分类选择单项任务，以统一system要求和JSON材料发送一次生成。外语完整句段用翻译连接，其余解释用解释连接；“解释此句”使用解读任务。所在句及必要材料有预算，回答仍为Markdown正文。全文纯译文和批量ID协议独立。

划词输出链路为 `reader.read()` → TextDecoder/SSE → 同一次读取中相邻同类delta合并 → 最多2048字符的端口消息 → `markdown.js` 共用播放队列 → rAF/`TextNode.appendData`。后台不使用固定时间批量等待，缓存命中也立即分片交给前台播放；思考与正文交替时保留消息顺序。此消息合并同样覆盖全文单条请求，批量仍仅在done返回结构化items。

正文和思考各自每帧最多2048个UTF-16字符，按 `ceil(pending.length / 12)` 自适应追赶，帧边界尽量保留emoji代理对。当前TextNode达到8192字符后接续新节点，避免巨型节点持续重排；旧节点不重写。流式阶段使用pre-wrap显示Markdown原文，完成后保留已显示前缀、只播放剩余队列；最终文本变更已显示前缀时才重置并重新排队。正文播放完成后由Marked/DOMPurify安全排版一次，不按token或定时器反复解析全文；该最终排版仍为一次完整解析/DOM替换，不受流式2048字符上限约束。两队列都空闲后才解除加载态、显示操作按钮。关闭、重新划词或失败取消队列和完成回调，收到done后仍可取消。复制/TXT继续保留完整Markdown原文，不使用cleanMarkdown剥除语义。

设置在 `chrome.storage.local`。Key与账号模型缓存位于 `providerConnections`；`AIConfig.connectionFor`选择实际连接。custom缺地址在请求前停止，改地址清除关联型号与缓存。迁移字段属于兼容实现。

DeepSeek官方hostname精确匹配后，分别读取 `explainDeepSeekThinkingEnabled` / `translateDeepSeekThinkingEnabled`，显式发送 `thinking.enabled/disabled`。默认关闭；关闭时归一化该用途的深度思考为false、不发送 `reasoning_effort`。打开总开关后，原 `*ThinkingEnabled` 控制是否发送强度。两层开关均纳入请求缓存与配置失效判断；第三方网关不凭模型名套用。

“划词触发”仅在“解释”页的语言行显示，保存 `triggerMode: auto/contextMenu`；已有网页通过storage变化即时更新。原生选区菜单始终注册，两种模式均可点击。“全文翻译”页在目标语言下方提示：在页面空白处右键，选择「全文翻译」。

## 最低检查

每次改动至少运行：

```powershell
node scripts/verify.mjs --report artifacts/qa/static-check.json
git diff --check
```

静态工具检查JS语法、MV3基本字段、声明资源、设置页本地引用、后台字面量注入及importScripts资源、版本显示。报告记录时间、Node、HEAD、工作区及逐项结果。它不完整验证Manifest schema、界面、chrome.* API或真实供应商。

## 按影响范围选择回归

| 范围 | 工具 |
| --- | --- |
| 主题持久化、草稿隔离、页面同步、图标/字体与键盘/窄屏 | `scripts/verify-themes.mjs` |
| 划词触发方式、DeepSeek两层开关/保存/端口参数与失败反馈 | `scripts/verify-settings-controls.mjs` |
| 配置、后台、路由、SSE和失败的离线模拟 | `node scripts/verify-api.mjs` |
| 本地分类与提示词/材料构建 | `node scripts/verify-selection-prompts.mjs` |
| 选区分类离线语料 | `node scripts/verify-selection.mjs --node-only` |
| 自定义地址离线配置 | `node scripts/verify-custom-endpoint.mjs --node-only` |
| 设置持久化、消息、划词、全文与恢复 | `scripts/verify-browser.mjs` |
| 真实Range、DOM过滤、预算及路由 | `scripts/verify-selection.mjs` |
| Markdown、复制/TXT、流式与失败恢复 | `scripts/verify-markdown.mjs` |
| 定位、拖动、光标与窗口边界 | `scripts/verify-tooltip-position.mjs` |
| 焦点、下载错误、缓存和观察器 | `scripts/verify-markdown-fixes.mjs` |
| 全文Text任务、取消/重启和故障 | `scripts/verify-adversarial-browser.mjs` |
| 全文进度栏隐藏/打开、继续翻译、动态计数、键盘及主题/窄屏 | `scripts/verify-fullpage-toolbar.mjs --playwright '<已有包目录>'` |
| 换址、Key草稿、迟到响应和型号过滤 | `scripts/verify-adversarial-config.mjs` |
| 后台时序与配置读取 | `node scripts/verify-adversarial-background.mjs` |

浏览器工具需传入已有包目录：

```powershell
node scripts/verify-markdown.mjs --playwright '<已安装的 playwright 包目录>'
node scripts/verify-tooltip-position.mjs --playwright '<已安装的 playwright 包目录>'
```

传入本机实际安装的Playwright包目录，不依赖维护者的个人路径。默认使用Edge；支持 `--edge` 的工具可指定可执行文件。普通回归不要加旧源码对照参数，只有验证特定缺陷时根据工具源码中的参数说明使用 `--ref` 或 `--expect-vulnerable`。

每轮创建独立profile，使用合成页面、Key和本机HTTP/SSE，不读取日常存储。工具的外部请求拦截和profile保留方式以源码/报告为准；`verify-browser.mjs`结束自动删除本轮profile，其他工具通常保留。不得清除其他任务或用户配置。

## 功能验收要求

只覆盖本次改动影响的路径，整体发布时核对：

- 加载与设置：名称和版本正常，两个用途保存/重开保留，无浏览器错误。
- 模型与接口：列表、有效空列表、无Key/缺地址、错误缓存、换Key/地址和迟到响应。
- 划词：语言与结构、真实Range、上下文、再次解释、关闭与同文重试。
- 浮层：首次阅读位置、Markdown/键盘焦点、选区避让、顶部左键拖动与窗口约束。
- 全文：启动、滚动和动态文字、链接/图片/节点保持、原文切换、取消与重启。
- 导出：剪贴板Markdown、TXT原文/回答/名称、下载接受/完成状态和失败重试。
- 真实API：有效凭据、型号、SSE与失败处理；列表成功不能替代生成验收。

固定模拟回答不能证明语义质量、格式遵守、token账单或首字耗时。原生工具栏弹出层、原生右键鼠标操作及未覆盖网站单独记录。

## 证据与版本保存

必要的可复查摘要集中在本手册记录日期/时区、基线/待提交范围、工具版本、步骤/预期/实际、报告路径和未验证项；逐次详细记录放 `.local/materials/`，报告和截图放 `artifacts/qa/`。根目录的 `交接.md`、除本手册外的 `docs/*.md` 历史记录以及 `vendor/**/*.map` 由 `.gitignore` 排除；本机保留的旧记录可继续查阅，新克隆不包含这些文件。

主题与设置回归传入 `--playwright`，只使用隔离profile、合成Key和本机SSE。清单的 web_accessible_resources 仅公开注入界面需要的本地图标和字体，静态工具逐一检查这些资源存在。原生系统右键菜单的鼠标点击需人工补验。

生成报告默认仅本机保留。对外截图去除Key、授权头和私有网页，附来源说明；不提交凭据或storage导出。

遵循AGENTS.md：记录工作区和远程，保留已有修改，先审阅diff再按明确文件暂存。使用当前任务分支，授权内正常提交推送；核对保护与rulesets，不强推或绕过。正式发布时同步manifest/popup版本；纯改名和文档整理不单独调整版本号。

```powershell
git status --short --branch
git diff --check
git diff
# 按任务列出明确路径
git add -- README.md docs/DEVELOPMENT.md
git diff --cached --check
git diff --cached
```

GitHub同步必须核对远程提交和默认分支内容，不能把本地commit或模拟通过当作上传成功。

## 2026-10-16 PR #15与主分支文档冲突修复

从干净的codex/ui-reading-redesign@915fde6合入origin/main@fe48131，解决README三个冲突区块和本手册一个记录区块。README保留main新版首页、截图、隐私摘要和政策入口，补回当前分支的商店语言说明、模型品牌简称及解释页划词触发位置；开发记录保留两边内容。当前分支的界面、触发提示、语言资源及验证工具保持原样，PRIVACY正文与main一致，版本仍1.0.0。

Node24.18.1下56项静态检查、文档链接/图片引用检查、冲突标记扫描及git diff --check通过；对照915fde6核验运行源码、manifest和语言包无新差异，对照main核验公开截图/来源及政策正文一致。证据位于artifacts/qa/pr15-conflict-2026-10-16/。本轮只解决文档整合，未重复Edge交互或真实供应商验收；普通推送后核验GitHub PR状态。扩展代码未因本轮冲突修复改变，无需额外重新加载；此前界面更新的使用方式见对应记录。

## 2026-10-16 选择列表品牌简称

基线 `codex/ui-reading-redesign@375010b`，工作区干净，fetch后领先上游6个提交、无落后。popup.js仅在厂家选项渲染时应用品牌简称：GPT、Claude、Gemini、Qwen、Kimi、GLM、Grok、Mistral；DeepSeek、MiniMax和自定义接口沿用。两个标签的选择框及展开列表同步，目录原始厂家名称、厂家ID、连接地址、Key和模型ID不变，版本1.0.0。README、既有菜单回归和本地Description同步。

北京时间2026-10-16，Node24.18.1、隔离Edge155.0.4283.45：56项静态、7项菜单/字体回归及git diff --check通过。两标签全部11个选项的简称与原ID已核对；另以合成Anthropic配置验证三主题/两标签/三宽度18组布局、长名称省略及菜单开关，保存重开显示Claude、存储厂家仍anthropic、模型仍claude-sonnet-4-6。证据 `artifacts/qa/model-brand-labels/report.json`、`claude/report.json`、`claude/settings-390.png` 和 `artifacts/qa/static-check.json`，截图已目视复核。未调用真实供应商API或验证原生工具栏弹出层；仅本地提交，重新加载扩展并打开设置页查看。

## 2026-10-16 厂家选择框外观

再向右微调（基线 `1530051`，工作区干净）：名称由translateX(-2ch)改为-1ch，即相对上一版右移一个字符；14px/700字重沿用。Node24.18.1、隔离Edge155.0.4283.45下18组布局、两组合成长名称省略及菜单开关验证通过，56静态和git diff --check通过，390px截图已复核。证据 `artifacts/qa/manufacturer-label-right/report.json` 与同目录截图；未验证原生工具栏弹出层或真实API，版本1.0.0，仅本地提交。

后续文字微调（基线 `81ead46`，工作区干净）：厂家名称12→14px、字重700，从原居中位置左移2ch（DeepSeek实测约18px），垂直位置保留。Node24.18.1、隔离Edge155.0.4283.45下，三主题/两标签/390、320、260px共18组布局及390/260px合成长名称省略检查通过，菜单点击/Escape正常；56项静态与git diff --check通过。截图已复核，证据 `artifacts/qa/manufacturer-label/report.json` 及同目录 `settings-390.png`、`settings-320.png`、`settings-260.png`。未验证原生工具栏弹出层与真实API；仅本地提交，版本1.0.0。

基线 `codex/ui-reading-redesign@0afcd26`，起始工作区干净。仅调整popup.css：厂家框边框由1px加粗至2px、圆角10px，内部按钮圆角8px；厂家文字相对整个框水平/垂直居中，两侧等宽预留空间，右侧保留箭头，按钮覆盖框内高度。解释与全文翻译共用样式，版本仍1.0.0。

北京时间2026-10-16，Node24.18.1、隔离Edge155.0.4283.45：56项静态检查、git diff --check、7项既有下拉菜单/字体交互回归通过。以合成配置验证三主题×两个标签×390/320/260px共18组布局，2px边框和10px圆角正常，文字中心与框中心横向误差小于1px、纵向误差小于2px，箭头不遮文字且页面无横向溢出；点击打开/Escape关闭正常，无页面脚本错误。证据 `artifacts/qa/manufacturer-box/report.json`、`settings-390.png`、`settings-320.png`、`settings-260.png`、`menu/report.json` 及 `artifacts/qa/static-check.json`，390px截图已目视复核。未验证原生工具栏弹出层或真实供应商API；仅本地提交，重新加载扩展并打开设置页查看。

## 2026-10-16 全文翻译触发提示

基线 `codex/ui-reading-redesign@ab914e8`，起始工作区干净，fetch后领先上游2个提交、无落后。划词触发控件固定留在“解释”页；“全文翻译”页的目标语言下方显示“在页面空白处右键，选择「全文翻译」。”，语言区域改为单列。同步README、既有主题回归与本地Description，版本保持1.0.0。

北京时间2026-10-16，Node24.18.1、Edge155.0.4283.45：56项静态、19项主题/设置回归及git diff --check通过。隔离Edge实际加载根目录扩展，验证标签切换、划词触发草稿保留及保存/重开；390/320/260px下提示均位于目标语言下方且无横向溢出，截图已复核。证据 `artifacts/qa/fullpage-trigger-hint/report.json`、`hint.json`、`translate-390.png`、`translate-320.png`、`translate-260.png` 和 `artifacts/qa/static-check.json`。采用合成配置及本机接口，未验证真实供应商、原生工具栏弹出窗口与系统右键鼠标操作。本轮仅本地提交；重新加载扩展后重新打开设置页即可查看。

## 2026-10-16 商店中文语言资源补齐

基线 `codex/ui-reading-redesign@b8182ec`，起始工作区干净，fetch后领先上游1个提交且无落后。manifest的name、description和action.default_title改用消息引用，default_locale为zh_CN；新增 `_locales/zh_CN/messages.json` 与 `_locales/en/messages.json`，保留中英文商店元数据，界面文案沿用中文。verify.mjs增加语言目录、默认语言、消息引用与名称/简介长度检查。README与本手册同步目录说明，Description仅本地维护。

沿用草稿版本1.0.0和原包文件名 `LingoClarify-Edge-v1.0.0-20261016-212308.zip`。新ZIP为41个文件（原39个运行/第三方文件加两份messages.json），manifest位于根目录；除manifest外的原运行资源逐一与旧包清单SHA-256核对一致。新包SHA-256为 `b9a9a26e60170da6d19469bac14a5d265aa6647a2ffb63cbc9ebf5ae74fd4bbb`，验证完成后复制至桌面并更新artifacts/releases同名包。旧包备份在 `artifacts/releases/backups/store-locales-20261016/`，SHA-256仍为 `48afd28141b0f03d55d65331fcb4bc075bff1b47e5bbf0a5e7f367a0f7b11ff7`。ZIP不含开发文档、验证工具、私有文件或浏览器配置。

Node24.18.1、Edge155.0.4283.45：根目录56项静态、成品解压40项静态和git diff --check通过；隔离Edge分别以zh-CN/en-US实际加载成品，i18n与getManifest解析出对应简介，默认语言zh_CN、action标题正常，设置页v1.0.0且无pageerror。证据：`artifacts/qa/store-locales-20261016/package.json`、`browser.json`、`extracted-static.json`、中英文设置截图及桌面复制哈希记录。本轮未请求真实模型API、未上传Partner Center，也未验证后台语言识别结果；上传后应在Store listings复核简体中文条目。仅本地提交，不推送GitHub。

## 2026-10-16 Edge商店提交包（首次打包，语言资源由上节补齐）

从干净的 `codex/ui-reading-redesign@090150f` 打包当前1.0.0运行文件，未修改运行源码或版本。产物为 `artifacts/releases/LingoClarify-Edge-v1.0.0-20261016-212308.zip`，39个文件、13,947,400字节；manifest.json直接位于ZIP根目录，保留根目录JS/HTML/CSS、图标、第三方脚本、本地字体、许可证与第三方来源说明。开发文档、验证工具、Git历史、Description.md、私有材料、浏览器配置、日志和source map不进入提交包。

Node24.18.1下项目55项静态检查、解压成品39项静态检查及git diff --check通过；逐文件SHA-256确认解压内容与打包快照、当前运行文件一致。成品SHA-256为 `48afd28141b0f03d55d65331fcb4bc075bff1b47e5bbf0a5e7f367a0f7b11ff7`。清单及逐项哈希见 `artifacts/qa/LingoClarify-Edge-v1.0.0-20261016-212308/package-report.json`，解压检查见同目录 `extracted-static-check.json`。验证脚本仅在解压后加入临时验证目录，ZIP内不含该脚本。

本轮仅完成本地打包与静态完整性检查，没有重复Edge交互、真实供应商API验收，也没有上传Partner Center或确认商店审核通过。提交时直接选择此ZIP；本地预检可将其解压，在edge://extensions加载包含manifest.json的目录，再按README配置厂家、Key和模型。

## 2026-10-16 隐私政策PR冲突修复

PR #14的隐私政策分支3c4e8ce与main首页更新c0c6f3d同时改动README隐私摘要及本手册相邻记录，产生两处文档冲突。将origin/main合入codex/privacy-policy，保留main新版首页结构、公开截图与来源、首页验收记录，同时保留完整隐私摘要、PRIVACY入口及此前政策记录。相对main的最终差异仅为PRIVACY.md、README.md及本手册；运行源码、权限及1.0.0版本一致，其他分支的本地语言包和界面提交未带入。

Node24.18.1下55项静态检查、文档相对链接及图片引用、冲突标记扫描和git diff --check通过；核对PRIVACY.md与原3c4e8ce内容一致，main的公开材料和截图不变。证据保存在本工作树artifacts/qa/privacy-policy-conflict-2026-10-16/。本轮仅解决文档合并，未重复Edge交互或真实API验收，无需重新加载扩展；推送后核验远程SHA及GitHub PR可合并状态。

## 2026-10-16 隐私政策与源码核对

源码核对基线 `codex/ui-reading-redesign@b8182ec`，起始工作区干净；其运行源码与已发布的 `090150f` 一致。并行任务在原分支保存商店语言资源本地提交后，本任务以远程任务分支 `090150f` 为起点建立独立 `codex/privacy-policy` 分支，避免上传其他本地成果。新增根目录 [PRIVACY.md](../PRIVACY.md)，并同步 README 隐私摘要与入口；原工作目录的本地 Description 维护记录同步但不提交。逐项核对 manifest、配置迁移、选区采集及提示词、后台请求/缓存、全文任务、设置页模型查询、公开目录刷新、Markdown、复制和下载。政策披露默认自动划词、上下文及标题、全文持续任务、接口 Key 和 OpenRouter 目录请求、本地未额外加密的 Key、内存缓存、网页 DOM 可读性、HTTP 自定义连接和实际删除控制；不宣称完全离线、第三方零留存或已经具备独立同意弹窗。公开联系渠道使用现有 GitHub Issues，不杜撰邮箱。

本轮仅修改公开文档，不改变运行源码、权限或 1.0.0 版本，不重打已有商店 ZIP。已执行55项独立分支静态检查、56项共享工作区静态检查、50项后台API离线模拟、36项提示词检查、文档相对链接检查及git diff --check，均通过。工作期间其他任务新增商店语言资源，未纳入本次提交；以已发布基线建立独立工作树，仅加入本次三份文档进行检查，避免将共享工作区结果等同于本次交付。验证步骤、工具版本、源码条目映射与检查结果保存在 `artifacts/qa/privacy-policy-2026-10-16/`。源码与文档核对及离线模拟不代表实际网络抓包、真实供应商留存审计或商店审核通过；本轮未重复 Edge 交互或使用真实凭据。政策编写参考 [Edge 开发者政策的数据与隐私要求](https://learn.microsoft.com/en-us/legal/microsoft-edge/extensions/developer-policies#15-personal-information)，未将政策文本等同于运行时合规认证。

## 2026-10-16 GitHub首页README更新

用户明确选择更新main仓库首页。fetch确认PR #13已合入main，基线55f781d，运行文件与090150f一致；共享开发分支同时新增独立打包记录，因此使用专用工作树处理本次README，不上传对方提交。README按功能/预览/安装配置/使用/接口/隐私/常见问题/开发组织，加入1.0.0版本和纸本文笺图标、main源码ZIP入口，压缩模块说明；同步公开材料来源，两张截图从实际1.0.0扩展重新生成。扩展运行源码与版本未改。

Node24.18.1、Edge155.0.4283.45和已有Playwright1.62.1，在独立profile中打开实际设置页与合成网页，确认v1.0.0、合成Key编辑区收起、无错误提示、固定字标及Markdown操作按钮后截图，截图已视觉复核；供应商请求只转本机SSE，无真实账号验收。55项静态与git diff --check通过，README及材料说明的相对文件/图片和目录锚点全部核对，GitHub Markdown渲染预览见本轮证据。报告与预览位于本工作树 `artifacts/qa/readme-1.0.0/`，最终main SHA及远程文件核验见 `remote-verification.json`。未重跑无关API/完整交互或原生工具栏弹窗验收。Description只在原工作目录更新，不进入提交。

## 2026-10-16 版本号统一为1.0.0

用户要求将目前版本改为1.0.0。基线 `codex/ui-reading-redesign@c01877f`，工作区干净，fetch后与上游0/0；同步manifest.json、popup.html及README/本手册当前版本说明。仅调整版本标识，既有功能与配置格式沿用，历史验收记录中的旧版本保留为当时事实。Description当前版本及维护记录同步，但继续忽略、不提交。

Node24.18.1、隔离Edge155.0.4283.45及已有Playwright1.62.1实际加载根目录扩展，chrome.runtime.getManifest().version为1.0.0，设置页显示v1.0.0且无页面脚本错误；55项静态检查、git diff --check通过。证据 `artifacts/qa/version-1.0.0/browser.json`、`version.png`、`static-check.json`，最终远程SHA见同目录 `remote-verification.json`。未重复执行API、划词/全文交互或原生工具栏弹出窗口验收。更新后在edge://extensions重新加载扩展并刷新网页。

## 2026-10-16 图标同步纸本文笺配色

基线 `codex/ui-reading-redesign@919419f`，工作区干净且fetch后与上游0/0。按用户要求将 `icons/brand.svg` 的底色改为纸本文笺 `--lc-bg` 的 `#f3f0e5`、引号改为 `--lc-ink` 的 `#263d36`；保留原有路径、圆角和尺寸，用已有隔离Edge导出16/32/48/128px PNG。Manifest与工具栏、扩展管理入口继续共用这些PNG，界面品牌资源仍使用同一SVG。版本保持4.6.0。

Node24.18.1、Edge155.0.4283.45及已有Playwright1.62.1验证：SVG除两处颜色外与基线完全一致；实际解压扩展中四张PNG尺寸、Manifest两处映射、米白/墨绿像素、旧色零命中及SVG解码均通过，页面无脚本错误；实际默认主题变量与图标色值一致。55项静态检查与git diff --check通过，已目视复核128px和16/32/48px对比图。证据 `artifacts/qa/paper-icons-2026-10-16/report.json`、`comparison.png`、`static-check.json`，最终推送SHA见同目录 `remote-verification.json`。原生工具栏图标鼠标操作/系统缩放外观未验收，未重复执行无关API或流式功能回归；重新加载扩展即可更新图标。Description同步且继续仅本地，不提交。

## 2026-10-16 当前界面与帧播放更新上传验收

用户授权上传当前项目更新。基线为 `codex/ui-reading-redesign@3646c52`，开始时有9个未暂存文件；fetch后确认当前历史包含origin/main，没有远程同名分支。复用当前分支，将既有界面、字体、全文工具栏历史与工作区中的帧播放更新一起保存和推送，不改main或发布版本，版本仍为4.6.0。已核对仓库push权限、目标分支不存在及规则列表为空；Description、私有材料、生成报告不进入提交。

组合回归发现新增字标与大词条在320×240视口中占用的固定高度增加，词条不收缩使操作按钮越过浮层底边。content.css允许词条区参与flex收缩，沿用内部滚动和现有字号；verify-markdown-fixes失败断言补充实际尺寸。隔离Edge的定向复现与修复后完整25项交互、18项定位/拖动均通过，已查看极矮窗口截图确认复制/下载可见。

北京时间2026-10-16，Node24.18.1、Git2.55.0.windows.3、Edge155.0.4283.45及已有Playwright1.62.1：55项静态、50项后台离线模拟、26项Markdown/流式、25项交互、18项定位/拖动、19项主题、7项菜单/字体、11项全文工具栏、9项设置开关通过，git diff --check通过。浏览器检查使用独立profile、合成页面/Key和本机SSE，覆盖实际扩展消息与后台端口；不是有效供应商凭据验收。快照与上传核验记录留在 `artifacts/qa/github-push-2026-10-16/`，包含各套报告、compact.png及最终本地/远程SHA。未验证真实供应商生成/延迟、原生工具栏弹出窗口与系统右键鼠标操作。更新后在edge://extensions重新加载扩展并刷新网页，沿用已有厂家、Key和模型设置。

## 2026-10-16 浮层帧播放验收

北京时间2026-10-16，基线 `d680413`，起始为干净的 `codex/tooltip-header-cleanup`，fetch后比上游领先5个提交、无落后。范围：`background.js`、`markdown.js`、`content.js`、`content.css`、`scripts/verify-api.mjs`、`scripts/verify-markdown.mjs`、`scripts/verify-markdown-fixes.mjs`、README和本手册；Description同步但忽略、不提交。后台自然读取合并、缓存立即分片，正文/思考共用帧队列；正常done不重播，队列结束后一次Markdown排版并显示操作。保持4.6.0，不发布或推送。

Node v24.18.1、Edge 155.0.4283.45、已有Playwright 1.62.1，在隔离profile中加载根目录解压扩展，使用合成网页、Key和本机SSE，经真实后台端口验证。26项Markdown/流式检查、25项交互回归、17项定位/拖动检查通过；覆盖分割Markdown、安全链接/图片、复制/TXT、缓存、再次解释、故障和重试、阅读位置/键盘焦点/隐藏、拖动和视口约束。126009字符单次正文和24000字符思考测试确认完整尾部、每次append最多2048字符、正文累计append恰等于原文长度、没有清空重播、两队列结束才显示按钮；done后关闭再划词没有旧文本泄漏。超长单节点实验曾超过20秒等待上限，改为接续约8K TextNode后该验收通过；这不是供应商耗时或稳定60fps的基准。流式Markdown原文与最终排版截图已视觉复核。

后台50项离线模拟检查通过，新增同次读取合并/交替类型顺序、下一次read前已转发、跨UTF-8/JSON与无换行EOF；静态50项、diff空白检查通过。可复查证据快照在 `artifacts/qa/smooth-streaming/`，包括 `markdown.json`、`interaction.json`、`position.json`、`api-simulation.json`、`static-check.json`、流式/完成截图；详细本地记录 `.local/materials/smooth-streaming-2026-10-16.md`。浏览器与本机服务已关闭，独立profile保留。未验证真实DeepSeek或其他供应商生成、首字/总体耗时、原生工具栏及系统右键菜单鼠标操作；最终一次Markdown解析/DOM替换仍不分帧，不属于2048流式上限。

并行工作保护：过程中另一任务把共享目录切到 `codex/ui-reading-redesign`，并修改popup/主题及相应工具。本任务没有暂存或提交它们，也不切换共享目录分支；用独立临时Git索引，仅将上述范围保存为 `codex/smooth-tooltip-streaming` 的本地提交，父提交为本轮基线。根目录仍保留本任务源码变更供重新加载使用。仓库工作区因此并非干净，不能将其他修改视为本任务成果。

## 2026-10-16 全文进度栏隐藏/打开验收

北京时间2026-10-16，首版基线 `84ffd62`，完成本地提交 `1c1f242` 后按用户要求改用栏下方的单个方框箭头、取消文字入口，并将进度栏收窄为居中约三分之一。复用干净的 `codex/tooltip-header-cleanup`，fetch后当前分支比上游领先2个提交，没有落后。本次范围为 `content-fullpage.js`、`content.css`、`scripts/verify-fullpage-toolbar.mjs`、README 与本手册；本地 `Description.md` 同步维护但忽略、不提交。版本仍为4.6.0，不发布或推送。

工具为Edge 155.0.4283.45、Node v24.18.1、Playwright 1.62.1。隔离profile加载真实解压扩展，通过扩展消息启动合成网页全文翻译，真实后台端口请求本机SSE：点击栏下方方框箭头，确认整栏收起且焦点保留，只有向下箭头可见；隐藏期间等待完成并新增动态文字，再用点击/Enter/Space展开，确认最新计数、原文切换、取消恢复及新任务默认展开。再次触发隐藏的全文任务仅打开现有进度，不重新发请求。三主题及260px/390px控件边界和实际配色、1000px/1440px/1920px视口居中与精确三分之一宽度、减少动画偏好及收起控件不可聚焦均验证。11项定向检查通过；18项既有对抗浏览器回归及3项对照、50项静态与diff空白检查通过。

本版定向报告与截图为 `artifacts/qa/fullpage-toolbar-arrow/report.json` 及同目录PNG，首版历史证据保留在 `artifacts/qa/fullpage-toolbar/`。既有回归为 `artifacts/qa/adversarial-fix-2026-10-11/browser/results.json`（以报告内2026-10-16时间为准），静态报告为 `artifacts/qa/static-check.json`；详细记录在 `.local/materials/fullpage-toolbar-2026-10-16.md`。已查看展开、隐藏及窄屏截图，测试浏览器和本机服务已关闭，隔离profile保留。未验证真实供应商生成与原生右键菜单的鼠标点击；合成响应不证明模型质量或速度。

2026-10-16 箭头外观微调：基线 `21bdcf9`，用户要求缩小边框；仅将按钮32×32px改为24×20px、SVG18px改为14px，圆角4px，边框按主题减淡，阴影缩为1px/3px。同步既有验证脚本的尺寸与证据目录，真实Edge155.0.4283.45/Node24.18.1/Playwright1.62.1的11项定向检查及50项静态、diff检查通过；已查看局部、窄屏及收起截图。新证据 `artifacts/qa/fullpage-toolbar-compact/report.json`、`toolbar-detail.png`，此前证据保留。本轮仅样式微调，未重复执行上一段的18项广泛回归或真实供应商/原生右键鼠标验收；测试浏览器与服务已关闭。Description同步但不提交，版本保持4.6.0，仅本地保存。

2026-10-16 文字按钮精简：基线 `6610767`，将“显示原文/译文”和“取消翻译”按钮由最小32px高改为26px，水平内边距10→8px，显式内容宽度、禁止flex拉伸、文字水平/垂直居中，清除网页可能施加的最小宽度和缩进。既有定向工具加入合成网页button宽190px、flex拉伸及左对齐干扰，利用真实Range检查文字与按钮中心偏差，三主题均通过。Edge155.0.4283.45、Node24.18.1、Playwright1.62.1下11项定向、50静态和diff检查通过，已查看 `artifacts/qa/fullpage-toolbar-buttons/toolbar-detail.png`；报告为同目录 `report.json`。浏览器及服务已关闭；真实供应商、原生右键鼠标及18项广泛回归本轮未重复执行。仅本地提交，不推送，Description继续本地忽略。

## 2026-10-13 最小上传整理验收

基线 `16a4992`，当前任务分支与 `origin/main` 一致且工作区干净。停止跟踪27个文件：交接1份、历史任务记录24份、第三方调试source map 2份；原文件仍完整保留在本机。上传清单83→56个文件，运行源码、清单、图标、字体、第三方脚本与许可证、可复用验证工具均未修改，扩展版本保持4.6.0。

使用Node v24.18.1、Git 2.55.0.windows.3核验：本机静态49项通过；仅复制上传清单得到的独立目录静态49项通过；50个保留文件与基线Git内容一致；27个本地材料内容一致且已忽略；公开文档10个本地链接均指向上传文件；diff空白检查通过。详细本机证据为 `artifacts/qa/minimal-upload-2026-10-13/audit.json`，精简目录报告为该目录下的 `upload-snapshot-static.json`。本轮只整理跟踪范围与文档，未重新执行Edge交互或真实供应商请求；静态结果不表示这些功能已重新验收。

## 2026-10-16 三方向 UI 对比

基线为d680413，创建分支codex/ui-reading-redesign；本轮实现澄净阅读、纸本文笺、精密工具三个可切换方案。uiTheme仍使用cobalt/playful/vellum，已有配置沿用原标识；三套新外观均为浅色。设置页采用分段标签、开关控件和更清晰的字段层级，纸本方向使用宋体标题与页签，工具方向使用更紧凑的布局。theme.css统一配色、划词批注、Markdown标题和全文工具栏轮廓；popup.css负责各方向设置布局，沿用390px首选宽度、510px内部滚动及340/260px断点。本轮未改变请求或配置协议，未发布版本，仍为4.6.0。

设计参考用户提供的[Anthropic frontend-design指南](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md)，预览与设计取舍记录仅本地存于.local/materials/ui-reading-redesign/。主题与全文工具栏验证工具新增可选--output以保留各轮证据，并同步当前配色断言；公开README截图更新为默认澄净阅读的合成材料。

北京时间2026-10-16，以Edge155.0.4283.45、Node24.18.1、Playwright1.62.1完成19项主题检查、17项定位拖动检查、11项全文工具栏检查及50项静态检查；git diff --check通过。主题检查涵盖即时同步、保存重开、草稿隔离、文字对比度、本地字体、键盘、实际标签页150/200%缩放、三方向260/320/390px及自定义地址弹窗，确认高度上限与所有关键控件可滚动访问。全部使用隔离profile、合成Key及本机SSE，不代表真实模型效果。报告分别为artifacts/qa/ui-reading-redesign/report.json、artifacts/qa/tooltip-header-2026-10-13/report.json（按报告内本轮时间）、artifacts/qa/ui-reading-redesign/toolbar/report.json、artifacts/qa/static-check.json；对比截图为ui-reading-redesign/compare-settings.png及compare-results.png。

原生Edge中chrome.action.openPopup调用成功，但Computer Use无法可靠识别当前浏览器URL，按策略停止窗口截图检查；因此原生弹出层视觉尺寸、真实供应商、原生右键鼠标操作和其他浏览器仍未验证。验收浏览器与本机服务已关闭，profile保留。工作区中原有及并行产生的流式播放修改继续保留，不纳入本次UI提交；Description.md已同步、继续本地忽略。

## 2026-10-16 第二轮结构排版原型

用户反馈第一轮布局区别不足，因此在codex/ui-reading-redesign的a2e788f上新增可复用的scripts/build-ui-layout-preview.mjs，以原生HTML/CSS/JS生成三种独立结构：侧栏工作台（侧向用途导航与连接主区）、双页词典（题签、词条、边注）、阅读控制台（语言舞台与上下衔接操作区）。这些是使用示例配置的交互原型，尚未替换根目录扩展UI；不读写chrome.storage、不请求模型、不保存Key，不改变扩展版本或运行依赖。

执行 `node scripts/build-ui-layout-preview.mjs`，默认输出到`.local/materials/ui-layout-round2/`，并更新第一轮预览入口`.local/materials/ui-reading-redesign/index.html`。首次更新前将原入口保存为同目录round1.html。可用`--output <目录>`指定单独原型输出目录；固定对比入口仍会更新。独立HTML与内嵌srcdoc对比页不依赖服务器、字体下载或外部库。按钮演示用途切换、键盘左右/Home/End、思考开关、连接dialog、取消/完成与保存提示；复制/下载仅展示反馈，没有实际剪贴板或下载行为。

北京时间2026-10-16，以Node24.18.1、Edge155.0.4283.45将新生成的自包含源字符串渲染到独立空白测试页面，完成对比页切换、三套用途/键盘/开关/弹窗/保存及260/320/390px边界检查；无脚本错误或外部请求。51项静态与git diff --check通过。证据为`artifacts/qa/ui-layout-round2/report.json`、`compare-settings.png`与`compare-results.png`；本轮不是扩展集成或真实API验收，不复用上轮19/17/11项结果作为新原型证据。浏览器工具因file协议限制拒绝读取用户现有标签页，因此没有操作该标签页；用户刷新原入口即可查看新原型。详细设计说明仅本地保存，根目录运行源码、并行流式修改和上轮公开截图保持原样，Description.md同步但不提交。

## 2026-10-16 选用词典式UI并精简说明

基线9b0c32f，复用codex/ui-reading-redesign。用户选定第二轮词典布局，并要求删除“当前用途·解释”“阅读设置”、将“模型连接”改为“当前模型”。本轮将所选布局接入根目录popup.html/popup.css及共享theme.css：大字题签、页签、厂家印记、当前模型、语言/触发行、底部保存；删去宣传语、重复型号/服务说明、Key编辑提示和主题保存成功小字，保留字段可访问标签、失败反馈、DeepSeek必要提示。结果浮层沿用纸页侧边与词条标题，移除底部重复模型/品牌署名。三配色共用词典布局，cobalt默认纸本文笺、playful清浅青、vellum冷灰蓝，存储标识不迁移。

popup.js仅将共用trigger-mode控件移动到当前用途的语言行，保留同一DOM控件和值，切换标签不会重置触发方式；主题保存成功静默，失败继续提示。DeepSeek层级、Key保存、供应商/模型查询与生成协议不变。更新原型生成器中的相关文字，当前本地入口改为所选界面的实际截图，旧三方案原型保留在.local/materials/ui-layout-round2/。扩展版本保持4.6.0。

北京时间2026-10-16，在隔离Edge155.0.4283.45、Node24.18.1、Playwright1.62.1中完成19项主题/布局、9项设置与DeepSeek端口、17项定位拖动、11项全文工具栏及51项静态检查，git diff --check通过。新增断言验证指定文案精简、共用触发控件随Tab移动且保留值；覆盖无Key初始态、两用途保存重开、开关联动、主题草稿隔离、错误、自定义接口dialog、260/320/390px、150/200%实际标签页缩放。200%时长型号曾差0.6px被裁切，已在260px以下调小字号并改为底部单列；复验通过。截图已目视复核，默认已配置状态的保存按钮完整位于510px窗口内；首次配置/展开更多字段仍可内部滚动。

证据为artifacts/qa/lexicon-ui/report.json、cobalt-settings.png、cobalt-result.png、同目录toolbar/report.json，以及artifacts/qa/settings-controls-2026-10-13/report.json和artifacts/qa/tooltip-header-2026-10-13/report.json（按报告内本轮HEAD/运行信息识别）。设置工具的date字符串为旧固定日期，以本段当轮记录为准。静态报告artifacts/qa/static-check.json。全部使用合成Key、本机接口与SSE，不证明真实供应商或模型效果。未操作用户现有file标签页；原生Edge工具栏弹出层视觉与原生右键鼠标仍未验收。测试浏览器和本机服务均已关闭；并行流式修改继续保留、不纳入本次提交，Description同步且本地忽略。

## 2026-10-16 模型下拉框去除重复焦点描边

基线db49d6f，复用codex/ui-reading-redesign。用户指出厂家菜单打开时出现额外绿色框；原因是popup.css通用:focus-visible在厂家容器1px边框外再次添加2px主题色outline。本轮仅对.model-pair内的select取消outline，覆盖解释/翻译两个用途的厂家与型号控件；原有容器边框和其他按钮/输入框焦点样式保留。

北京时间2026-10-16，在隔离Edge155.0.4283.45、Node24.18.1中用合成厂家/型号验证：重加旧规则时复现2px实线，修复后三配色×两用途×厂家/型号共12种状态均无额外outline，厂家原边框仍1px；保存按钮键盘焦点仍为实线。51项静态和git diff --check通过；报告及前后局部截图为artifacts/qa/model-focus/report.json、before.png、after.png，静态报告artifacts/qa/static-check.json。未执行真实供应商或原生工具栏窗口截图，本轮不重复整套功能回归。验收浏览器已关闭；仅本地提交UI小修，并行流式修改未纳入，Description.md同步且继续本地忽略，版本4.6.0。

## 2026-10-16 自绘下拉菜单与本地设计字体

基线3a485a3，复用codex/ui-reading-redesign。按用户要求替换灰色系统下拉列表，并移除界面中宋体/黑体等系统字体的显式指定。新增select-menu.js，在popup.js之后加载：原select继续承载配置与change事件，自绘按钮负责显示，popover列表提供选中勾选、悬停、高度限制、长列表搜索、上下/Home/End/Enter/Escape/Tab和点击外部关闭；原生select不参与鼠标和Tab操作。菜单监听原选项/禁用状态变化，厂家切换、异步列表、无型号、用途切换及主题写入失败继续同步。搜索框blur/change不会触发菜单重绘，避免点击搜索结果时选项被提前移除。新增scripts/verify-select-menu.mjs，可用--playwright和--output复验。

字体改为本地霞鹜文楷屏幕阅读版v1.522处理中文、Space Grotesk处理英文正文与菜单、Syne处理英文标题；设置、结果、全文工具栏共用字体变量。新wenkai-screen.woff2保留完整字库，来源/许可/哈希及机械转换方式见vendor/fonts/README.md和wenkai-OFL.txt；仅用于网页嵌入，无CDN或系统字体安装，不新增扩展运行依赖。制作时使用的fontTools仅在.local/tmp中。压缩资源12,761,284字节，原始TTF与制作工具不纳入提交；清单只新增字体可访问资源。原型生成器的字体也同步更新，版本仍4.6.0。

北京时间2026-10-16，Edge155.0.4283.45、Node24.18.1、Playwright1.62.1隔离配置下7组菜单/字体验收通过，包括实际点击、搜索空结果和过滤选择回写、保存重开、两用途、停用/异步型号、键盘退出、三配色×260/320/390px边界、滚动关闭。CDP实际字形证据确认中文标题与结果正文由LXGW WenKai Screen自定义字体渲染，英文型号由Space Grotesk自定义字体渲染。19主题（含150/200%标签页缩放）、9设置/DeepSeek、17拖动、11全文工具栏及54静态检查、git diff --check通过，测试浏览器/本机服务均已关闭。

本轮菜单报告与截图为artifacts/qa/select-menu/report.json、manufacturer-open.png、settings.png、result.png；主题与全文工具栏报告分别为同目录themes/report.json和toolbar/report.json；设置与拖动报告沿用各工具既有路径，以本轮HEAD/内容识别，设置工具日期字符串仍是旧常量。静态报告artifacts/qa/static-check.json。所有配置/模型及SSE均为合成，不证明真实供应商或模型质量；原生工具栏窗口视觉与其他浏览器仍未验收。当前本地预览与公开截图已更新，并行流式修改继续保留，Description同步且本地忽略。

## 2026-10-16 设置页按内容自适应高度

基线823160c，复用codex/ui-reading-redesign。按用户本轮要求，popup.css移除body的510px高度上限与container的510px最小高度，设置页随当前用途、思考强度和Key编辑内容自然增减。主页面滚动条隐藏；浏览器窗口空间受限时保留根页面滚轮与键盘滚动，底部保存仍可访问。此要求替代前述历史510px内部滚动约束，下拉菜单自己的长列表滚动继续保留。版本仍4.6.0。

北京时间2026-10-16，隔离Edge155.0.4283.45、Node24.18.1、Playwright1.62.1完成19项主题/布局、9项设置与DeepSeek模拟端口、7组菜单/字体、54项静态检查及git diff --check。自适应专项在390px宽度下测得合成配置收起高512.70px、展开思考强度与Key编辑高646.48px，收起恢复原高；420px受限视口验证滚轮、聚焦保存与逐个访问底部操作，260/320/390px及150/200%标签页缩放通过。窄屏断言允许不足1px的滚动坐标舍入差；未改动按钮布局。verify-settings-controls新增--output并使用实际运行时间记录证据。

报告为artifacts/qa/popup-auto-height/themes/report.json、settings/report.json、menus/report.json；截图themes/expanded.png、themes/translate.png和settings/deepseek-off.png，公开设置截图与本地预览已更新。全部使用合成配置/凭据与本机SSE；原生工具栏弹出层的最终尺寸、真实供应商及其他浏览器未验收。原生窗口的可用尺寸由浏览器决定。重新加载扩展后重开设置生效；本轮仅本地保存，已有流式改动不纳入提交，Description继续本地忽略。

## 2026-10-16 放大输出浮层的原文与回答字号

基线aad92fc，复用codex/ui-reading-redesign。用户以词典原型为参考，指出浮层原文字号过小。本轮仅在theme.css调整排版层级：原文由13px次要提示改为32px主题墨色词条标题，正文14→18px，h2为23px、h3为20px、其余小标题18px、代码12→15px；中文继续文楷屏幕版、英文继续本地Space/Syne。原文高度上限扩至min(124px,22vh)，长句换行并可独立滚动。保持原有定位、拖动、复制/下载与请求协议，版本4.6.0。

北京时间2026-10-16，以隔离Edge155.0.4283.45、Node24.18.1、Playwright1.62.1完成18项浮层检查及54项静态检查，git diff --check通过。原有选区避让、流式拖动、滚动/缩窗位置、关闭等17项继续通过；新增专项检查三配色×260/375/1000px，覆盖长中文原文、英文词条、正文/小标题/代码实际字号、内容无横向溢出、底部按钮在窗口内、宿主网页字体保持Arial。全部使用合成网页/Key和本机SSE，未验证真实供应商、其他浏览器与特殊网站样式。

证据artifacts/qa/result-type-scale/report.json、result.png及各配色/宽度截图；公开result截图和本地预览同步更新。verify-tooltip-position新增--output以独立保存证据。重新加载扩展并刷新网页后使用；仅本地保存，本轮不纳入原有流式源码与文档改动，Description同步且继续忽略。

## 2026-10-16 输出字号微调为28/14px

基线6f7c0a7，按用户要求将词条标题设为28px、正文设为14px。工作区已有标题28px及对应断言，本轮沿用并补齐正文14px与断言；其他现有流式修改保留。版本4.6.0。18项隔离Edge浮层检查（含三配色、长句/窄屏和拖动）与54项静态检查、git diff --check通过；合成配置/本机SSE，未验证真实供应商与其他浏览器。报告及截图artifacts/qa/result-type-28-14/，公开截图和本地预览同步，重新加载扩展并刷新网页生效，仅本地保存。

## 2026-10-16 浮层品牌艺术字

基线f9a127e，按用户截图要求把顶部用途文案换为固定“说文 lingoclarify”字标。content.js首次创建双span品牌，后续普通生成/解释此句只更新region可访问名称以保留用途信息，不覆盖品牌子节点。theme.css用本地文楷26px/3px字距呈现中文书写感、Syne 600/11px呈现英文，按基线对齐；保留拖动抓手与关闭按钮，词条28px和正文14px沿用。无新资源/依赖，版本4.6.0。

北京时间2026-10-16，隔离Edge155.0.4283.45、Node24.18.1、Playwright1.62.1完成18项浮层、18项浏览器行为回归及3项对照、54项静态检查，git diff --check通过。覆盖固定品牌/字体、三配色×260/375/1000px下与关闭按钮无重叠、拖动/关闭、解释此句成功与失败后品牌稳定及用途可访问名称保留；截图已目视复核。证据artifacts/qa/result-wordmark/report.json、header.png、result.png和artifacts/qa/adversarial-fix-2026-10-11/browser/results.json（以本轮报告时间/HEAD识别）。使用合成网页/Key与本机SSE，未验证真实供应商或其他浏览器。公开截图和本地预览已更新；重新加载扩展并刷新网页生效。已有流式源码/文档差异保留，只提交本任务差异，Description继续本地忽略。

## 2026-10-16 英文字标改为连笔手写字体并预留笔画空间

基线104f916，按用户要求将浮层英文字标从Syne 600/11px换成本地Allura 400/24px连笔手写体，行高1.65并增加上下/左右留白，字标仍为说文 lingoclarify；中文、28px词条和14px正文保留。新增vendor/fonts/allura.ttf与allura-OFL.txt，来源/取得日期/哈希见字体README；theme.js注册LC Allura，manifest公开字体资源，不新增运行依赖或远程字体请求，版本4.6.0。

北京时间2026-10-16，隔离Edge155.0.4283.45、Node24.18.1、Playwright1.62.1完成18项浮层检查与55项静态检查，git diff --check通过。CDP实际字形确认Allura-Regular自定义字体；lingoclarify实测墨迹高24px、下伸笔画9px、行高39.6px，文字框底部距header底部12px；截图目视确认g/y下伸完整。覆盖三配色×260/375/1000px、长句、正文/词条原字号、关闭按钮无重叠与定位/拖动。证据artifacts/qa/result-calligraphy/report.json、header.png、result.png及各宽度截图。全部使用合成网页/Key与本机SSE，未验证其他浏览器或特殊宿主样式。公开截图/预览和本地Description同步；重新加载扩展并刷新网页生效，仅保存本任务本地提交，原有流式修改保留。

## 2026-10-25 模型列表不可用时保留已保存型号

基线 `main@b80405f`。问题：设置页在厂家模型列表查询失败时把型号下拉框渲染成空选项，点击“保存设置”会直接把当前用途的 `explainModel` / `translateModel` 写成空字符串；后台随后在发请求前返回“请先选择模型并保存设置”。换 Key 时也会先清空型号，若新列表查询失败或设置页提前关闭，旧型号无法恢复。

本轮修复：
- `popup.js`：列表查询失败且当前用途仍指向已保存厂家时，下拉框继续显示并保存已保存型号；接口成功返回（含合法空列表，`modelsCheckedAt` 已更新）时以接口结果为准。换 Key 不再预先清空型号，等新列表成功返回后由既有逻辑纠正；custom 地址变更仍立即清空型号并同步内存快照。保存其它设置时不再覆盖已有型号；两个用途都无型号时在保存提示中注明。
- `background.js`：空模型错误按用途提示「解释」或「全文翻译」标签。
- `scripts/verify-settings-controls.mjs`：新增“列表不可用时保存”和“换 Key 后列表失败”两项回归；在未修复的 `main@b80405f` 上确认第一项以空型号失败。
- `scripts/verify-browser.mjs`：把顶部错误颜色断言更新为当前 1.0.0 主题的 `--lc-error: #b42318`（`rgb(180, 35, 24)`）。

北京时间2026-10-25，Node 24.18.0、Edge 155.0.4283.45、playwright-core 1.62.1（隔离profile、合成Key/本机SSE）下：56项静态、11项设置（含新增2项）、5项对抗配置、23项浏览器回归通过，`git diff --check`通过。`scripts/verify-custom-endpoint.mjs --node-only` 在未修改的 main 上因 VM 未加载 `AISelectionPrompts` 失败，与本修复无关，未处理。未验证真实供应商生成、原生工具栏弹出层与系统右键鼠标操作；扩展版本保持1.0.0。
