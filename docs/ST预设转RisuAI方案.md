# ST 预设转 RisuAI 方案

> 2026-09-13 修订：请结合 [兼容性复盘与工作台改造方案](./ST预设转RisuAI兼容性复盘与改造方案.md) 阅读。旧文中的“功能无损”及能力映射结论不能代替变量、开关和正则的运行验证；新方案明确区分已实现、专项适配与待验证事项。

目标：把 SillyTavern（下称 ST）聊天补全预设 **功能无损**地转换成 RisuAI 预设（`.risup`），并把它做成工作台的一项能力。

样例文件：`夏瑾 天琴座 V2 Beta 1.0.json`（161,050 字节，144 条 prompts，11 条 regex，2 个 `prompt_order` 块）。

> **本方案已对齐 `D:\workerspace\docker\sillytavern\risuai-patches` 的补丁与更新流程。**
> 结论先行：**本功能不需要对 RisuAI 做任何修改，不增加任何补丁负担**（见 §2）。

---

## 1. 结论摘要

1. **字节级无损做不到**：Risu 预设 schema 装不下 ST 的全部字段。这个不需要回避。
2. **功能无损可以做到**，载体是 Risu 的 **提示词开关（toggle）+ 条件宏**，且在线上构建中已确认 UI 可点击（§3.3）。
3. 对比现有三条路径，本方案是唯一能同时保住**提示词顺序、启用状态、可选库、开关可回退**的路径。
4. **本功能落在工作台侧，产出物是纯数据（`.risup`）**，RisuAI 镜像、容器、补丁全都不动。
5. 最大剩余风险是开关包装的**空白/换行行为**，用 Phase 0 真机验证（§7）。

---

## 2. 与 risuai-patches 的关系（重要）

### 2.1 线上部署实况（2026-09-12 直连核对）

| 项 | 值 |
|---|---|
| 服务器 | `1.117.66.171`（腾讯云，ubuntu 用户） |
| 容器 | `risuai`，`Created 2026-08-20T06:18Z`，`StartedAt 2026-09-11T03:40Z` |
| 镜像 | `risuai:codex-main-22ea4a64-legaltrue-patched-20260820` |
| **运行版本** | **RisuAI 2026.8.160**（从镜像内 bundle 直读） |
| 挂载 | **仅** `/opt/1panel/apps/risuai-local-sso/risuai/save -> /app/save` |

### 2.2 补丁只存在于容器可写层（风险事实）

`docker diff risuai` 输出：

```
C /app/dist/assets/index-CXZ1S_FJ.js
C /app/dist/assets/database.svelte-vu9TBkgf.js
```

对照镜像内原始文件：

| 文件 | 镜像内（纯净） | 运行容器（已打补丁） |
|---|---|---|
| `index-CXZ1S_FJ.js` | `5ab27e39…`（1,356,947 B） | `663104e9…`（1,361,848 B） |
| `database.svelte-vu9TBkgf.js` | `680e4269…`（2,390,896 B） | `cb4c8968…`（2,392,686 B） |

**含义**：两个补丁（09-05 模型列表 `proxy2`、09-06 API 配置档案）**没有 bind mount，也不在镜像里**，只活在容器的可写层。

- `docker restart` → 保留（所以 09-11 那次重启后补丁仍在）；
- **`docker compose up -d` 重建容器 / 换镜像 → 两个补丁全部丢失**，必须用 `scripts/patch-*.mjs` 重放。

这正是"更新后的 patch"的现实约束：**每次 RisuAI 更新都要重新识别哈希文件名、重放补丁、`node --check`、重启、验哈希。**

### 2.3 本功能的补丁负担：零

ST 预设转换的产物是一个 `.risup` **数据文件**，导入 RisuAI 走的是它原生的"导入预设"路径。因此：

- 不新增补丁脚本；
- 不修改 `/app/dist/assets/*.js`；
- 不新增服务端路由；
- **不影响更新后的补丁重放流程**——重放脚本的锚点（Bot Settings 的模型输入框、`customModelAuth` 导出）与预设导入逻辑完全无关。

