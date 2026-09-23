# ST 预设转 RisuAI：Kemini 复盘与工作台改造方案

日期：2026-09-13

状态：**源码核查与设计方案；本文件不代表工作台已完成下述改造，也不代表已通过用户实际客户端端到端测试。**

## 1. 结论与适用范围

转换目标应改为：**尽量保持默认行为、保留可选内容、明确不可映射语义，并使每次损失都可追溯。** 不再笼统承诺“功能无损”。

文件可导入只证明容器可读；字段在 schema 中存在只证明有存放位置；开关可点击不等于默认状态、变量副作用和最终请求内容正确。

本次有三个不同层次，必须区分：

| 层次 | 当前状态 |
|---|---|
| 工作台通用转换器 | 支持选顺序块、普通提示词、部分参数、禁用项开关、基础正则；仍存在本文件列出的转换缺陷 |
| Kemini 专项产物 | 做过变量重放、字段合并、历史拆分、正则阶段等额外处理；这些处理尚未全部进入工作台 |
| 通用可靠转换方案 | 需要中间表示、目标版本能力表、变量语义分析、默认请求预览和客户端验证；这是本次建议的修改方向 |

此次只核查源码、转换报告和文件，不读取实际项目数据库、不修改线上 RisuAI、不启停 8787。旧文档中的远程部署信息不作为本次“当前已验证”的证据。

## 2. 核查基线

### 2.1 输入与专项输出

样例：`Kemini_Aether-fr-4.3.json`，732,898 字节。原文件 SHA-256：

`39d9d8c50c596c3178fd776cd38dfca7fda3808381b7ecbce54ff8f077dce800`

| 项目 | 数量/处理 |
|---|---|
| prompts 定义 | 99 |
| prompt_order | 1 块，85 个引用，其中 39 个 enabled=true |
| 未引用定义 | 14；不能直接全部启用 |
| 非空普通提示词 | 85；另有 1 个非空 SPreset 插件配置条目 |
| 专项输出模板 | 90 项；源定义数与目标模板数不能直接相除当成功率 |
| 专项输出开关 | 56，主要对应停用项/库条目；并非所有源开关的等价复现 |
| 变量操作 | 53 处 setvar，42 处 getvar 已做专项处理 |
| 正则定义 | 18，14 启用、4 禁用；专项输出 16 条执行规则 |
| 插件扩展 | SPreset、regex_scripts、tavern_helper；不能视为普通提示词正文 |

专项产物验证了封装回读、基础正则编译、条目覆盖与原文件哈希；**没有验证所有开关组合、真实最终请求和界面按钮**。报告中的“非空文本保留”属于条目/存档覆盖证据，不是逐个运行路径等价证明。

### 2.2 RisuAI 源码基线

官方上游提交：`cad8595aa39620df4246f56918f0962c2aa0263a`。本次将之前读取的 parser、cbs、database、process、scripts 与该提交逐一比较，内容一致。

