# 预设类 HTML 的翻译与转换实现方案

> 面向 **卡片翻译工作台**：导入/翻译 RisuAI 预设（以及 ST 预设转换出的 RisuAI 预设）时，
> 如何处理注入到消息里的 **HTML/CSS** 块。
>
> 相关文档：`ST预设转RisuAI方案.md`（整体转换）、`ST预设转换界面方案.md`（界面）、
> `ST预设转RisuAI兼容性复盘与改造方案.md`（兼容性复盘）。
> 本文只讲**HTML 注入块**这一条线，结论全部在真实 RisuAI 实例上验证过。

---

## 一、为什么这类内容必须专门处理

预设里的 HTML 不是"普通文本"，它同时是**渲染载体**和**可翻译内容**：

| 组成 | 该不该翻译 | 翻错会怎样 |
| --- | --- | --- |
| CSS 里的颜色、尺寸 | ❌ | 面板变样 |
| CSS 里的选择器（类名） | ❌ | 样式全部失效 |
| 可见文字（标题、按钮标签、提示语） | ✅ | 这是唯一该翻的部分 |
| `$1`…`$n` 回填占位符 | ❌ | 内容丢失 |
| 属性名、`data-*` 值、`risu-style` 十六进制 | ❌ | 结构损坏 |

而这类文本有个工作台里其它内容都不具备的特性：**它会被 RisuAI 二次加工**。
RisuAI 渲染消息时会跑一条固定管线：

```
parseThoughtsAndTools()   <Thoughts> → <details>
encodeStyle()             <style> → <risu-style>十六进制
markdown-it               html:true / breaks:true / code 规则被 disable
DOMPurify.sanitize()      class 加 x-risu- 前缀；剥 script / on* / iframe
decodeStyle()             十六进制还原；class 选择器加 x-risu-；统一加 .chattext 作用域
```

于是产生四条硬约束，**翻译与转换都必须在这四条之内工作**：

| # | 约束 | 后果 |
| --- | --- | --- |
| A | 消息内**不执行 JS**，`<script>` / `onclick` 被剥掉 | 折叠、点击、自动高度全失效 |
| B | `<style>` 必须写成 `<risu-style>hex</risu-style>` | 否则被 markdown 吃掉 |
| C | **不要**自己写 `x-risu-` 前缀与 `.chattext` 作用域；`body`/`html` 选择器无效 | 二次加前缀 → `.x-risu-x-risu-*`，样式全失效 |
| D | 消息内 Lua 触发器（`onButtonClick`）**白名单没有 DOM** | 只能改聊天记录，够不到输入框 |

**约束 D 与插件版本的关系**（✅ 已核实纠正）：
"消息内 JS 无效"与"插件能不能拿到 DOM"是两件事。
桥接插件用 **API 2.1**（主上下文执行，`checkCodeSafety()` 把 `document` 重写成 `safeDocument`）。
**2026-09-22 源码复核纠正：v3.0 不能无损替代当前桥接器。** `getRootDocument()` 需 `mainDom`
权限，但返回的是 V3 自己的受限包装，不是 V2 的 SafeDocument。V3 缺少 `elementFromPoint()`、
输入框 value setter、`dispatchEvent()` 和 `click()`；事件对象也没有 target。
`sendChat(message)` 可经授权直接发送明确文本，但不能复刻“仅填入输入框”等行为。
本项目目前保留 API 2.1。完整核对与新版导入兼容补丁见上级目录
`risuai-patches/2026-09-22-plugin-v21-import.md`。

---

## 二、通用归属矩阵：哪些直用、哪些要转换、哪些必须桥接

不是某一个预设的问题。下面按**能力类别**列，覆盖酒馆侧预设/卡会用到的主要动态机制。

判定分四档：

| 档位 | 含义 |
| --- | --- |
| **直用** | 两边语义一致，原样搬运即可 |
| **需转换** | 能做，但要改写法（转换器可自动完成） |
| **需桥接** | 机制上做不到，必须由页面级插件执行 |
| **无法实现** | 两边都没有对应能力，只能降级或改设计 |

### 2.1 提示词 / 文本层

