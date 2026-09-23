# ST 预设项目专用转换界面方案

> 2026-09-13 修订：请结合 [兼容性复盘与工作台改造方案](./ST预设转RisuAI兼容性复盘与改造方案.md) 阅读。旧文中的“功能无损”及能力映射结论不能代替变量、开关和正则的运行验证；新方案明确区分已实现、专项适配与待验证事项。

> **状态：已实现。** 实现记录见 §11。

目标：导入 SillyTavern 预设 JSON 后，工作台**切换到一套只做转换的操作界面**，不再显示翻译流程（扫描/翻译/审核/术语库/协议/脚本管理）。

前置文档：`docs/ST预设转RisuAI方案.md`（转换内核）、`risuai-patches/2026-09-12-deployed-build-verification.md`（部署核查与验证证据）。

---

## 1. 已确认的产品决策

| 决策 | 选择 |
|---|---|
| 预设项目定位 | **纯转换**，隐藏全部翻译标签页 |
| 提示词清单 | **允许直接编辑原文**（不做翻译，只做人工微调） |
| 批量导入 | **逐个处理**，与现有单项目工作区一致 |

---

## 2. 实测结论：转换不需要扫描

在临时端口上验证：导入 ST 预设后**不扫描、直接导出即成功**（`status=new`，导出 95,698 字节的合法 `.risup`）。

因此转换的最短路径是 **导入 → （可选编辑）→ 导出**，与 `status` 状态机、`segments` 表、翻译任务全部无关。

这一点决定了界面形态：预设项目**不进入** `GuidedWorkflow` 的五步流程。

---

## 3. 检测与分流

**检测不需要新逻辑。** 导入时后端已写入 `sourceFormat: 'st-preset'`，前端 `ProjectSummary.sourceFormat` / `ProjectDetail.sourceFormat` 已带该字段。

分流点选在 `ProjectWorkspace.tsx`（41 行，职责就是组装工作区）：

```
WorkbenchPage.tsx (571 行，状态编排，不动)
  └─ ProjectWorkspace.tsx            ← 唯一分流点
       ├─ sourceFormat === 'st-preset' → <PresetWorkspace />     【新增】
       └─ 其他                          → 现有翻译工作区（原样）
```

不选 `WorkbenchPage` 的原因：它管着全部状态编排、有 571 行，改动风险高；`ProjectWorkspace` 只是组装层，在这里分支影响面最小。

---

## 4. 界面形态

```
┌────────────────────────────────────────────────┐
│ 夏瑾 天琴座 V2 Beta 1.0          [保存并导出]  │  复用 WorkbenchHeader
├────────────────────────────────────────────────┤
│ 转换概要                                        │
│   144 条提示词 → 136 条 + 108 个开关            │
│   使用块  #1 (character_id=100001)   [切换 ▾]   │
│   正则 10 条已转换 · 1 条跳过                    │
│   ▸ 8 条丢弃 / 1 条降级 / 6 条角色改写           │
├────────────────────────────────────────────────┤
│ 提示词清单（136 条）              [仅看已改动]  │
│   ✓ 常驻 28                                     │
│     ➡️扩写/转述输入                              │
│   ○ 开关 108 · 显示开关名                        │
│     🖋️轻小说（幽默）                    [编辑]  │
│     🌸色情描写                          [编辑]  │
├────────────────────────────────────────────────┤
│ [下载 .risup]  [下载转换报告 JSON]  [恢复原文]  │
└────────────────────────────────────────────────┘
```

无扫描、无翻译、无审核、无术语库、无协议、无脚本管理。

---

## 5. 编辑功能设计

### 5.1 数据流：复用现有 draft 机制

工作台已有 `original_json` / `draft_json` 两栏，导入时两者都写入预设原文。导出服务读取的是 `draft_json`：

```ts
const draft = JSON.parse(project.draftJson || '{}');
const converted = convertStPreset(draft, {...});
```

**所以编辑只需写入 `draft_json`，导出自动生效，导出门路零改动。** `original_json` 保持不动，天然可回退。

### 5.2 编辑对象

只允许编辑 `prompts[i].content` 与 `prompts[i].name`：
- `content` 是提示词正文，也是导出内容；
- `name` 是 RisuAI 开关标签的来源，改了开关面板才可读。