这也意味着：转换所依赖的 `customPromptTemplateToggle` / `{{#when}}` / `normalizePromptTemplate` 全部是 **RisuAI 原生能力**，只要上游不删就不会失效，**不随补丁重放而漂移**。

### 2.4 需要注意的既有隐患（建议单独处理，不在本方案范围）

服务器上 `build/Risuai` 源码检出为 **2026.6.215**（`.source-commit = 9b26069…`），而**运行镜像是 2026.8.160**。两者不一致，说明该检出目录相对运行镜像已经过期。

如果将来从这个目录重新构建镜像，会**降级**到 2026.6.215 的代码。建议在做下一次更新前先核对并刷新该源码检出。

---

## 3. 已核实的关键机制

### 3.1 证据来源与可信度

本方案的 RisuAI 侧结论**全部基于线上运行构建**，非二手文档：

| 证据 | 校验方式 | 结果 |
|---|---|---|
| 线上 bundle 的 sourcemap | 线上 `database.svelte-vu9TBkgf.js.map` SHA-256 | `0f42802e…` = 本地 `remote-current-frontend.js.map` ✓ |
| sourcemap → 原始 TS | 抽取后与服务器源码逐文件哈希比对 | `cbs.ts`/`util.ts`/`process/prompt.ts`/`process/index.svelte.ts`/`process/scripts.ts` **5/7 完全一致** ✓ |
| 运行版本 | 镜像内 bundle 直读 `appVer` | `2026.8.160` ✓ |

抽取出的**线上源码**保存在工作台 `temp/risu-cur/`（`temp/` 已被 `.gitignore` 忽略）。

> ⚠️ **更正**：本方案早期版本曾使用 `risuai-patches/2026-09-02-baseline/workspace-snapshot/`，那是 **2026.6.103** 的历史构建（该基线文档自己也标注为 historical）。两者在预设相关代码上**确有差异**（见 §3.4），已全部改以线上构建为准。

### 3.2 `.risup` 封装格式

```js
encodeRPack( fflate.compressSync( encodeMsgpack({
  presetVersion: 2,
  type: 'preset',
  preset: await encryptBuffer( encodeMsgpack(preset), 'risupreset' )
}) ) )
```

| 环节 | 细节 | 工作台现状 |
|---|---|---|
| RPack | 512 字节替换表，`encode=map[0..256]`、`decode=map[256..512]` | ✅ 已有同表：`server/domain/card/risum.ts:5` |
| fflate | `compressSync` / `decompressSync` | ✅ 已是依赖 |
| AES-256-GCM | key = `SHA-256("risupreset")`，**IV = 12 字节全零** | ⚠️ 需新增（Node `crypto` 可实现） |
| msgpack | `encodeMsgpack` / `decodeMsgpack` | ❌ 需新增（已定：加 `@msgpack/msgpack`） |

导入侧接受 `.json` / `.preset` / `.risupreset` / `.risup`；非 `.risup` 走裸 JSON。

### 3.3 开关机制（功能无损的载体，**线上已验证**）

**声明**（`customPromptTemplateToggle`，官方中文文案原文）：
> 可在此处设置自定义提示词切换功能。使用 ``<toggle variable>=<toggle name>`` 格式，每行一个。

设置项标签：`自定义开关`。

**状态存储**：`globalChatVariables['toggle_<变量>']`，值为 `'1'` / `'0'`。

**UI**（从线上 `index-CXZ1S_FJ.js` 直读，9 处引用）：
```js
onChange: () => {
  z.db.globalChatVariables[`toggle_${q(n).key}`] =
    z.db.globalChatVariables[`toggle_${q(n).key}`] === '1' ? '0' : '1'
}
```
支持形态：`group`（含 children）/ `select` / `text` / `textarea` / `caption` / `divider` / **默认复选框**。