| 类别 | 酒馆里的写法 | 归属 | 说明 |
| --- | --- | --- | --- |
| 宏替换 | `{{macro}}` | **直用** | RisuAI 有 **163 个 CBS 宏**（已从部署产物枚举） |
| 变量读取 | `{{getvar}}` `{{getglobalvar}}` `{{tempvar}}` | **直用** | `cbs.ts:793/862/754` |
| 临时变量写入 | `{{settempvar::}}` | **直用** | 同一轮解析内有效 |
| 持久变量写入 | `{{setvar::}}` | **直用但不生效** | ⚠️ 见下方陷阱 2 |
| 条件块 | `{{#when::…}}…{{:else}}…{{/when}}` | **直用** | 运算符齐备：`equal/notequal/less/lessequal/greater/greaterequal/and/or/not` |
| 随机与骰子 | `{{random}}` `{{roll}}` `{{pick}}` | **直用** | 均原生 |
| 消息引用 | `{{lastMessage}}` | **直用** | `{{lastmessage}}` / `{{lastmessageid}}` |
| 聊天深度过滤 | `{{lastMessageId}}` 比较 | **直用** | 用 `{{chatindex}}` + `{{calc}}` 表达"最近 N 条" |
| 斜杠指令 | `/send` `/setvar` `/trigger` `/inject` | **无法实现** | 消息内不执行 STscript |
| 扩展专用宏 | 第三方扩展注册的宏 | **无法实现** | RisuAI 无扩展机制 |

⚠️ **两个易踩的语义差异**：

1. `{{#when::X}}` **只在 X 等于 `true` 或 `1`** 时为真
   （`parser.svelte.ts`：`isTruthy = (s) => s === 'true' || s === '1'`）。
   门控变量必须是这两种取值之一，否则整段内容不进提示词。
2. `{{setvar::}}` 只在引擎上下文 `runVar` 为真时执行
   （`cbs.ts:832`：`if(matcherArg.runVar){…} return null`），而
   **`runVar` 默认 false**（`parser.svelte.ts:1618`：`runVar: arg.runVar ?? false`），
   事件显示管线里的 `risuChatParser` 调用都不传它。
   → **单条消息内的临时状态用 `settempvar`；跨消息持久状态必须靠 Lua 触发器 `setChatVar`（或插件）。**

### 2.2 HTML / CSS 显示层

| 类别 | 酒馆里的写法 | 归属 | 说明 |
| --- | --- | --- | --- |
| 基础排版 | `<div>` `<span>` 内联 `style` | **直用** | |
| 样式表 | `<style>` | **需转换** | → `<risu-style>hex</risu-style>`，否则被 markdown 吃掉 |
| CSS 选择器 | `.class` | **需转换** | 不要自加 `x-risu-` 前缀、不要写 `.chattext`；`body`/`html`/`id` 选择器会被丢弃 |
| 响应式 | `@media` | **需转换** | RisuAI 进 `@media` 后不给内部选择器加前缀 → 规则静默失效，需展开 |
| 折叠面板 | `<details>/<summary>` | **直用** | 原生可用 |
| 折叠面板 | JS 切换 class | **需转换** | 改写成 `<details>`（靠内联 handler 识别） |
| 代码块 | ` ```html ` 围栏 | **需转换** | RisuAI 把围栏渲染成 `<pre><code>`；面向 RisuAI 必须去围栏 |
| 外链资源 | `<link>` CDN | **需转换/降级** | 被剥掉 |
| 外链图片 | `<img src="http…">` | **直用/降级** | 受 `hideAllImages` 设置影响 |
| 图标字体 | FontAwesome 等 | **降级** | 无 CDN 样式表 → 图标不可见，需换内联 SVG 或文字 |
| SVG | 内联 `<svg>`（含 `mask`/`filter`） | **直用** | 已验证 `viewBox`/`radialGradient`/`feGaussianBlur` 大小写保留正确 |
| 动画 | `@keyframes` | **直用** | `decodeStyle` 不碰 `@keyframes` 内部 |

### 2.3 交互层（桥接的核心地带）

| 类别 | 酒馆里的写法 | 归属 | 说明 |
| --- | --- | --- | --- |
| 消息内 JS | `<script>` | **需桥接** | RisuAI 结构性禁止，无替代 |
| 内联事件 | `onclick="…"` | **需桥接/需转换** | 被剥离；折叠 → 改 `<details>`；要执行动作 → 桥接 |
| 写聊天输入框 | `querySelector('#send_textarea')` | **需桥接** | 消息内与 Lua 都够不到，只有页面级插件能写 |
| 触发发送 | 点 `#send_butt` | **需桥接** | 同上 |
| 改聊天记录 | `getContext().chat[i].mes = …` | **需转换** | 改用 Lua 触发器 `setChat`/`insertChat`（**不需要插件**） |
| 触发界面刷新 | 点 `.mes_edit_done` | **需转换** | 改用 Lua `reloadChat`/`reloadDisplay` |
| 与宿主通信 | `window.parent.postMessage` | **无法实现** | 没有宿主可通信 |
| 按元素查询 | `getElementById` / `querySelector` | **需桥接** | 插件里用 `safeDocument`（2.1）或 `getRootDocument()`（3.0） |
| 绑定事件 | `addEventListener` | **需桥接** | 消息内无法绑 |
| 自适应高度 | `postMessage({type:'resizeIframe'})` | **无法实现** | 消息与页面同文档，无需自适应 |
| 弹窗 / 询问 | 扩展 API | **部分可用** | Lua 触发器有 `alertInput`/`alertSelect`/`alertConfirm` |
| 剪贴板 | `navigator.clipboard` | **需桥接** | 插件可做（`copy` 动作） |
| 定时 / 轮询 | `setInterval` | **需桥接** | 插件可做，但跨消息编排脆弱 |
| 交互按钮 | QuickReply + `/send` | **需桥接** | 仅当从酒馆导入时。RisuAI 原生做法是 `{{button::文字::触发器}}` 或 `risu-btn` + 卡级 Lua 触发器，**不需要插件**（实测 24 张卡用 `risu-trigger`、9 张用 `risu-btn`） |