`role` / `identifier` / `enabled` / `order` **不可编辑**。这些是结构字段，改它们等于改预设结构，不在本界面职责内（要改应回 SillyTavern）。

### 5.3 宏保护校验（关键）

预设正文里宏之间有依赖，手改极易**静默**改变行为。最危险的例子：

```
{{setvar::JailbreakPrompt::You are a helpful...}}   ← 定义（在 jailbreak 条目）
{{trim}}{{getvar::JailbreakPrompt}}                 ← 引用（在别的条目）
```

删掉或改掉定义处，引用处就会取到空值，预设表面正常但行为已变。

因此保存编辑时执行**静态校验**并返回警告（**不阻断**——用户是人工微调，有权改，但必须被明确告知）：

| 检查 | 说明 |
|---|---|
| 检查 | 说明 | 级别 |
|---|---|---|
| **删除 `setvar` 定义** | 本次编辑移除了一个定义，且该变量**已无常驻定义**却被引用 | **阻断，强制确认**（见 §10.2） |
| 变量定义/引用配对 | 全预设范围内「被引用但无任何定义」 | 仅提示（可能由触发器运行时写入，静态不可证伪） |
| 门控宏配对 | `{{#when::…}}` 与 `{{/when}}` 数量必须相等 | 仅提示 |
| 开关声明一致性 | 门控宏里的 `toggle_x` 必须仍在 `customPromptTemplateToggle` 中有声明 | 仅提示 |
| 宏增删 | 与原文件对比，列出新增/删除/内容变化的宏清单 | 仅提示 |

界面表现：编辑框旁显示「此条目包含 N 个宏」；保存后若有提示，在条目上挂标记并在顶部汇总；命中强制确认时弹框，确认后才落库。

### 5.4 编辑界面

行内展开编辑（点击「编辑」在清单中就地展开 textarea），不用弹窗——136 条清单里弹窗会打断上下文的连续性。附「恢复此条原文」按钮。

---

## 6. 接口清单

| 方法 | 路径 | 状态 |
|---|---|---|
| `GET` | `/api/projects/:id/preset-report` | **新增**：实时返回分析 + 转换报告 + 各条目当前内容（读 draft） |
| `PUT` | `/api/projects/:id/preset-prompt` | **新增**：写 draft 指定路径；命中强制确认时返回 `409 SETVAR_DEFINITION_REMOVED`，带 `confirmRemovals` 重提才落库 |
| `POST` | `/api/projects/:id/preset-reset` | **新增**：`draft_json = original_json`（可选按路径单条恢复） |
| `PUT` | `/api/projects/:id/preset-block` | 已存在，直接复用 |
| `GET` | `/api/projects/:id/export` | 已存在，已验证未扫描可用 |

`preset-report` 不落库、按需计算：转换是纯函数，136 条提示词的转换耗时可忽略，避免为它再加一张表。

---

## 7. 改动清单

### 新增

| 文件 | 作用 |
|---|---|
| `src/pages/workbench/components/preset/PresetWorkspace.tsx` | 预设专用工作区 |
| `src/pages/workbench/components/preset/PresetConversionPanel.tsx` | 摘要 + 块选择 + 报告展开 |
| `src/pages/workbench/components/preset/PresetPromptList.tsx` | 136 条清单 + 行内编辑 |
| `src/features/preset/model/usePresetReport.ts` | 拉取报告与保存编辑 |
| `src/features/preset/model/types.ts` | 报告与条目类型 |
| `server/domain/card/st-preset-edit.ts` | 编辑写入 + 宏校验（纯逻辑） |
| `tests/st-preset-edit.test.ts` | 校验规则回归 |

### 修改

| 文件 | 位置 | 改动 | 风险 |
|---|---|---|---|
| `src/pages/workbench/components/ProjectWorkspace.tsx` | 全文 41 行 | 按 `sourceFormat` 分流 | 低 |
| `server/routes/api.ts` | 新增 3 个端点 | 报告/编辑/重置 | 中 |
| `src/features/card-import/ui/ImportSummary.tsx` | `:30-32` | 预设项目的按钮由「扫描」改为「转换」 | 低 |
| `src/pages/workbench/tabs/overview/model/overview-labels.ts` | — | 已支持 `st-preset` | 无 |