**提示词门控**：`{{getglobalvar::toggle_<变量>}}`（不存在返回空串）。
条件宏：`{{#if}}`（**已 deprecated**）、`{{#if_pure}}`（**已 deprecated**）、**`{{#when::…}}`（现行）**，支持 `and`/`or`/`is`/`isnot`/`>`/`<`/`>=`/`<=`/`not` 与 `keep` 变体。

→ 三者齐备，且 UI 可点击，**"功能无损"在机制上成立**。

### 3.4 线上构建新增：`normalizePromptTemplate`（旧快照没有）

线上构建在 **7 处**调用 `normalizePromptTemplate`，其中两处关键：

- **DB 加载时**（遍历 `data.botPresets[]`）：导入的预设会在加载时被自动规范化；
- **ST 预设导入后**：`pr.promptTemplate = normalizePromptTemplate(pr.promptTemplate)`。

其角色映射：

```js
function normalizePromptRole(role) {
  if (role === 'user' || role === 'bot' || role === 'system') return role
  if (role === 'assistant' || role === 'char') return 'bot'
  return null          // → 调用处 `?? 'system'`
}
```

**即：`assistant`/`char` → `bot`；未知（含 `model`）→ `system`。**

### 3.5 ST 预设导入现状：仍只读 `prompt_order[0]`

线上构建的 ST 分支与旧版**逻辑一致**（仅多一行 normalize）：只读 `prompt_order[0]`、跳过 `enabled: false`、`scenario`/`charPersonality`/`dialogueExamples` 直接 `break //ignore`、`worldInfoAfter` 丢弃。

本样例两个块：`character_id=100000`（11 条壳）与 `100001`（59 条**真正内容**）。已严格校验 **B ⊇ A**（A 的 11 条全在 B 中，两块均无重复）。Risu 取到的是那个 11 条的壳。

---

## 4. 现状：三条路径各丢什么

| 路径 | 结果 |
|---|---|
| 丢进 Risu 聊天窗口 | **完全无效**。`detectPromptJSONType` 要求 `chat_completion_source` 存在才认 STCHAT，本文件没有该字段 → `NOTSUPPORTED` |
| Risu "导入预设" | 有效，但只读 `prompt_order[0]`；`enhanceDefinitions` 在其中为 `enabled:false` → **真破限内容被跳过**；丢了 `scenario`/`charPersonality`/`dialogueExamples`/`worldInfoAfter`；**144 条中 85 条孤儿全丢**；非 `[0]` 块的所有禁用可选库无法表达 |
| 工作台现有导入 | `st-preset.ts` 拼成 `module.text` + 塞 `extensions.tavern_preset`，再包成 **risum 模块**。而 `.risum` 对 Risu 是**角色卡模块**，**不出现在预设列表** |

---

## 5. 目标定义：功能无损

| 能力 | 承诺 | 实现方式 |
|---|---|---|
| 提示词顺序 | ✅ | 按选中块的 `order` 生成 `promptTemplate` |
| 启用/禁用 | ✅ 可切换 | 禁用项用 `{{#when}}` 包裹 + 自动声明 toggle，**默认关** |
| 可选库（85 条孤儿） | ✅ 全保留 | 同上，进分组开关区，默认关（与 ST 一致） |
| 两块差异 | ✅ 可切换 | 选中块定默认态；另一块状态不同的条目追加开关 |
| 内建标记位 | ✅ | `chatHistory`→`chat`、`worldInfoBefore`→`lorebook`、`charDescription`→`description`、`personaDescription`→`persona` |
| 采样参数 | ✅ 换算 | temperature/frequencyPenalty/PresensePenalty ×100 |
| 正则脚本 | ⚠️ 尽力 | 11 条 `regex_scripts` → `customscript[]`（`type` 取值集待核实） |
| 原始可逆 | ✅ 旁挂 | 同时导出原始 ST JSON |

**明确不承诺**（Risu 侧无对应物）：`wi_format`/`scenario_format`/`personality_format`、`forbid_overrides`、`use_sysprompt`/`squash_system_messages`/`names_behavior`、工具与 `tool_reasoning_mode`、`send_if_empty`/`continue_nudge_prompt`、`worldInfoAfter`、多块并存。