### 2.4 正则层

| 类别 | 酒馆里的写法 | 归属 | 说明 |
| --- | --- | --- | --- |
| 替换占位符 | `$1` `$&` `$<name>` | **直用** | 语义一致 |
| 处理阶段 | placement 1 / 2 | **直用** | 映射为 `editinput` / `editoutput` |
| 显示阶段 | "仅格式化显示" | **直用** | 映射为 `editdisplay` |
| 请求阶段 | "仅格式化提示" | **直用** | 映射为 `editprocess` |
| 深度过滤 | `minDepth` / `maxDepth` | **需转换** | RisuAI 无对应字段；用 `{{chatindex}}` + `{{#when}}` 在模式内表达 |
| 编辑时执行 | `runOnEdit` | **无法实现** | 没有编辑时机 |
| 宏替换开关 | `substituteRegex` | **无法实现** | RisuAI 用 flag `<cbs>`，语义不同 |
| 禁用状态 | `disabled` | **需转换** | RisuAI 正则无启用开关 → 只能跳过并报告 |
| 其他 placement | 3 / 4（斜杠命令、世界书） | **无法实现** | 无对应阶段 |
| 换行处理 | `trimStrings` | **需转换** | 用 flag `<no_end_nl>` 处理末尾多换行 |

### 2.5 卡与角色层

| 类别 | 归属 | 说明 |
| --- | --- | --- |
| 卡内资源标记 `<img="name">` | **直用** | RisuAI 原生（`additionalAssets`） |
| 场景标记 `<ssscene>` / `<ssnpc>` | **直用** | 纯文本契约，原样保留 |
| 世界书 / Lorebook | **直用** | RisuAI 原生 lorebook 与激活机制 |
| 卡级正则 `customscript` | **直用** | 会被执行 |
| 卡级触发器 `triggerscript` | **直用** | 原生触发器；Lua 触发器还能改聊天记录 |
| 卡级 HTML / JS | **取决于来源** | RisuAI 原生卡：直用（实测 89 张卡 0 张含 ST 式脚本）。**从酒馆导入的卡**才需转换/桥接，同 2.2 / 2.3 |
| 组队聊天 | **需注意** | Lua 触发器按钮在群聊不触发；卡为 `simple` 类型时也不触发 `onButtonClick` |

### 2.6 一句话结论

| 能力 | 归属 |
| --- | --- |
| **文本 · 宏 · 变量 · 条件 · 随机** | 直用（注意 `setvar` 的 `runVar` 守卫与 `#when` 的真值判定） |
| **HTML 显示** | 需转换（`risu-style` / 不自加前缀 / 展开 `@media` / 去围栏 / `<details>`） |
| **正则替换** | 直用（阶段与占位符语义一致；深度过滤需改写） |
| **写输入框 · 触发发送 · DOM 查询 · 事件绑定 · 剪贴板** | **需桥接** |
| **改聊天记录 · 刷新界面** | 需转换：交给 Lua 触发器（**不需要插件**） |
| **宿主通信 · STscript · 扩展宏** | 无法实现，只能降级 |

**因此"要不要桥接"的判据只有一条**：