### 不动

`GuidedWorkflow`、`TranslationCommandBar`、`WorkbenchTabs`、`WorkspaceTabContent`、`segments` 表、翻译调度、审核流程。其他格式的项目走原路，零影响。

---

## 8. 明确不做

- 预设项目**不写 `segments` 表**：转换不需要分段，写进去只会污染翻译相关的统计与校验。
- **不做多语言翻译**：预设正文本身是中文，本界面只做格式转换与人工微调。若将来需要翻译其他预设，走现有翻译工作台即可（届时可加「转为翻译项目」入口）。
- **不做批量转换**：按决策逐个处理。
- **不编辑结构字段**：`role`/`identifier`/`enabled` 只读。

---

## 9. 验证方案

1. **单元**：宏校验规则——尤其 §10.2 的四条分支（仍有常驻定义 / 只剩门控定义 / 无定义且被引用 / 无引用），以及 `confirmRemovals` 名单不一致时拒绝落库。
2. **接口**：改一条提示词 → 导出 → 解码 `.risup`，断言改动生效且其余 135 条不变。
3. **回归**：编辑后导出仍满足既有不变量（开关与门控 1:1、门控格式闭合、无 `jailbreak` 类型条目）。
4. **回退**：`preset-reset` 后导出与初始导入导出逐字节一致。
5. **隔离**：确认预设项目不产生 `segments` 记录。
6. **不回归**：其他格式项目的导入/扫描/导出流程测试全绿（现有 240 项）。
7. **界面**：预设项目下不出现翻译标签页；其他格式不出现转换面板。
8. **真机**：编辑后导出的预设导入线上 RisuAI，确认改动生效且破限内容仍在（用 `verify-prompt-toggle-parser.mjs`）。

---

## 10. 已确认的设计决策

### 10.1 编辑保存方式：**即时写库** + 「恢复原文」

- 编辑框失焦或点「完成」即写入 `draft_json`，不设显式保存按钮；
- 全局「恢复原文」把 `draft_json` 重置为 `original_json`；每条提示词另有「恢复此条原文」；
- 顶部显示「已修改 N 条」，让用户随时知道偏离原文多少。

理由：转换是纯函数、写入只影响 `draft_json`、`original_json` 全程不动，回退成本几乎为零，显式保存只多一次点击。

### 10.2 删除 `{{setvar::}}` 定义：**强制确认**

**触发规则（差分判定，不是绝对判定）**

保存时对比编辑前后的 `setvar` 定义集合，只对**本次编辑移除掉的定义**做判断：

| 情况 | 处理 |
|---|---|
| 被移除的定义，其变量**仍有常驻（非门控）定义** | 静默通过 |
| 被移除的定义，其变量**只剩门控定义或已无定义**，且被引用 | **强制确认**，列出引用位置 |
| 同上，但**没有任何引用** | 仅顶部提示，不阻断 |
| 新增定义、修改定义的值、改动引用 | 静默通过 |

> **关键细节**：剩余定义必须落在**常驻条目**上才算数。门控条目默认关闭，其中的 `setvar` 不会执行——把它当作"仍然有定义"会漏报。本预设的 `harukiSelfidentity` 正是这种情况（1 处常驻 + 1 处门控），按"还有别处定义就放过"的规则会静默漏掉。

**为什么用差分而非绝对判定**：绝对判定（"被引用但全文无定义"）对本预设会报出 3 个悬空引用——`atkSelfPrompt`、`harukiCoreExpressionHard`、`harukiCoreExpressionEazy`（均在 `#95` 引用）。但这些变量**可能由 RisuAI 触发器脚本在运行时写入**，静态分析无法证明它们是坏的。差分判定只对"用户这次真的删掉了一个原本存在的定义"负责，不误报。

**交互**

1. 用户确认编辑 → 后端计算差分；
2. 命中强制确认时返回 `409 { code: 'SETVAR_DEFINITION_REMOVED', removals: [...] }`，每项含变量名、被移除的定义位置、全部引用位置（条目序号 + 开关名）；
3. 前端弹确认框，逐条展示「删除 `JailbreakPrompt` 的定义后，第 12 条的 `{{getvar::JailbreakPrompt}}` 将取到空值」；
4. 用户确认后带 `confirmRemovals: ['JailbreakPrompt']` 重新提交，后端校验名单一致才落库。