---

## 6. 转换设计

### 6.1 输入选择

有多个 `prompt_order` 块时，**导入后在 UI 让用户选块**（已确认的产品决策），默认预选引用集为超集的块（本样例即 100001）。

### 6.2 提示词映射表

| ST 条件 | Risu `PromptItem` |
|---|---|
| `main` | `{type:'plain', type2:'main', text, role}` |
| `jailbreak` \| `nsfw` | `{type:'plain', type2:'normal', text, role}` —— **刻意不用 RisuAI 的 `jailbreak` 类型**，见下方说明 |
| `chatHistory` | `{type:'chat', rangeStart:0, rangeEnd:'end'}` |
| `worldInfoBefore` | `{type:'lorebook'}` |
| `charDescription` | `{type:'description'}` |
| `personaDescription` | `{type:'persona'}` |
| `scenario` | `{type:'plain', type2:'normal', text, role:'system'}` + 警告 |
| `charPersonality` | 同上 |
| `dialogueExamples` | `{type:'chat', rangeStart:-1000, rangeEnd:'end'}` + 警告 |
| `worldInfoAfter` | 丢弃 + 报告（Risu 单槽位） |
| 其他 + `content` 非空 | `{type:'plain', type2:'normal', text, role}` |
| `system_prompt === true` | role 兜底 `system` |

### 6.3 role 归一化：**刻意与 Risu 不同**

本样例的 role 分布：全部 144 条中 `user` 131 / `system` 7 / `model` 4 / `assistant` 2；而**选中块 B 的启用集只有 `user` 28 / `system` 3**，非标准 role 全部落在禁用与孤儿条目里。

进一步核对那 6 条非标准 role 条目，**全部是孤儿**，且内容全是"预填充"类：
`🛡️强破限`、`🌸预填充`、`填充2`、`预填充暴力穿甲`、`📔极强破限`、`📙测试覆写`。

由此确认 **ST 的 `role: 'model'` 语义 = assistant = Risu 的 `bot`**。

**设计决策**：
- `assistant` / `char` → `bot`（与 Risu 一致）
- **`model` → `bot`（与 Risu 的 `normalizePromptTemplate` 不一致，Risu 会映射成 `system`）**

理由：这些是预填充内容，映射成 `system` 会**改变语义**。因为 `bot` 是合法 role，Risu 的 normalize 不会再改写它，我们的映射会生效。此为有意为之，需在转换报告中标注。

### 6.4 开关包装

对每条"默认关"的提示词：

```
{{#when::{{getglobalvar::toggle_<slug>}}}}
<原始内容>
{{/when}}
```

`customPromptTemplateToggle` 追加：

```
<slug>=<原提示词名>
<slug>=<原提示词名>=group      # 分组
```

分组按 ST 预设自带 emoji 前缀：🖋️文风 / 🧭倾向 / ⚙️开关 / 🧊抗性 / 📘格式 / 📔模式 / 📙助手。

`slug` 必须稳定且只含安全字符（去 emoji、转写、去重、序号兜底），因为它是宏名的一部分。

### 6.5 其他字段

- `assistant_prefill` → 按 Risu 原生方式追加 `{type:'postEverything'}` + `{type:'plain', type2:'main', role:'bot', text:'{{#if {{prefill_supported}}}}…{{/if}}'}`。
  > 沿用 Risu 自身的 `#if` 写法以保持行为一致，**不**自行换成 `#when`。
- `regex_scripts` → `customscript{comment,in,out,type,flag,ableFlag}`；`placement` 1/2 → 输入/输出阶段（`type` 取值集待核实）。
- `temperature`/`frequency_penalty`/`presence_penalty` → ×100 且口径统一；`openai_max_context` → `maxContext`；`openai_max_tokens` → `maxResponse`。

#### 为什么 `jailbreak` 不映射成 RisuAI 的 `jailbreak` 类型