> 该功能是否需要**在消息内部与页面 UI 交互**（写输入框、点按钮、查 DOM、读页面状态）。
> 是 → 桥接；否 → 转换或直用即可。

### 2.7 工作台可识别的特征清单

扫描阶段按下列特征打标，即可自动分类：

| 特征（出现在 `out` / 卡脚本里） | 判定 |
| --- | --- |
| `send_textarea`、`#send_butt`、`window.parent`、`window.top` | **需桥接**（写输入框 / 触发发送） |
| `<script`、`onclick=`、`on*` 事件属性 | 需桥接或需转换（折叠类可转 `<details>`） |
| `SillyTavern.getContext`、`chat[`、`.mes`、`mes_edit` | 需转换（改用 Lua 改记录） |
| `postMessage`、`resizeIframe` | 无法实现（放弃自适应） |
| `<style>` / `@media` / ` ```html ` 围栏 | 需转换 |
| `minDepth` `maxDepth` `runOnEdit` `substituteRegex` `trimStrings` | 需转换或无法实现（进报告） |
| `{{setvar::}}` | 直用但**不生效** → 提示改用 `settempvar` 或 Lua |
| `{{#when::{{getglobalvar::toggle_*}}}}` | 直用，但需校验开关初值为 `1`/`true` |
| `{{random` `{{roll` `{{pick` `{{getvar` `{{getglobalvar` `{{tempvar` | 直用 |
| 不在 163 个 CBS 名单内的 `{{xxx::}}` | 无法实现（需报告） |

### 2.8 实测样本的归属（供校核）

以 `Kemini_Aether-fr-4.3`（16 条正则 / 90 条提示词）验证上表：

| 归属 | 条数 | 条目 |
| --- | --- | --- |
| **需桥接** | **2 / 16** | `regex[12]` 行动选项（写输入框）、`regex[15]` 润色2（写输入框） |
| 需转换后直用 | 1 / 16 | `regex[1]` Aether 折叠（`toggleCollapsible`+`postMessage` → `<details>`+`risu-style`） |
| 直用 | 13 / 16 | 纯文本替换 / 清空内容 / 调整块顺序 |
| 提示词侧 | 90 条全直用 | 宏 6000+ 处全部命中 CBS 名单 |
| 卡侧 | 全直用 | `<img="…">` / `<ssscene>` 为 RisuAI 原生 |

两条需桥接的本质是同一件事：**把文本放进聊天输入框（并按需发送）**。

---

## 三、HTML 块在工作台流程里的位置

```
导入（json / risup / risum）
   └─ 扫描：识别可翻译单元
        ├─ 提示词文本            ← 常规翻译
        ├─ 正则规则的 in / out    ← ⚠️ 本文对象
        └─ 卡的 firstMessage / 世界书 / 资源
   └─ 转换：ST 预设 → RisuAI 预设（st-preset-convert.ts）
   └─ 审核：逐条确认
   └─ 应用 / 导出：写出 .risup（risup.ts，AES-GCM + RPack）
```

**关键判断：正则 `out` 是不是翻译目标？**

- `out` 里的 **HTML 结构、CSS、`$n`、`risu-style` 十六进制** → **不是**翻译目标，必须保护
- `out` 里的 **可见文字**（如按钮标签"收起"、面板标题"Aether"、提示语） → **是**翻译目标
- 正则 `in` 里的中文（如 `<行动选项>`、`选项1`）→ **不是**翻译目标，它是匹配模式，
  翻译会让规则再也匹配不上

⚠️ **实测提醒**：`<行动选项>` 这类标签是**模型输出契约**。若把 `in` 里的标签名翻成法文，
规则立即失效，按钮不再出现。这类标签必须列入**保护规则**。

---

## 四、三个必须知道的翻译风险（都实际踩过）

### 风险 1：把模型输出放进 HTML 属性 → 引号截断 ⚠️ 最严重

**现象**：属性值在引号处被截断，UI 上看不出问题。

```html
<!-- 模板 -->
<button data-risu-value="$1">$1</button>

<!-- 模型输出（弯引号） -->
1:【指着上面的定金额度，“就它了”】

<!-- 实际渲染：属性在直角引号处终止 -->
<button data-risu-value="【指着上面的定金额度，" >【指着上面的定金额度，“就它了”】</button>
```

**成因链**（三步缺一不可）：

1. RisuAI 渲染前会执行 `data.replace(/[“”]/g, '"')`，把弯引号转成 ASCII 直角引号
2. `$1` 是**运行时**回填，模板侧无法预转义（写 `&quot;` 也没用）
3. 属性值里出现 `"` → 属性当场终止

**对工作台的要求**：

- 转换时**不要把 `$n` 放进 HTML 属性**。内容放元素文本，属性只放固定的动作名
- 审核界面应能标出"属性里含 `$n`"的可疑条目
- 这类问题在翻译前后都不会报错，**只能靠结构检查发现**

### 风险 2：翻译 `$n` 或 `$<name>` 占位符

`$1`、`$&`、`$<name>` 是 RisuAI 的替换占位符。若翻译模型把它当成普通文本改写
（例如把 `$1` 变成 `$ 1`、或翻成"第一个选项"），回填即失效，注入内容全部丢失。

**对工作台的要求**：`out` 字段必须整段保护，只允许翻译明确标记的可见文字片段。

### 风险 3：`out` 里的代码围栏

ST 预设习惯把 HTML 包在 ```` ```html ```` 围栏里（ST 会把围栏当 HTML 渲染）。
RisuAI 侧围栏会被当成**代码块**，整块面板变成 `<pre><code class="hljs">` 里的源码。

**对工作台的要求**：转换 RisuAI 目标时**去掉围栏**（转换器 `--no-fence`）。
若原样保留，导出后的预设渲染结果就是"能看见桥接属性、但显示成代码"。

---

## 五、工作台的保护规则（建议默认集）

以下内容在 `out` / `in` 中被扫描到时应整段保护、不进入翻译队列：

| 类别 | 匹配特征 |
| --- | --- |
| `risu-style` 块 | `<risu-style>[\s\S]*?</risu-style>`（十六进制，绝不能动） |
| `style` 块 | `<style>[\s\S]*?</style>` |
| 脚本块 | `<script[\s\S]*?</script>`（转换阶段应已删除） |
| 标签与属性 | `<[^>]+>`（保留标签名与属性名） |
| 回填占位符 | `\$[0-9]+`、`\$\&`、`\$<[^>]+>` |
| 契约标签 | 用户可配置清单，例如 `<行动选项>`、`</行动选项>`、`<think>`、`<disclaimer>`、`<ssscene>`、`<img="…">` |
| 桥接属性 | `data-risu-bridge="…"`、`data-risu-value="…"` |
| CSS 数值与选择器 | `#rgb`/`rgba()`、`\d+(px\|em\|rem\|%)`、类名与伪类 |

**可翻译的白名单**（在保护之外单独抽取）：

- CSS/HTML 中的**文本节点**内容
- 属性值为**人类可读文案**的：`title`、`alt`、`placeholder`，以及 `data-risu-value`（若未含 `$n`）
- 自闭合元素之间的文字

抽取实现可复用现有 `extractVisibleText()` 的判定思路：只取
`{{button::}}`、HTML 属性值、`>文字<` 三类**可见文字**，并要求不含 `<`/`>`。

---

## 六、转换实现

### 6.1 已有产物

| 文件 | 作用 |
| --- | --- |
| `server/domain/card/st-html-to-risu.ts` | ST HTML → RisuAI HTML 转换器，产出**逐项转换报告** |
| `server/domain/card/risu-style.ts` | `risu-style` 十六进制编解码（对应 RisuAI `encodeStyle`/`decodeStyle`） |
| `scripts/convert-preset-html.ts` | 批量转换预设正则里的 HTML 块 |
| `scripts/encode-risup.ts` | 预设 JSON → `.risup` 容器 |
| `scripts/risu-render-check.mjs` | 复刻 RisuAI 渲染管线的本地校验脚本 |
| `tests/st-html-to-risu.test.ts` | 转换器回归测试（14 项） |

### 6.2 转换器做了什么

```
1. 解析片段（自带 HTML 解析器，容忍裸 <、未闭合标签；SVG 标签/属性保留大小写）
2. 收集 <style> → 转 <risu-style>十六进制
3. 删除 <script> / on* / <meta> / <link> / <title>，展开 html/head/body 壳
4. body 选择器改写到片段根元素（加 risu-html-scope 类）
5. 点击展开的面板改写成 <details>/<summary>（靠内联 onclick 识别）
6. 展开 @media（RisuAI 不加前缀，留在断点里会失效）
7. 剥掉块元素之间的空白（markdown `breaks:true` 会把换行变成 <br>）
8. 按钮改写为桥接声明（--bridge）
```

每一步都会写进**转换报告**（`removed` / `rewritten` / `note` 三级），审核界面应当展示。

### 6.3 命令

```bash
# 转换 + 打包
npx tsx scripts/convert-preset-html.ts <输入.risup> tmp/out/new.risup --bridge --no-fence
npx tsx scripts/encode-risup.ts tmp/out/new.risup.preset.json tmp/out/new.risup

# 本地校验渲染（真实 markdown-it + DOMPurify 复刻）
node scripts/risu-render-check.mjs tmp/out/new.risup.regex-12-*.html tmp/render
```

| 参数 | 作用 |
| --- | --- |
| `--bridge` | 按钮改写成 `data-risu-bridge` 声明，由桥接插件执行（唯一能写输入框的路径） |
| `--no-fence` | 去掉 ```html 围栏。**面向 RisuAI 时必须加** |

---

## 七、人机分工：哪些必须人工复核

| 类别 | 自动 | 人工 | 理由 |
| --- | --- | --- | --- |
| 保护规则命中 | ✅ | — | 确定性规则 |
| `<style>` → `<risu-style>` | ✅ | — | 纯搬运 |
| 删脚本 / 改 `body` 选择器 / 展开 `@media` | ✅ | — | 纯搬运 |
| 可见文字翻译 | ✅（模型） | ✅ 必审 | 需要判断"是不是可见文字" |
| `<details>` 改写 | ✅ | ✅ 必审 | 依赖内联 handler 启发式，形状不同会漏 |
| 按钮 → 桥接声明 | ✅ | ✅ 必审 | 需确认动作语义（`fill` 还是 `fill-send`） |
| 桥接插件是否存在 | — | ✅ 必查 | 插件没装 → 按钮点了没反应 |

**报告里出现 `note` 级条目时必须在界面提示**，例如"内消息不执行 JavaScript，
折叠/自动高度已用纯 HTML/CSS 替代"——这是行为变化，不是等价转换。

---

## 八、验证清单（工作台侧）

| 验证 | 手段 | 通过标准 |
| --- | --- | --- |
| 转换器单元测试 | `npm test`（`st-html-to-risu.test.ts`） | 14 项全过 |
| 渲染管线 | `risu-render-check.mjs` | `<script>`/`onclick` 为 0；无未加前缀的 CSS 规则；桥接属性存活 |
| 打包完整性 | `decodeRisuPreset` 回读 | 提示词/正则/开关数量不变；**非正则字段零差异** |
| 残留扫描 | 正则遍历 `out` | 无 `<style>` / `<script>` / `onclick` / 文档壳 / 裸围栏 |
| 翻译未破坏结构 | 比对翻译前后 `$n` 集合、属性名集合、`risu-style` 长度 | 完全一致 |
| 真实实例 | 导入后看 DevTools + Console | 面板正常渲染；`[risu-bridge] 已挂载` |

⚠️ **本地复刻不能替代真实环境验证**。本次出现过"本地复刻渲染正常、真实环境仍是旧行为"，
原因是**客户端内存未刷新**（见第 9 节），不是转换错误。

---

## 九、端到端操作顺序（工作台 → 用户）

```
1. 工作台导入预设 → 扫描 → 翻译（HTML 块整段保护，只翻可见文字）
2. 工作台审核 → 应用 → 导出 .risup
3. 用户在 RisuAI 里【完全关闭页面】
4. 用户导入 .risup（或由工作台直写库——必须在页面关闭状态下）
5. 用户重新打开页面
6. 验证：新消息的面板渲染 + 按钮行为（历史消息不会自动更新）
```

**第 3、5 步不能省**，原因见下一节。

---

## 十、⚠️ 时序铁律：外部改库必须发生在客户端重载之后

RisuAI 的数据库是**启动时整份读入内存、保存时整份写回**，没有字段级并发保护。

> **任何"直接改 `database.bin`"的操作，都必须发生在客户端重新加载之后。**
> 否则用户一保存，整份旧内存就把修改覆盖掉。

本次实测踩了两遍：

| 操作 | 结果 |
| --- | --- |
| 写入插件修复（5419B）+ 新增预设 | 用户一次保存后，插件退回 5230B，新预设消失 |
| 改名 + 删除 3 条中间版本 | 再次被回退到 8 条、名字复原 |

**正确顺序**：关闭页面 → 重开（内存 = 磁盘）→ 服务端写入 → **立即回读校验** → 用户重载使用。

工作台若提供"直接写入 RisuAI 实例"的能力，必须在写前检查并提示用户关闭页面。

---

## 十一、故障排查表

| 现象 | 定位 |
| --- | --- |
| 整块被当代码显示 | `out` 里还有 ```html 围栏 → `--no-fence` |
| 面板正常但点了没反应 | 桥接插件未加载：F12 看有无 `[risu-bridge] 已挂载`；没有则重载页面 |
| 发送内容只有前半段 | 内容放在了 HTML 属性里被引号截断（风险 1） |
| 输入框有字但发出去是空的 | 插件未派发 `input` 事件（需原型 setter + `input`/`change`） |
| 样式全失效 | CSS 自己加了 `x-risu-` 前缀 → 去掉 |
| 翻译后规则不再匹配 | `in` 里的契约标签被翻译了（第二节警告） |
| 改了没生效 / 被回退 | 客户端内存未刷新（第九节） |
| 历史消息不更新 | 历史消息存的是当时的渲染结果；编辑保存该条才会按当前预设重绘 |

---

## 十二、能力边界（明确做不到的）

| 目标 | 能否 | 说明 |
| --- | --- | --- |
| 写聊天输入框 | ✅ | 需桥接插件（API 2.1） |
| 触发发送 | ✅ | 同上；建议默认只 `fill`，把发送权留给用户 |
| 改聊天记录 | ✅ | Lua 触发器 `setChat`，或插件直接调状态 |
| 消息内执行 JS | ❌ | RisuAI 结构性禁止 |
| 模型输出放进 HTML 属性传递 | ❌ | 运行时回填无法转义（风险 1） |
| 自动多轮对话 | ⚠️ | 需状态机编排，脆弱 |

---

## 十三、RisuAI 渲染管线参考（实现依据）

代码位置（按部署产物 sourcemap 还原，与线上 sha256 一致）：

- `src/ts/parser/parser.svelte.ts` — `ParseMarkdown` / `encodeStyle` / `decodeStyle` / `trimMarkdown`
- `src/ts/process/scripts.ts` — 正则执行：`risuChatParser(data.replace(reg, outScript), { chatID })`
- `src/ts/plugins/pluginSafeClass.ts` — 插件侧 `SafeDocument`（真实 DOM 的受限包装）
- `src/ts/plugins/pluginSafety.ts` — 插件代码 AST 重写（`document` → `safeDocument`）
- `src/lib/ChatScreens/DefaultChatScreen.svelte` — 输入框/发送键的真实选择器来源

`decodeStyleRule()` 的关键行为（决定了 CSS 该怎么写）：

```js
// 每个 class 加 x-risu- 前缀，然后统一加 .chattext 作用域
rule.selectors[i] = '.chattext ' + prefixed(selector)
// @media 内部递归处理，但不会加前缀 → 断点里的规则会失效
```

---

## 十四、相关产物索引

| 文件 | 作用 |
| --- | --- |
| `server/domain/card/preset-capability.ts` | **能力归属模块**：判定每条规则在 RisuAI 里是直用 / 需转换 / 需桥接 / 无法实现 |
| `tests/preset-capability.test.ts` | 归属判定的回归测试（21 项） |
| `docs/预设注入HTML与桥接插件-通用方案.md` | 通用方案原文（含桥接插件接口契约与安装） |
| `bridge-plugin/risu-bridge.plugin.js` | 桥接插件（API 2.1，纯转发执行器） |
| `bridge-plugin/install-risu-v2-plugin.cjs` | API 2.1 插件安装器 |
| `bridge-plugin/update-risu-plugin.cjs` | 只更新插件正文（保留 enabled 与参数） |
| `bridge-plugin/add-risu-preset.cjs` | 追加预设（不覆盖同名） |
| `bridge-plugin/tidy-risu-presets.cjs` | 预设改名 / 删除 |
| `bridge-plugin/probe-preset-out.cjs` | 探测 `out` 的围栏与桥接属性 |
| `bridge-plugin/export-risu-chat.cjs` | 导出某角色的 chat 存档 |
| `bridge-plugin/list-risu-chars.cjs` / `find-risu-entry.cjs` / `search-risu-remotes.cjs` | 定位角色与存储条目 |
| `scripts/convert-preset-html.ts` | HTML 块批量转换（`--bridge` / `--no-fence`） |
| `scripts/encode-risup.ts` | 预设 JSON → `.risup` |
| `scripts/risu-render-check.mjs` | 渲染管线复刻校验 |
| `tests/st-html-to-risu.test.ts` | 转换器回归测试 |

---

## 十五、实现进度（工作台侧）

已完成：

- [x] 能力归属模块 `server/domain/card/preset-capability.ts`
      （纯逻辑：`classifyCapability` / `analyzePresetCapabilities` / `summarizeCapabilities` /
      `declaredBridgeActions` / `presetCapabilityNotices`）
- [x] 接入预设项目视图：`PresetProjectView.capabilities`
      （逐条正则归属 + 汇总 + 开关门控 + 未知宏 + `usesSetvar` + `notices`）
- [x] 审核界面渲染 `PresetConversionPanel`：
      - 预设级警示（需桥接条数 / 开关真值 / `setvar` / 未知宏）
      - **"需要桥接插件的规则"默认展开**，列出规则与动作，并说明未装插件时点了没反应
      - "其他转换说明"折叠列出 convert / impossible 级发现
- [x] 回归测试 `tests/preset-capability.test.ts`（24 项）

待办：

- [ ] 导出前结构校验：`$n` 集合、属性名集合、`risu-style` 长度在翻译前后一致
- [ ] 增加"面向 RisuAI"开关，默认启用 `--no-fence`（目前是转换脚本参数）
- [ ] 若提供直写 RisuAI 实例的能力：写前强制检查用户已关闭页面，写后立即回读校验

### 15.2 桥接只发生在「跨平台」时，卡侧不需要

容易误解的一点，用实测数据说清。**桥接需求来自"酒馆的东西搬进 RisuAI"，不来自"翻译"。**

对线上实例的 89 张卡扫描脚本字段（`customscript` / `triggerscript` / `backgroundHTML`）：

| 检测项 | 命中卡数 |
| --- | --- |
| `send_textarea` | 0 |
| `window.parent` / `window.top` | 0 |
| `postMessage` / `resizeIframe` | 0 |
| `SillyTavern` / `#send_butt` / `toggleCollapsible` | 0 |
| （疑似 `getContext` 1 张，核实为卡自己的 Lua 函数名 `getContextString`，误报） | — |

卡里实际使用的都是 **RisuAI 原生机制**：`risu-trigger`（24 张）、`risu-btn`（9 张）、`x-risu-` 类名（3 张）。

| | 脚本来源 | 里面写的是 | 翻译后是否需桥接 |
| --- | --- | --- | --- |
| **RisuAI 的卡** | 作者面向 RisuAI | `risu-btn` / Lua 触发器 | **不需要** —— 不跨平台，机制本来就是 RisuAI 的 |
| **ST 预设的正则 `out`** | 作者面向酒馆 iframe | `#send_textarea` / `window.parent` / `<script>` | **需要** —— 跨了平台，原机制在 RisuAI 不存在 |

**推论**：能力归属判定只对"从酒馆迁入"的内容有意义。RisuAI 原生卡即使脚本里出现
ST 式写法（实测为 0 张），那也不是翻译引入的问题，而是该卡本身在 RisuAI 里就是坏的。

因此卡侧**不需要**接入归属判定；2.7 的特征清单与 `analyzePresetCapabilities`
服务的对象就是预设正则与需要迁移的 ST 内容。



### 15.1 模块输出示例（实测预设）

对 `Kemini_Aether-fr-4.3` 的转换结果运行 `analyzePresetCapabilities`：

```
  #   归属        桥接动作      名称
  0  direct      —             Aether思维链转义标签
 …  direct      —             （略，共 14 条）
 12  bridge      fill-send     (二选一)s15行动选项（输入框）（紫金版）
 15  bridge      fill-send     润色2

汇总: {"direct":14,"convert":0,"bridge":2,"impossible":0}
开关门控数: 56   未知宏: 无   usesSetvar: false
```

与人工逐条判定（2.8 节）完全一致。两条 `bridge` 正是需要桥接插件的规则。

界面上的呈现（`PresetConversionPanel`）：

```
⚠ 有 2 条规则需要桥接插件：未安装时这些按钮点了没反应，不会报错。
  56 个开关门控用 {{#when::{{getglobalvar::…}}}} 判断，该宏只把 "1" / "true"
  当作真值；开关初值必须是这两者之一，否则门控内容不会进入提示词。

▾ 🔌 需要桥接插件的规则 2 条（未安装时点了没反应）
    regex[12] (二选一)s15行动选项（输入框）（紫金版）：动作 fill-send
    regex[15] 润色2：动作 fill-send
    这些规则把点击动作交给页面级插件执行（写聊天输入框、触发发送）……
```