- [预设 schema、导入和选用逻辑](https://github.com/kwaroran/RisuAI/blob/cad8595aa39620df4246f56918f0962c2aa0263a/src/ts/storage/database.svelte.ts)
- [提示词项类型](https://github.com/kwaroran/RisuAI/blob/cad8595aa39620df4246f56918f0962c2aa0263a/src/ts/process/prompt.ts)
- [请求构建、字段合并与历史处理](https://github.com/kwaroran/RisuAI/blob/cad8595aa39620df4246f56918f0962c2aa0263a/src/ts/process/index.svelte.ts)
- [CBS 宏实现](https://github.com/kwaroran/RisuAI/blob/cad8595aa39620df4246f56918f0962c2aa0263a/src/ts/cbs.ts)
- [CBS 解析器与临时变量作用域](https://github.com/kwaroran/RisuAI/blob/cad8595aa39620df4246f56918f0962c2aa0263a/src/ts/parser/parser.svelte.ts)
- [聊天/全局变量读取](https://github.com/kwaroran/RisuAI/blob/cad8595aa39620df4246f56918f0962c2aa0263a/src/ts/parser/chatVar.svelte.ts)
- [开关声明解析](https://github.com/kwaroran/RisuAI/blob/cad8595aa39620df4246f56918f0962c2aa0263a/src/ts/util.ts)
- [开关、下拉、输入框界面](https://github.com/kwaroran/RisuAI/blob/cad8595aa39620df4246f56918f0962c2aa0263a/src/lib/SideBars/Toggles.svelte)
- [正则处理阶段](https://github.com/kwaroran/RisuAI/blob/cad8595aa39620df4246f56918f0962c2aa0263a/src/ts/process/scripts.ts)

ST 正则语义另核查了 [官方 regex engine](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions/regex/engine.js) 的 `getRegexedString`；这是 release 分支快照，后续接入回归夹具时须固定其提交。

本地 `temp/risu-cur/` 的部分旧源码也包含相同的默认 runVar=false、人物字段合并与示例历史逻辑；它只能交叉印证机制，不能代替用户实际版本核验。

## 3. 没有同名字段时，应如何转换

必须逐项作出以下决定，不可用“无对应字段”统一带过：

| 结果状态 | 定义 | 示例 |
|---|---|---|
| direct | 字段和运行语义均可直接映射 | 普通文本到 plain.text |
| transformed | 经明确变换后映射 | assistant → bot、温度比例转换 |
| covered | 内容由目标内建槽位提供，不能再插入一次 | 人物性格/场景由 description 提供 |
| conditional | 依赖目标版本、供应商或运行上下文 | 深度条件、模型推理参数 |
| archived | 原值完整保留，但不会执行 | 酒馆插件配置、禁用的不可表达规则 |
| unsupported | 缺少实现路径，当前不能承诺相同行为 | 酒馆 DOM 按钮和插件 API |
| empty | 没有文本；仅保留结构元数据 | 空分隔条目 |

`archived` 不能计入“执行兼容”；`covered` 不能显示成“内容丢弃”。未知字段也必须纳入清单，不能只有固定的 UNMAPPED_FIELDS 白名单。

### 3.1 提示词和内建槽位

| ST 内容 | RisuAI 方案 | 注意事项 |
|---|---|---|
| 普通启用 prompt | plain，保留角色、顺序和正文 | system/user/bot；未知角色须报告，不能无声猜测 |
| main/jailbreak/nsfw 的启用正文 | plain；仅使用已验证的 subtype | 不借用可能受全局开关控制的 jailbreak/cot 类型，以免原本启用的正文消失 |
| charDescription | description | 上游还会合并 personality、scenario 和额外角色信息 |
| charPersonality/scenario | 优先 covered，依靠 description | 不再额外插入同样的宏，否则重复；源顺序分离能力因此可能降级 |
| personaDescription | persona | 不把当前某个用户的人设固定进通用预设 |
| dialogueExamples | 依靠原生历史里的示例 | **不能再生成 rangeStart=-1000 的完整 chat 槽**，会重复历史 |
| chatHistory | chat | 与对话示例、新对话标记及历史裁剪一起验证 |
| worldInfoBefore/After | lorebook 并记录位置差异 | 内容入口可覆盖，不代表 before/after 位置完全相同；不可机械插两个完整世界书槽 |
| injection_position/depth/order | 进入显式注入计划 | 普通序列顺序不能代替深度注入；短历史、多深度、同深度顺序都需验证 |
| 空占位/分隔标题 | empty 元数据 | 可以用于工作台分组，不应新增空模型消息 |
| SPresetSettings 等插件配置 | archived + 插件识别结果 | 不能因它位于 prompts 数组就门控成一个巨大的模型提示词 |

特殊情况：如果源块故意关闭 description 却启用 personality，或只要示例不要聊天历史，不能直接标记 covered。需要独立宏/ChatML 等专门映射或明确降级，保证“被覆盖”的承载槽确实启用。

### 3.2 参数和缺省值

| 源字段 | 建议目标 | 处理原则 |
|---|---|---|
| temperature | temperature × 100 | 保存原值、目标值及转换公式 |
| frequency_penalty | frequencyPenalty × 100 | 对照目标供应商最终请求验证 |
| presence_penalty | PresensePenalty | 现代码照搬上游 ST importer 的 ×0.7×100；这不是普遍的 API 等价公式，必须作为明确规则并验证最终请求 |
| top_p/top_k/min_p/top_a/repetition_penalty | 同名或目标参数字段 | schema 接受不代表每个模型支持；值域、0 的语义与未设置不同 |
| openai_max_context/openai_max_tokens | maxContext/maxResponse | 区分客户端截断与模型输出上限 |
| assistant_prefill | prefill_supported 条件及相应尾部位置 | 不支持时的行为要在预览中可见 |
| reasoning_effort/show_thoughts | 目标能力表解析 | 当前 RisuAI 有 reasonEffort 等字段，但枚举/供应商意义不同；不能复制字符串或统一宣称“没有字段” |
| stream_openai | 按目标导入/选用能力判断 | 不猜字段名；不覆盖连接层配置 |
| 续写/代写、空输入、群聊、新聊天提示 | 对应工作流能力或存档 | 没有“只在续写时”的触发点，不能转换成每次都发送的 plain |
| 函数调用、搜索、图片请求、图片质量 | 供应商和运行能力配置 | 留存原值，明确需用户在目标应用配置的项目 |
| 未知顶层字段/扩展字段 | 记录 JSON 路径并存档 | 防止新增源字段悄悄丢失 |

RisuAI 导入会将 payload 覆盖到 presetTemplate 上，随后选用预设还会设置部分默认值。因此**省略字段不等于保持用户当前设置**。工作台应显示“源值 → 输出值 → 导入/选用后的缺省行为”，模型、API Key、地址等连接配置不从普通内容预设自动携带。

## 4. 开关：不能只做一个 key=name

### 4.1 已确认的原生能力

当前目标源码支持这些声明形态（声明只是 UI，不自动门控正文）：

```text
feature=启用某功能
style=写作风格=select=简练,细腻,强主观
custom=补充要求=textarea
section=高级选项=group
section_end=高级选项结束=groupEnd
```

下拉状态保存的是选项下标字符串（如 `0`、`1`），不是显示标签。正文条件应按实际下标比较。标签里的换行、`=`，选项里的逗号需要转义策略或拒绝输入，不能随意拼接。

普通开关状态通过 `toggle_<key>` 读取。该状态可能来自聊天局部覆盖，也可能来自全局变量。未设置时宏底层可能返回 `null` 字符串，UI 将其显示为空；不能假定始终是空串。

`templateDefaultVariables` 用于普通聊天变量的默认值，不是全局开关状态初始化表。不能仅写入它就宣称原生开关默认值已设置成功。

### 4.2 工作台应保存的控制模型

每项保存：稳定 ID、原始 identifier、显示标签、控件类型、默认值、开关动作（启用/停用）、选项值、互斥组、作用条目、定义位置、当前方案版本。

建议 key 以项目稳定的导入身份 + prompt.identifier + control purpose 的哈希构成；不要使用 prompt.index 或可编辑名称作为主身份。相同项目改名/重新排序不变；独立预设不要因都叫 st_3 而互相继承状态。哈希只使用非敏感元数据。

### 4.3 默认启用与互斥问题

当前工作台只把“默认关闭”条目变成开关，启用条目是常驻文本；这不是完整复现 ST 的可开关体验。

在不修改 RisuAI 的前提下，优先采用能让界面状态与运行行为一致的策略：

1. 默认关闭项：原生“启用 X”开关，未设置即关闭。
2. 默认启用项：短期可使用“停用 X”开关，未设置即保持启用。不要让 UI 显示关而正文偷偷按默认开执行。
3. 已证实有默认状态初始化机制的目标版本，可使用正向开关，但必须验证首次导入、切换预设和重新导入。
4. 明确互斥的风格/人称使用 select；没有证据的选项先由用户在工作台确认分组，不能仅凭名称相似自动合并。
5. select 的未设置状态也需定义，并验证 UI 是否显示相同默认选项；不能仅在模型宏里兜底。
6. 库条目允许保留开关，但如果变量定义排在消费者之后，应警告“打开也不会影响之前的提示词”，提供插入位置设置。

内建 typed 槽没有 text 载体，不能随手套文本条件。它的开关需要针对该类型的适配；不支持就明确说明，而不是改成一块重复历史。

## 5. 变量：改造的最高优先级

### 5.1 已确认的差异

RisuAI 普通 promptTemplate 文本调用解析器时，默认 runVar=false。setvar 写入受 runVar 控制，而 getvar 读取聊天持久变量。临时变量属于单次解析调用；把所有 setvar 改成 settempvar 并跨槽读取，同样不可靠。

当前通用转换器没有做这一层语义转换；已有“删除 setvar 定义”的编辑检查只能发现局部删改，并不能证明导出的变量会正常运行。

### 5.2 Kemini 专项方案的边界

上次通过“每个槽位重放前面的定义 + 临时变量”补齐跨槽依赖。这是针对样例的候选适配，不可直接推广为通用实现：

- 同一条目中先 get 后 set 的顺序，不能被“所有赋值提前”改变。
- 含 random/roll/time 的赋值重复重放，会改变求值次数；相同变量的两次读取未必保留同一个值。
- 持久聊天状态不能变成每次请求清空的临时状态。
- 嵌套条件、注释、转义、变量值里的宏必须按解析结构处理，正则计数不足以覆盖。
- 门控了显示文本不等于门控副作用；必须测试关闭分支是否仍执行内部赋值。
- 应记录重复前缀体积和解析成本，不能只统计发送 token。

### 5.3 推荐的通用策略

建立按源位置排列的宏 AST/事件流，包含读、写、条件、非确定性调用、持久状态意图；不要把最终生成的巨型宏串当作唯一真相。

按能力选择：

| 类型 | 实现策略 |
|---|---|
| 纯文本常量赋值、静态顺序 | 保持时序的常量传播/引用展开；保留 source map |
| 受开关控制的纯常量 | 编译为显式条件值，检查互斥与无默认分支 |
| 当前角色/用户等动态只读宏 | 保留经能力表确认的原生宏 |
| 持久变量、随机/时间、副作用、循环 | 不做无声降级；保持源存档并标记需模块适配或专门运行时 |
| 可证明正确的临时变量重放子集 | 作为有条件的编译后端，必须通过求值次数和顺序测试 |

“更少功能但结果明确”和“高级适配模式”应显式区分。用户选择继续导出只确认该项差异，不等于取消所有结构校验。

## 6. 正则：阶段、范围和执行环境

当前 `StRegexScript` 读取时已丢掉 markdownOnly、promptOnly、minDepth、maxDepth、runOnEdit、substituteRegex 等信息，后续再补字段也无法还原，应从中间表示入口修起。

| ST 条件 | RisuAI 候选处理 | 验证要求 |
|---|---|---|
| markdownOnly | editdisplay | 只影响显示，不修改持久聊天记录或发给模型的正文 |
| promptOnly | editprocess | 只影响请求，不应改变界面显示 |
| 两者同时启用 | 分别产生对应阶段规则 | 原 ST 引擎按两条条件之一满足即可运行，不是 AND 条件 |
| 两者都关闭 | 根据 placement 选择 editinput/editoutput | 核对何时持久化、编辑消息是否重复执行 |
| placement 1/2 | user/char 作用范围 | 不能仅靠 mode 推断角色；需要真实上下文验证 |
| minDepth/maxDepth | 深度范围适配 | `lastmessageid-chatindex` 只是候选映射，不能无条件认定等价 |
| runOnEdit=false | 条件支持或标记差异 | 不能每次重绘都执行具有破坏性的替换 |
| substituteRegex | 宏替换策略 | 区分原样、宏展开和转义；不是一律打开 CBS |
| disabled=true | 保持不执行并存档 | 只有找到经过验证的原生关闭机制才发出可执行目标规则 |
| HTML/CSS 替换 | 对比实际渲染 | 浏览器展示与请求文本需要分别比较 |
| JS/父窗口/酒馆输入框调用 | 插件能力识别，通常 archived/unsupported | 保留脚本文本不等于按钮可运行；不自动执行 |

正则基础 new RegExp 成功只证明语法合法。测试还要覆盖消息索引 -1、首条消息、追加消息、历史裁剪、输入输出角色、短历史、修改旧消息、缓存是否失效。

## 7. 工作台具体修改点

### 7.1 建议的数据流水线

```text
导入原文件并保留哈希
  → 完整解析源字段与扩展
  → 中间表示（条目、顺序、变量、控件、正则、未知字段）
  → 选择目标版本能力与转换策略
  → 生成映射计划及差异清单
  → 人工修改源内容/控制策略，重新分析
  → 预览默认及选定开关状态下的请求
  → 审阅具体兼容差异
  → 固定源稿/策略/能力版本，确定性生成 risup 与附件
```

延续现有“预设纯转换工作区”，不强行塞进角色卡扫描/翻译流程。保存和导出不临时调用模型创造内容，也不擅自补开关或重排字段。

### 7.2 代码边界

| 位置 | 建议修改 |
|---|---|
| `server/domain/card/st-preset-convert.ts` | 修正内建槽位重复映射；使用完整 IR、能力表和 source map；逐步拆小 |
| 新增 `server/domain/preset/` | source-schema、target-capabilities、prompt-plan、macro-compiler、toggle-plan、regex-plan、conversion-report 等纯逻辑 |
| `server/domain/card/risup.ts` | 保持纯容器编解码；增加基于固定版本真实样本的导入/导出兼容测试 |
| `server/domain/card/st-preset-edit.ts` | 变量依赖从扫描字符串改为读写事件；沿用原文编辑和回滚；结构/策略编辑走单独类型化操作 |
| 新增 `server/application/preset/` | 编排分析、保存策略、预览、审阅及导出包；注入数据库、时钟、文件存储 |
| `server/routes/api.ts` | 只校验请求和调用服务；不要继续堆大段转换事务 |
| `server/application/export/export-service.ts` | 预设分支调用统一服务，校验计划版本；与 CLI 使用同一内核 |
| `src/features/preset/model/types.ts` | 增加能力基线、字段决策、控件、变量问题、运行验证状态、revision |
| `src/features/preset/model/usePresetProject.ts` | 保存后重取最新分析；预览/导出结果必须绑定同一 revision |
| `PresetWorkspace/ConversionPanel/PromptList` | 从单纯“条目数/丢弃数”升级为内容、控件、兼容差异、请求预览四个视图 |
| `scripts/convert-st-preset.ts` | 复用同一配置与报告；支持生成完整包，不只可选 report.json |

建议保存独立 `conversion_plan_json` 与 `conversion_plan_version`（或同等独立配置表），原 ST JSON 与人工编辑稿继续分开；不要把转换策略写进真实源字段。

每个问题至少包含：`code`、`sourcePath`、`targetPath`、`status`、`reason`、`proposedAction`、`runtimeVerified`、`sourceHash`。审核结论绑定源稿+策略+目标能力哈希；文字、开关顺序或目标版本改变后，相关旧结论失效。

### 7.3 界面应呈现什么

- 概要同时显示：源定义、非空正文、已转换、由内建覆盖、仅存档、未支持；不以目标条目数冒充覆盖率。
- 源字段详情显示“原字段 → 目标字段/内建能力 → 变换 → 差异 → 保存位置”。
- 开关页展示原始默认值、目标控件、条件、互斥组、稳定 key 和实际作用项；key 是高级信息，不塞满普通操作流程。
- 变量页允许定位定义、读取和条件分支，展示删除/重排会影响哪些消费者。
- 正则页用同一组 user/bot 消息对比“显示、发送、持久数据”三种结果。
- 预览页展示消息角色、顺序、展开后的文本、空消息和重复槽位，不只显示原模板字符串。
- 兼容差异要逐项可查看。可存档导出不应一律阻止；声称等价的导出不能悄悄含未验证的关键运行项。
- 支持下载完整保留包，并明确“附件保留但不执行”。

## 8. 导出包与覆盖证明

建议固定输出：

```text
preset.risup
preset.decoded.json
conversion-report.json
source-manifest.json
original/source.json
preserved/unknown-fields.json
preserved/plugins.json
preserved/disabled-regex.json
README.md
```

不得把 ST 原文件顶层 prompts/prompt_order 随意嵌进 RisuAI payload；目标 importer 可能再次按 ST 路径处理。原始内容以附件保存，不能依赖目标应用保留未知字段再导出。

报告单独列出三种覆盖：正文存储覆盖、默认执行覆盖、可选分支验证覆盖。每个源 JSON 路径必须有去向：转到目标、由内建提供、保存在附件、空值或未支持。保存原始字节与哈希是保底，不代替执行验证。

## 9. 修改优先级与验收

### P0：先解决会改变默认行为的问题

1. 修复对话示例重复历史及人物字段“假丢弃”。
2. 完整保留正则元数据，拆分显示/发送阶段；未覆盖的语义明确标注。
3. 检出 setvar/getvar、插件配置和不受支持宏，停止无声直通；先支持经证明安全的变量子集。
4. 开关键稳定且跨预设隔离，修正“默认关闭”措辞。
5. 通用报告和页面移除未经验证的“功能无损”结论；CLI 与网页输出一致。

验收：用合成 fixture 重现 Kemini 中的结构特征，失败必须出具体问题，不以“可解包”冒充运行成功。

### P1：开关与可审查计划

加入完整控件模型、互斥选择、未知字段存档、按策略编辑、默认请求预览、计划哈希和保留包。用户能清楚判断丢失的是正文、位置、状态还是插件功能。

### P2：固定目标客户端的运行验收

使用隔离、临时端口的兼容测试环境和合成卡片，拦截/捕获模型请求，不使用真实 API Key 或发送真实私密内容。固定目标源码提交或已验证的构建身份。

必测矩阵：

| 链路 | 必测案例 |
|---|---|
| 容器 | encode/decode 回读、真实导入、选用后再导出 |
| 默认值 | 首次导入、已有全局同名值、聊天局部覆盖、切换/重导入预设 |
| 控件 | 默认开/关、双向切换、重命名、重排、互斥组、select 下标变化 |
| 变量 | 先读后写、多次赋值、跨槽、关闭分支副作用、随机只求值一次、持久变量 |
| 槽位 | description/scenario 重复、示例重复、仅示例无历史、空消息、世界书位置 |
| 注入 | 0/1/2 深度、短历史、多注入同深度、历史截断 |
| 正则 | 显示与发送隔离、角色、编辑重放、深度边界、未知上下文、缓存 |
| 插件 | 脚本不误发给模型、不可用按钮明确提示、附件还原 |
| 保存导出 | 幂等、失败不覆盖旧稿、旧计划并发修改返回冲突、不临时再生成内容 |

只有通过相应矩阵的能力可以标记 runtimeVerified=true。合成 fixture 入库，真实 Kemini 全文不应自动进入公开测试仓库。

## 10. 对旧方案的修订意见

`ST预设转RisuAI方案.md` 中以下结论不能继续无条件使用：

- “功能无损可以做到”：改为按能力和路径验证，不作整体承诺。
- “最高风险只是开关包装的空白”：变量、作用域、默认状态和正则阶段至少同等重要。
- “有 toggle 声明 + 条件宏就等价”：缺少全局状态隔离、默认开与互斥验证。
- “RisuAI 没有 personality/scenario 槽所以丢弃”：应分清独立槽位缺失与原生内容合并。
- “dialogueExamples → 完整 chat”：会重复，应按原生示例处理。
- “转换完全不需要目标适配”：普通内容可只产出数据；插件 DOM 和持久副作用需要单独评估，不能强行装进 risup。

`ST预设转换界面方案.md` 的“纯转换、允许人工编辑、逐项目处理”可以保留，但需要加入控件/兼容差异/实际请求预览，不能把当前界面已实现理解为本方案所列语义已实现。

## 11. 本次交付边界

本次交付是复盘和可落地改造方案，并对旧文档加上修订入口；没有将 Kemini 专项脚本直接替换为工作台通用转换器，也没有修改已交付的预设文件。

最先应做 P0，先让工作台正确识别和说明问题，再逐步提供可靠的控件与变量编译能力。


## 2026-09-14：P0 实施记录

本轮已落地转换器、页面报告、CLI 和导出服务。真实 RisuAI 导入后的请求捕获仍属于 P2，当前未做运行等价承诺。

- 对话示例由启用的 chat 承载，不再再插入整段历史；场景、性格由 description 承载。无承载块时使用字段宏并记录格式降级，世界书前后合并差异也明确列出。
- 修复 `preserveOptionalPrompts=false` 将禁用提示词变成常驻的错误。禁用或未引用的内容只能门控或存档。
- 开关键使用原始源文件内容摘要与 identifier 摘要，页面编辑或重排不改变身份。不同源预设隔离；重新导入同源预设会复用已保存状态，页面已说明。
- 正则区分 editdisplay/editprocess 与输入输出阶段，按角色条件限制，未知上下文不匹配。无标志规则使用仅增加匹配索引的 d，避免目标默认 g/u 改变匹配次数或 Unicode 语义；HTML 末尾增加 no_end_nl 避免自动多出换行。
- 深度、编辑时机、trimStrings、动态替换及混合未支持 placement 仍需迁移，不擅自扩大范围。禁用正则仅存档。
- 仅静态展开顺序明确、无条件、无嵌套宏、先定义后读取的字面量 setvar/getvar。可选分支、随机赋值、跨状态语义不自动改写；源内容保留供迁移。此子集不保留变量供聊天外部脚本读取。
- SPresetSettings 不再发送给模型，插件配置存档。未验证宏、深度注入、无效正则或缺失引用提供路径与原因。
- 报告增加 schemaVersion、目标源码版本、covered、archived、issues 和开关命名空间；未知顶层、扩展及提示词元数据列入未映射清单。
- 页面与 CLI 共用转换器，CLI 与 HTTP 共用产物生成逻辑。标准 .risup 不写入包含运行错误的预览；完整存档始终包含原始 ST、编辑后 ST、报告和预览 JSON；无运行错误时才额外包含 .risup。
- 网页增加完整存档下载；CLI 总是写报告和 ZIP，失败退出码为 1，已有 .risup 不覆盖。源 JSON 按结构完整保留，归档不是原文件字节级备份。

P1 的互斥选择控件、完整变量编译、编辑时机/深度精确转换和请求预览尚未完成。P2 的真实客户端导入及请求对比尚未验证。


本轮验证：全量 `npm test` 294 项通过；`npm run build`（三组 TypeScript 检查、Vite 与服务端编译）通过。新增转换与 CLI 回归、导出服务的拒绝/存档/修正后成功路径，确认不改动原始或草稿持久数据。未启停 8787，未执行真实 RisuAI 客户端测试。

使用 Kemini 源文件只读核对：89 个目标条目、4 个原生承载项、1 个插件存档项、56 个可选开关；检测出 42 处状态变量问题、1 处深度注入与 1 处未验证宏。18 条源正则均有跳过原因，包含禁用规则和暂未迁移的编辑/深度语义。本轮通用转换器仍不能将该复杂预设判定为可运行等价转换；此前一次性定制转换文件没有被本轮覆盖。