RisuAI 在 `process/index.svelte.ts` 对 `type: 'jailbreak'` 的条目**整体跳过**：

```js
case 'plain': case 'jailbreak': case 'cot':{
    if((!DBState.db.jailbreakToggle) && (card.type === 'jailbreak')){
        continue
    }
```

而 `jailbreakToggle` **默认 `false`**（`database.svelte.ts`：`data.jailbreakToggle = false`）。

RisuAI 自带的 ST 导入器正是把 ST 的 `jailbreak`/`nsfw` 映射成这个类型，**因此它转换出的预设会默认丢失这部分内容**。样例预设上后果严重：被跳过的两条恰好是 `JailbreakPrompt` 与 `wordsCloud` 的唯一定义处，而 `{{trim}}{{getvar::JailbreakPrompt}}` 正是该预设的核心破限注入。

故改为 `plain`/`normal`：始终发送（与 ST 中"启用即无条件发送"一致），位置由 `promptTemplate` 数组顺序保留。转换报告会逐条列出被提升为常驻的提示词。

---

## 7. 分阶段实施

### Phase 0 —— 开关机制真机验证（闸门）
用 `@msgpack/msgpack` + 现有 RPack 表写一次性 spike，产出 2~3 条提示词的测试 `.risup`，导入线上 Risu 验证：
1. 开关是否出现在 UI 并能翻转；
2. `{{#when::{{getglobalvar::x}}}}` 嵌套宏是否被求值；
3. 被包裹的多行提示词**首尾空白/换行**是否正确（对比 `#if` / `#if_pure` / `#when::keep`）；
4. 关闭态是否真渲染为空串。

> 这是唯一的高风险假设，结论决定 §6.4 的包装模板。

### Phase 1 —— `.risup` 编解码底座
新增 `server/domain/card/risup.ts`：msgpack + AES-256-GCM + fflate + RPack，导出 `encodeRisuPreset()` / `decodeRisuPreset()`。把 `risum.ts` 的 RPack 表抽到共享模块。

### Phase 2 —— ST 预设分析与转换
重写 `st-preset.ts` 为分析与检测入口；新增转换模块产出真实 `botPreset` 形状；输出**逐条转换报告**。

### Phase 3 —— 正则脚本转换
先核实 `customscript.type` 取值集。

### Phase 4 —— 工作台接入（新增 `st-preset` 源格式）
原始预设 JSON 直接作为 card 存储，分段 path 直通 `["prompts",5,"content"]`，复用 `applyApprovedSegments`。新增 `scanStPreset()`；导出产 `.risup` + `.json`；**补 ST 宏保护**（`{{setvar::}}`/`{{//}}`/`{{trim}}`/`<SUOT>`）。

### Phase 5 —— 验证
单测 + 真实文件往返 + **真机 E2E**。

---

## 8. 影响面分析

### 8.1 新增文件

| 文件 | 作用 |
|---|---|
| `server/domain/card/risup.ts` | `.risup` 编解码 |
| `server/domain/card/rpack.ts` | 共享 RPack 表（从 `risum.ts` 抽出） |
| `server/domain/card/st-preset-convert.ts` | ST 预设 → Risu `botPreset`（含开关生成） |
| `server/domain/card/st-macro-protection.ts` | ST 宏保护片段 |
| `tests/risup.test.ts` / `tests/st-preset-convert.test.ts` | 回归 |
| `src/features/card-import/ui/StPresetBlockDialog.tsx` | 块选择 + 转换报告 |

### 8.2 修改文件（后端）