后端是判定权威，前端只负责呈现，避免两边规则漂移。

**为什么这条要阻断而非仅警告**：它是唯一会让预设"看起来完全正常、实际已经坏掉"的操作。其他问题（丢字段、降级、正则跳过）都在转换报告里可见；只有这类损坏在 RisuAI 里表现为"破限莫名其妙不生效"，极难归因。

### 10.3 本预设的实测依赖（作为设计输入）

| 变量 | 常驻定义 | 门控定义 | 被引用 | 删除常驻定义后 |
|---|---|---|---|---|
| `JailbreakPrompt` | 1 | 0 | 1 | **强制确认** |
| `wordsCloud` | 1 | 0 | 3 | **强制确认** |
| `harukiTap` | 1 | 0 | 1 | **强制确认** |
| `harukiSelfidentity` | 1 | 1 | 1 | **强制确认**（剩余定义是门控的） |
| `JailbreakCorePrompt` | 1 | 1 | 0 | 仅提示 |
| `cotBegin` | 1 | 2 | 0 | 仅提示 |
| `harukiThinking` 等 5 个 | 0 | 1~3 | 0 | 仅提示 |


---

## 11. 实现记录

已按 §1–§10 全部落地，256/256 测试通过，typecheck 与 build 干净。

### 新增文件

| 文件 | 作用 |
|---|---|
| `server/domain/card/st-preset-edit.ts` | 路径读写白名单、setvar 依赖差分、结构校验、项目视图构建 |
| `tests/st-preset-edit.test.ts` | 15 项，覆盖 §10.2 四条分支与关键陷阱 |
| `src/features/preset/model/types.ts` | 与后端视图对应的类型 |
| `src/features/preset/model/usePresetProject.ts` | 载入、编辑（含确认重提）、恢复、选块 |
| `src/pages/workbench/components/preset/PresetWorkspace.tsx` | 预设项目工作区 |
| `src/pages/workbench/components/preset/PresetConversionPanel.tsx` | 转换概要、块选择、无法映射清单 |
| `src/pages/workbench/components/preset/PresetPromptList.tsx` | 提示词清单与行内编辑 |

### 修改点

`ProjectWorkspace.tsx`（按 `sourceFormat` 分流）、`WorkbenchPage.tsx`（传入 `preset` 与 `conversionFormats`）、
`ImportSummary.tsx`（转换类格式不显示「扫描」）、`useCardImport.ts`（结果带 `sourceFormat`）、
`api.ts`（3 个新端点）、`risup.ts`（gzip `mtime: 0`）、`styles.css`（`.preset-*`）。

### 实测验证（临时端口 18904，未触碰 8787）

| 步骤 | 结果 |
|---|---|
| 导入 | `sourceFormat=st-preset` |
| `preset-report` | 144 条：28 常驻 / 108 门控 / 8 丢弃；生效块 1 |
| 普通编辑 | 直接成功，`editedCount` 归零（写入同值） |
| **删除 `JailbreakPrompt` 定义** | **409 `SETVAR_DEFINITION_REMOVED`**，`removals: JailbreakPrompt(引用 1 处)` |
| 带 `confirmRemovals` 重提 | 成功，`appliedRemovals: JailbreakPrompt`，`editedCount=1` |
| 导出反映改动 | 94,678 字节（基线 95,690） |
| 结构字段 | `role` / `temperature` / `prompt_order…enabled` 全部 400 |
| 恢复全部原文 | `editedCount=0`，导出与基线**逐字节一致** |

### 实现中发现的两个问题

1. **`validateEditedText` 的开关名比较错误**：宏写作 `toggle_st_7`，而 `customPromptTemplateToggle` 声明的是裸键 `st_7`，未剥前缀会全部误报。已修。
2. **导出不是字节可复现的**：fflate 的 `compressSync` 会把当前时间写进 gzip 头 MTIME（偏移 4），两次导出差 1 字节。已改为 `{ mtime: 0 }`——RisuAI 解码不读该字段，纯收益。