| 文件 | 位置 | 改动 | 风险 |
|---|---|---|---|
| `server/domain/card/st-preset.ts` | 全文 | 重写为检测+分析 | 中 |
| `server/domain/card/risum.ts` | `:5` | RPack 表改引入 | 低（`tests/risum.test.ts` 兜底） |
| `server/domain/card/card.ts` | 新增 | `scanStPreset()` | 中 |
| `server/routes/api.ts` | `:164-172` | 导入分支改 `sourceFormat:'st-preset'` | **高**（改现有行为） |
| `server/routes/api.ts` | `:1640-1653` | 扫描分派 | 中 |
| `server/routes/api.ts` | `:2027` | 导出分派 `.risup` | 中 |
| `server/application/export/export-service.ts` | `:458` | 新增 `st-preset` 分支 | 中 |
| `server/application/projects/project-service.ts` | `:84-91` | `extensionForFormat` | 低 |
| `server/repositories/file-storage.ts` | `:81` | `fileExtension` 兜底 | 低 |
| `server/db.ts` | `:218` | `addColumnIfMissing('projects','preset_block_id',…)` | 低 |
| `package.json` | deps | 加 `@msgpack/msgpack` | 低 |

**RisuAI 侧：0 个文件。**

### 8.3 修改文件（前端）

`card-file.ts:2`、`useCardImport.ts:54-58`、`overview-labels.ts:20-28`、`WorkbenchSidebar.tsx:99-101`、`ProjectOverviewPage.tsx:44`、`GuidedWorkflow.tsx:117`，外加新增块选择对话框。

### 8.4 测试

- `tests/st-preset.test.ts` **必须重写**（现有用例断言旧 `module.extensions.tavern_preset` 形状）
- `tests/risum.test.ts` 保持不变，验证 RPack 抽取无回归
- `tests/scan-service.test.ts` 增补 `scanStPreset` 用例

### 8.5 文档

本文件，以及 `README.md:44-47` 格式支持表新增一行（已核实 README 目前未提及 ST 预设）。

### 8.6 不在范围内

`server/routes/inspection.ts` 的酒馆卡预览是独立会话流程，不动。`server/domain/lua/*`、`server/domain/protocol/*` 不改，仅 `protectText` 增加 ST 宏片段。

---

## 9. 风险与降级

| 风险 | 影响 | 应对 |
|---|---|---|
| **开关包装空白/换行不符预期**（最高） | "功能无损"失效 | Phase 0 验证；降级用 `{{#when::keep::…}}`，或退化为"启用项裸放 + 禁用项统一置尾并标注" |
| 宏嵌套不被求值 | 开关无法门控 | 降级 `{{#if {{getglobalvar::x}}}}` |
| Risu 内重新保存预设丢未知键 | 内嵌元数据消失 | 不依赖内嵌；可逆性靠旁挂原始 JSON |
| 导入行为变更 | 旧 ST 预设项目 | 旧项目仍是 `risum`，不受影响 |
| 144 条开关造成困惑 | 体验 | 转换报告 + 分组 + 默认关 |
| `@msgpack/msgpack` 审计 | CI | `npm audit --omit=dev --audit-level=high` 把关；备选手写最小编解码 |
| **RisuAI 更新后补丁丢失** | 与本事无关，但会连带影响整体可用性 | 见 §2.4；本功能本身零补丁负担 |

---

## 10. 验证方案

1. 单元测试：映射表逐条、开关生成、报告完整性、`.risup` 往返。
2. 真实文件往返：`夏瑾 天琴座 V2 Beta 1.0.json` 全流程，断言 144 条全部有归宿。
3. RPack 回归：`tests/risum.test.ts` 全绿。
4. **真机 E2E**（唯一有效证据）：`.risup` 导入线上 Risu，截图比对顺序、默认开关态、翻转效果。
5. 构建校验：`npm run typecheck` / `npm test` / `npm run build` / `npm audit --omit=dev --audit-level=high`。

> 不拿单测替代真机 E2E。E2E 未过前不宣称"功能无损"成立。

---

## 11. 待决事项

1. Phase 0 需要在线上 Risu 导入一次测试预设（会产生一个可删除的测试预设）。
2. `customscript.type` 取值集待核实。
3. `scenario` / `charPersonality` / `dialogueExamples` 的降级形态需产品确认。
4. §2.4 的源码检出过期问题是否单独处理。
