# RisuAI 触发器文案漏翻：问题定位与修复方案

> 本文档供外部模型/人工审计使用，**自包含**：包含现象、复现方式、根因、修复设计、影响面实测数据、已知边界，以及建议审计者重点质疑的清单。
>
> 修改者：DSH 编码代理；Codex 复核与补充修复　修改日期：2026-09-14
>
> **当前状态：已补充宏边界修复，最新结果见 §12（2026-09-15）。** §2–§9 中的原始扫描数据、交付卡片和旧版代码片段保留为第一轮记录，不代表补充修复后的重新交付或全语料验证。§4.5 已替换为现行保护方案。
> 涉及提交范围：工作区未提交改动（本问题涉及 `server/domain/card/card.ts`、`server/application/export/export-service.ts`、两个测试文件及本文档；工作区另有其他功能改动）

---

## 0. 审计速览

| 项 | 内容 |
| --- | --- |
| **问题** | RisuAI 模块的触发器文案（`trigger[].effect[].value`）从不进入翻译候选，玩家在聊天里看到原文 |
| **根因** | `scanRisuModule()` 的通用遍历把该字段判为「受保护的脚本路径」，随后交给只认 HTML 标签的 `extractVisibleText()`；纯文本无标签，返回空数组，**静默丢弃** |
| **修复** | 按 effect 类型和字段白名单提取；拒绝变量字段继续进入 HTML 兜底；应用与导出重验模块上下文；详见 §10 |
| **影响面实测** | 97 个含 Risu 模块的项目全量对比：**新增 5 条 segment，删除 0 条**，仅 1 个项目受影响（§5.4、§11.1） |
| **验证** | 第二轮独立复验后：`npm run build` 通过，聚焦测试 **103 / 103**；全量套件因工作区存在**并发编辑**其数字为移动目标，判定依据见 **§11.3** |
| **未做** | `module.regex[].out` 等 39 处同类缺口（属独立功能，§7 说明为何不能顺手修） |

---

## 1. 涉及文件

| 文件 | 作用 | 本次是否修改 |
| --- | --- | --- |
| `server/domain/card/card.ts` | 扫描规则：`scanRisuModule()` / `isProtectedStoredPath()` / `restoreProtectedModuleDraft()` | ✅ 修改（第一轮 3 处 + §10 补充） |
| `server/application/export/export-service.ts` | apply/export 调用方 | ✅ 修改（§10 传递原始模块、导出检查模块行；§11.2 `moduleBase` 兜底） |
| `tests/card.test.ts` | 扫描回归测试 | ✅ 新增 4 条、扩展 2 条 |
| `tests/protected-stored-path.test.ts` | apply/export 路径保护回归测试 | ✅ 修正豁免断言 + 新增 2 条集成测试 |
| `server/domain/lua/risu-lua.ts` | `applyRisuModuleSegments()` 写回 | ❌ 未改（现有逻辑已兼容） |

---

## 2. 现象与复现

**测试卡**：`禁忌乐园 - Forbidden Paradise.zh-CN (1).charx`
原始上传件 sha256 `a12175308d643d3d097afd60ea4843d174b6c76fdb0ac927d66f3e6307272388`

**现象**：在聊天里点击开场消息的 Allocation UI 选项按钮，聊天记录出现韩文

```
🕊️ 학교의 평범한 모범생을 선택했습니다.
```

而同一界面上的按钮标签本身**已经**是中文（`🕊️ 学校的王牌 & 模范生`）。

**最小复现**：

```ts
import { scanRisuModule } from './server/domain/card/card.js';

const module = {
  trigger: [{
    comment: 'A', type: 'manual',
    effect: [{ type: 'v2Impersonate', role: 'user',
               value: '🕊️ 학교의 평범한 모범생을 선택했습니다.', valueType: 'value' }],
  }],
};

// 修复前：所有 scope 都返回 []
// 修复后：visible-scripts / all-visible / all 均返回 1 条
scanRisuModule(module, 'all');
```

---

## 3. 根因分析

### 3.1 调用链

```
POST /api/projects/:id/scan
  └─ scan-service.ts  replaceScannedSegments()
       └─ api.ts:1666  scanRisuModule(module, scope)      ← 本文件的缺陷点
            └─ visit(module, ['$module'])                 通用递归遍历
```

### 3.2 逐行判定

对路径 `['$module','trigger',1,'effect',0,'value']` 上的字符串 `"🕊️ 학교의…"`，修复前的判定过程
（下引 `card.ts` 行号为**修复后**的当前行号，便于审计定位）：

```ts
// card.ts  scanRisuModule().visit()
const luaCode = isLuaModuleCodePath(path);        // false —— 末段是 value 不是 code
const background = isBackgroundPath(path);        // false
const script = isScriptPath(path);                // false —— 'trigger' 不匹配 triggerscripts?

if (scope === 'all' && !luaCode && !background && !script
    && !isGenericProtectedPath(path, 'value')) {  // ← 在这里被拒
  add(fieldSegment(path, value, 'core', 'medium'));
  return;
}

// 兜底分支：被当成「脚本 UI」
const extracted = extractVisibleText(value, path, 'script-ui');  // ← 返回 []
extracted.forEach(add);                                          // ← 一条都没有
```

两处叠加导致必然丢弃：

1. **`isGenericProtectedPath()` 按名字拒绝**（`card.ts:2993`）：
   ```ts
   return path.some((part) => /^(?:assets?|chats?|chatPage|sdData|vits|regex|triggers?|customscripts?|scripts?|virtualscript|cjs)$/iu.test(String(part)));
   ```
   路径里有 `trigger` 段 → 整条路径判为受保护 → `scope === 'all'` 的通用翻译分支被跳过。

2. **`extractVisibleText()` 只认标记结构**（`card.ts:1996`），它的 5 条提取正则分别是
   `{{button::…}}`、HTML 属性、`>文本<`、`>文本$`、`^文本<`。
   一句纯文本 `🕊️ 학교의…` 里没有 `<` `>`，**五条全部不匹配**，返回空数组。

结果：**任何 scope 都扫不出来。**

### 3.3 排除性验证（修复前实测）

用当时已编译的 `dist-server` 扫描器跑该卡的真实 `module.risum`：

```
scope=core             segments=1   trigger=0
scope=standard         segments=7   trigger=0
scope=lua-only         segments=0   trigger=0
scope=visible-scripts  segments=8   trigger=0
scope=all-visible      segments=8   trigger=0
scope=all              segments=9   trigger=0
```

已排除的可能：「范围选错」「卡本身没这条」「扫描后没应用」。**六种范围全部为 0**，确认是扫描器缺陷。

### 3.4 为什么按钮标签反而是中文

选项按钮写在 `module.regex[1].out` 的 HTML 里（`<span>🕊️ 学校的王牌 & 模范生</span>`）。
`regex` 路径同样命中 `isScriptPath()`，但它走的是兜底分支的 `extractVisibleText()`——
**因为有 HTML 标签，文本节点被成功抠出**。
这条对照正好说明：缺陷不是「trigger 没被扫」，而是「**没有标签的纯文本被丢给了一个只会读标签的提取器**」。

---

## 4. 修复设计

### 4.1 为什么不按字段名/路径形状匹配

第一版修复曾按路径形状放行（凡 `trigger[n].effect[m].value` 一律当文案）。用 RisuAI 上游真实类型做反例测试后**被否决**，因为它会误翻运行时数据：

| effect 形状 | 实际语义 | 按形状匹配的后果 |
| --- | --- | --- |
| `v2SetRequestStateRole.value = "user"` | 运行时有 `if (value === 'user' \|\| 'assistant' \|\| 'system')` 分支 | 翻成「用户」→ **分支静默失效** |
| `v2SetVar.value` + `valueType:"var"` | 变量**名**，运行时走 `getVar()` | 翻译后 **变量找不到** |
| `v2Command.value = "/setvar 체력 10"` | Risu 指令语法 | 指令失效 |
| `v2GetAlertSelect.value = "A\|B"` | 选项列表，选中项会被**存为结果** | 改写运行时数据 |

且它**同时漏了** `v2GetAlertSelect.display`（真正显示给玩家的那句提示语）——
即按形状匹配是「扫错了字段」，不只是「多翻了一点」。

### 4.2 白名单依据

依据 RisuAI 上游 `src/ts/process/triggers.ts`（[kwaroran/RisuAI](https://raw.githubusercontent.com/kwaroran/RisuAI/main/src/ts/process/triggers.ts)）中的 `triggerEffectV1 | triggerEffectV2` 联合类型，逐个 type 判断哪个字段承载**玩家可见文案**：

```ts
// card.ts:1407
const RISU_TRIGGER_COPY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  v2Impersonate: ['value'],            // 打进聊天的消息
  v2SystemPrompt: ['value'],           // 注入的系统提示词
  v2ShowAlert: ['value'],              // 弹窗正文
  v2SetAuthorNote: ['value'],          // 作者注记（渲染进提示词）
  v2SetReplaceGlobalNote: ['value'],   // 全局替换注记
  v2GetAlertSelect: ['display'],       // ← 按 display，不是 value
  impersonate: ['value'],              // v1 同义
  systemprompt: ['value'],             // v1 同义
  showAlert: ['value'],                // v1 同义
};
```

> 设计取向与仓库既有约定一致：`scanStPreset()` 的注释明确写着
> *"this scanner uses an explicit allowlist of the only two fields that hold user-visible copy"*。
> Risu 模块扫描器此前是唯一还在用「通用遍历 + 事后排除」的异类。

### 4.3 `valueType` 守卫

```ts
// card.ts:1440
export function risuTriggerEffectCopyField(module, path): string | null {
  if (!isRisuTriggerEffectFieldPath(path)) return null;
  const parts = path[0] === '$module' ? path.slice(1) : path;
  const effect = getAt(module, ['trigger', parts[1], 'effect', parts[3]]);
  ...
  const fields = RISU_TRIGGER_COPY_FIELDS[type];
  if (!fields || !fields.includes(field)) return null;
  if (record[`${field}Type`] === 'var') return null;   // ← 变量名，永不翻译
  return field;
}
```

上游 schema 里每个可取值字段都配一个同名 `*Type` 标志（`value`/`valueType`、`display`/`displayType`、`source`/`sourceType`…），
值为 `"var"` 时运行时代码走 `getVar()` 而非字面量。这一条守卫同时覆盖 v2 的全部类型，**与白名单正交**。

### 4.4 三处改动

| # | 位置 | 内容 |
| --- | --- | --- |
| 1 | `card.ts:367`（`scanRisuModule().visit()`） | 在白名单命中时把整段纯文本作为 `script-ui` / `field` 收集；若含标记则仍走原 `extractVisibleText()`，**不改变既有行为** |
| 2 | `card.ts:1407–1450` | 新增 `RISU_TRIGGER_COPY_FIELDS`、`isRisuTriggerEffectFieldPath()`、`risuTriggerEffectCopyField()` |
| 3 | `card.ts:3023`（`isProtectedStoredPath()`） | 形状豁免，见 §4.5 |

改动 1 的完整代码：

```ts
// card.ts:361
// RisuAI trigger copy. `trigger` makes `isGenericProtectedPath()` reject the
// generic branch below, and the message usually carries no markup for
// `extractVisibleText()` to find, so without this branch player-visible text
// is dropped at every scope. Only allowlisted effect fields qualify: a bare
// `value` on any other effect type is runtime data, not copy.
if (risuTriggerEffectCopyField(module, path)) {
  const extracted = extractVisibleText(value, path, 'script-ui');
  if (extracted.length) extracted.forEach(add);
  else if (!/[<>]/u.test(value)) add(fieldSegment(path, value, 'script-ui', 'medium'));
  return;
}
```

**分支位置很关键**：它位于 `if (scope === 'lua-only' && !luaCode) return;` **之后**，
因此 `lua-only` 范围不会命中（触发文案不是 Lua），`standard` 也不会命中——
与 `visible-scripts`（"包含脚本按钮/弹窗"）的语义一致。

### 4.5 应用与导出按模块上下文重新校验（审计后修正）

原方案对 `trigger[n].effect[m].<任意字段>` 作路径形状豁免，该方案已撤销。
“扫描器目前不会生成非法行”不能替代存量审核行的保护检查。调用方已经读取
`originalModule`，可以显式传入；原来的两参数接口不是无法改变的限制。

现行 `isProtectedStoredPath(kind, path, module?)` 对非 Lua code 的 effect 字段重新检查
类型、字段和 `*Type`；没有模块上下文时默认保护。这一检查也覆盖 `text-node`、
`button` 等范围行，防止历史 HTML 提取结果绕过变量保护。Lua code 继续使用专用规则，
不会因新增白名单而屏蔽合法 Lua 字符串。

应用阶段用原始模块校验审核行；领域写回也复核触发器字段。导出阶段分别检查卡片和
模块的原文、草稿与已审核行，发现旧的受保护字段写入时拒绝导出。
保存会从原始模块恢复这些仍有已审核行记录的受保护字段，再应用合法译文；保留模块
草稿的其他改动。该恢复并非无审核行记录情况下的全模块差异修复。

---

## 5. 验证证据

### 5.1 构建与测试

```
npm run build   → exit 0（typecheck + vite build + tsc server 全部通过）
npm run typecheck → exit 0
npm test        → tests 361 / pass 360 / fail 1
聚焦：npx tsx --test tests/card.test.ts tests/protected-stored-path.test.ts
                → tests 97 / pass 97 / fail 0
```

### 5.2 真实卡片扫描（修复后）

```
scope=visible-scripts  total=24  trigger=5
scope=all-visible      total=24  trigger=5
scope=all              total=25  trigger=5
scope=standard         total= 7  trigger=0   ← 符合语义
scope=lua-only         total= 0  trigger=0   ← 符合语义
```

### 5.3 那 1 个失败测试与本次无关（证明）

失败测试：`tests/export-service-namespace.test.ts:296`
`preset export enforces compatibility while archive remains available and matches the UI report`
— `AssertionError: Missing expected rejection`（期待 `PRESET_CONVERSION_UNSUPPORTED` 却未抛出）。

证明方式：**把本次新增的 3 处改动全部临时还原后，单独复跑该文件，仍然同样失败**。
该测试属工作区中未提交的 ST 预设转换 WIP，与 Risu 模块扫描无调用关系。

### 5.4 全语料影响面（关键证据）

对 `data/storage/projects` 下 **97 个含 Risu 模块的项目**（91 charx + 6 risum）跑 `scanRisuModule(module,'all')`，
分别在「触发器分支启用」与「临时禁用」两种状态下导出全部 segment 身份再对比：

```
项目 97 个（含 Risu 模块）
基线 segments:   43102
修复后 segments: 43107
新增 5 条，删除 0 条
有变化的项目:  606f3270  +5  -0        ← 仅禁忌乐园
```

新增的 5 条正是该卡的 5 条触发文案；**其余 96 个项目输出逐字节不变**。
这仅证明第一轮修复对该批样本的扫描差异，不能证明所有卡片和边界情形安全；补充审计发现的反例见 §10。

### 5.5 变异测试（证明测试不是空转）

临时把新分支改成恒不命中（`if (false && risuTriggerEffectCopyField(...))`）后复跑：

```
✖ Risu trigger copies are scanned instead of being dropped as script paths
✖ Risu trigger condition operands stay protected while effect copy translates
✖ Risu trigger copy allowlist covers player-visible fields only
tests 97 / pass 94 / fail 3
```

即 3 条新测试确实锚定了行为，不会「无论代码怎样都通过」。

### 5.6 交付卡片校验

```
禁忌乐园 - Forbidden Paradise.zh-CN.fixed.charx
sha256 5bf88f38455f6233b613d0195c3a7f8ec01584268d5b78e239c4c530ff042f18
卡名 禁忌乐园 | 模块 禁忌乐园模块 - Forbidden Paradise Module | 资源 93 | 混合载体 true
  trigger A  "🕊️ 已选择学校里平凡的模范生。"
  trigger B  "🍑已选择怀孕优化身材。"
  trigger C  "😈呜嗡嗡~ 已选择萝莉体型。"
  trigger D  "💉 已选择危险的阴暗处。"
  trigger E  "🎲 随机（听天由命）"
  <div class="info-sub">$4岁 · $5</div>        （原文 $4세）
```

---

## 6. 已知边界与有意不做

| 项 | 处理 | 理由 |
| --- | --- | --- |
| `v2Comment.value` | **不扫** | 作者注释，玩家看不到 |
| `v2GetAlertSelect.value` | **不扫** | 选项既当按钮标签又当**存回变量的结果值**；替换会改运行时数据。要本地化需「追加别名」机制（类似世界书 `keys`），当前无此设施 → **该弹窗按钮会保持原文，属已知可见遗漏** |
| `v2RunLLM` / `v1 runLLM` / `runAxLLM` | **不扫** | 面向子模型、非玩家可见 |
| `v2ImgGen` / `runImgGen` | **不扫** | 绘图提示词，改动会改变出图 |
| `v2ModifyChat.value` | **不扫** | 位置索引 + 数据，典型用法非文案 |
| `v2SetCharacterDesc` / `v2SetPersonaDesc` | **不扫** | 写运行时描述，用法歧义；宁缺勿错 |
| 含 `<` `>` 的 trigger 文案 | 走原 HTML 提取 | 不改变既有行为，避免把标签汤整段喂给模型 |
| `standard` / `lua-only` 范围 | 不含触发器文案 | 触发器属脚本按钮/弹窗语义 |

---

## 7. 相邻但**未修**的问题：`module.regex[].out`

排查同类缺口（「纯文本被丢给只认 HTML 的提取器」）时，对全部 114 个已导入项目做了扫描，
**去掉 CSS/HTML 注释、CBS 宏外壳后**，真正命中的只有 `module.regex[].out`，共 **39 处 / 10 个项目**；
`card.customscript[].out`、`module.backgroundHTML`、`card.backgroundHTML` **命中 0 处**。
（首轮粗筛曾报 35 处 backgroundHTML，事后确认全是 `<style>` 里的韩文注释，属误报。）

**结论是这 39 处不能顺手用「统一兜底」修**，理由：

1. **词形校正对（29 处）**：如 `in: 아셴트 → out: 아셴테`、`in: 역세계 → out: 반전세계`，
   `in`/`out` **两侧都是源语言**，作用是统一译名写法。中文卡里 `in` 匹配不到中文正文，规则本身已失效；
   正确做法是 **in/out 成对本地化**（给 `in` 追加中文并列项，同时替换 `out`），
   而现有 `applyRisuRegexAlternativeProposals()` 只追加 `in`。
2. **CBS 宏模板（10 处）**：如
   `{{#if {{equal::{{getvar::gks_panel_state_yuki}}::사망}}}}$1사망 / 영구 사망 고정{{/if}}`
   其中 `사망` 既是**比较操作数**（不可动）又出现在**可见替换文字**里。整字段翻译会破坏比较 → 规则静默失效。
3. **现有设计已把 `out` 定为只读上下文**：`collectRegexLanguageEntries()` 读出 `out` 仅用于让模型判断 `in` 的并列项，
   写回路径 `appendRegexLiteralAlternatives()` 只改 `in`，**从不重写 `out`**——这是有意的安全边界。

明细见 `docs/同类漏翻面-受影响卡片清单.md`。
要覆盖它需要独立功能（regex in/out 成对本地化 + CBS 外壳感知），风险与工作量与本次不同。

---

## 8. 建议审计者重点质疑

1. **白名单完整性** — 是否还有承载玩家可见文案的 effect 类型被漏掉？
   可疑候选：`v2ModifyChat.value`（改写既有聊天内容时其实也是可见文本）、
   `v2SetCharacterDesc` / `v2SetPersonaDesc`、`v2RunLLM.value`。
   判断依据应为 `kwaroran/RisuAI/triggers.ts` 的完整 `triggerEffectV2` 联合类型。
2. **白名单正确性** — 已列入的 9 项是否**真的**都是可见文案？特别是
   `v2SetAuthorNote` / `v2SetReplaceGlobalNote`（进提示词但不直接显示）。
3. **`*Type === 'var'` 守卫是否完备** — 上游是否存在守卫字段命名不规则（非 `<field>Type`）的类型？
4. **`isProtectedStoredPath()` 形状豁免是否过宽** — 该豁免对 `trigger[n].effect[m].<任意字段>` 生效。
   §4.5 论证了「历史行不存在」，请复核该论证是否成立（尤其考虑未来白名单收缩时的语义）。
5. **`!` 标记值走 HTML 提取** — 含 `<` `>` 的 trigger 文案会被拆成多个 `text-node` 片段（实测 `학교` / `선택` 两段）。
   该行为与改动前一致，但请注意它**未**被本次改动改善。
6. **过滤链是否吞掉合法文案** — `add()` 里还有 `likelyNeedsTranslation()`、`isControlLiteralSegment()` 两道过滤，
   若某条触发文案恰好等于某条正则的控制字面量，会被静默跳过。是否为预期？
7. **测试强度** — `'Risu trigger runtime data never becomes a translation candidate'` 断言的是「什么都没扫到」，
   在把分支整体删掉时**依然通过**。它与 `'…allowlist covers player-visible fields only'` 必须成对存在才有意义（§5.5）。
8. **重扫历史项目的行为** — 已导入项目重新扫描时，新出现的 5 条会成为 `untranslated` 待办；
   但若该项目此前已应用过草稿，`applyProject()` 会从 `original_json` + 已通过行重建卡片草稿，
   **0 条已通过 = 卡片正文回退到原文**。这是既有风险（§见下方注），不是本次引入，但会被本次改动触发。
9. **`risum` 格式项目** — 改动对 `.risum`（非 charx）同样生效，确认没有单独路径绕过。

> 注（第 8 点）：该风险已在交付时提示过用户。`exportProject()` 使用存量 `draft_json`，**只导出不保存是安全的**；
> `applyProject()` 才会重建。审计时可确认是否需要额外防护。

---

## 9. 复现脚本

| 脚本 | 用途 |
| --- | --- |
| `tmp/card-analysis/verify-fix.ts` | 对真实卡 module 打印各 scope 命中的 trigger 段 |
| `tmp/card-analysis/probe-effect-types.ts` | 用真实 RisuAI effect 形状验证白名单 |
| `tmp/card-analysis/self-review.ts` | 对抗式自查：v1/v2 类型、结构异常、路径解析、守卫边界 |
| `tmp/card-analysis/corpus-delta.ts` | 全语料导出 segment 身份快照（§5.4） |
| `tmp/card-analysis/corpus-diff.ts` | 对比两份快照，输出 新增/删除 计数 |
| `tmp/card-analysis/verify-delivered.ts` | 校验交付 charx 的触发文案与残留文本 |

运行方式：`npx tsx <脚本路径>`（需在仓库根目录，依赖本地 `node_modules`）。


---

## 10. Codex 复核后的补充修复（2026-09-14）

### 10.1 审计结论与实际改动

原始纯文本漏翻的根因正确，保留按 effect 类型白名单的方向，并修复以下五项：

| 问题 | 补充修复 | 回归证据 |
| --- | --- | --- |
| 存储路径形状豁免放行 `type`、`role`、`valueType` 等运行时字段 | 应用与导出传入原始模块重验；无模块上下文默认保护；专用 Lua 提取保留 | 非法 field 行和变量 text-node 行均不写回；合法输入框提示可应用 |
| `valueType: var` 返回空后仍进入 HTML 兜底 | effect 非 code 字段统一经过白名单；拒绝后立即结束该字段扫描 | `<b>변수 이름</b>` 变量名和按钮形状运行时数据不生成候选 |
| `안녕하세요 {{button::선택하기::go}}` 只提取按钮 | 无 HTML 的混合文本先排除完整 CBS 宏与已提取范围，再提取剩余正文 | 问候语、按钮文字、条件宏外正文均翻译；`go`、嵌套条件比较操作数和宏外壳不变 |
| 漏了 `v2GetAlertInput.display` | 加入白名单，遵循 `displayType: var` 保护 | 三个脚本文案范围均扫描并写回；原有 standard / lua-only 范围不扩张 |
| `constructor` 等 effect 类型命中对象原型属性，触发 `fields.includes` 异常 | 使用 `Object.hasOwn` 检查白名单自有键 | `constructor`、`toString`、`__proto__`、未知类型均跳过，后续合法文案照常扫描 |

涉及文件：

- `server/domain/card/card.ts`：扫描、正文提取、白名单查找、领域写回保护、旧模块草稿保护恢复。
- `server/application/export/export-service.ts`：应用时传入原始模块；保留其他模块草稿改动；导出增加模块旧写入检查。
- `tests/card.test.ts`：新增 4 个回归测试，覆盖扫描、宏保护、审核状态及写回。
- `tests/protected-stored-path.test.ts`：修正原形状豁免断言；新增服务集成测试。

### 10.2 服务成功、保护失败与保存失败验证

使用测试创建的临时数据库和合成模块，不读取真实项目数据：

1. 模块旧草稿的 `role` 和变量引用被旧审核行错误翻译时，导出返回 `PROTECTED_PATH_STALE_DRAFT`。
2. 保存忽略非法行，恢复原始受保护字段，应用通过审核的输入框提示，保留其他模块草稿编辑；随后允许导出。
3. 用测试 SQLite 触发器模拟保存写入失败，确认卡片和模块草稿均保持保存前内容，没有落下部分修复结果。
4. 未通过审核的混合正文行不应用；Lua 字符串及其他既有领域回归仍通过。

### 10.3 验证结果与交付边界

- 补充修复前：相关测试 97/97；全量 360/361，预设兼容导出测试失败。
- 补充修复后：全量 `npm test` **366 项 / 365 通过 / 1 失败**，新增 5 项均通过。
- 唯一失败仍是 `tests/export-service-namespace.test.ts:296` 的预设兼容导出断言，错误为 `Missing expected rejection`。补充修复前后均复现；本轮未修改该测试或解决预设兼容功能。
- `npm run build` **通过**：TypeScript 检查、Vite 前端构建与服务端编译均成功。
- 未运行真实卡片全语料脚本，未更新第一轮交付的 CHARX，不把 §5 的历史语料统计视为本轮验证。
- 未读取 `.env`、真实项目 `data/`、备份或远程配置，未启停 8787，未部署、提交 Git 或覆盖其他代理的功能改动。
- `regex[].out`、完整 HTML/CBS 解析、无审核行记录的历史误改修复、卡片正文重建风险继续作为独立问题处理。包含 `<` / `>` 的白名单文案仍走原有 HTML 提取。

---

## 11. 第二轮独立验证与补充修复（2026-09-14 晚）

第一轮交付方（DSH）对 §10 的补充修复做了**独立复验**，不采信文档结论，全部重新实测，并追加一处兜底修复。

### 11.1 独立复验结果

| 检查项 | 方法 | 结果 |
| --- | --- | --- |
| 构建 | `npm run build` | 通过（exit 0） |
| 聚焦回归 | `npx tsx --test tests/card.test.ts tests/protected-stored-path.test.ts` | **103 / 103 通过** |
| 全语料：本轮 vs **原始基线**（`risuTriggerEffectCopyField` 恒返回 null） | 97 个含模块项目，`scanRisuModule(module,'all')` 全量对比 | **新增 5 / 删除 0**，仅 `606f3270`（禁忌乐园）变化 |
| 全语料：本轮 vs 第一轮交付版本 | 同上 | **0 / 0，逐条完全相同** |
| 真实卡扫描 | `verify-fix.ts` | `visible-scripts` / `all-visible` / `all` 各命中 5 条；`standard` / `lua-only` 为 0 |
| **存量项目导出回归** | 遍历 8787 API 的 114 个项目，对其已审核且 `kind ∈ {field, structured-text, protocol-field}` 的行重新求值 `isProtectedStoredPath()` | 读到 112 个有 segment 的项目，**新增导出保护误伤 0 个** |

**关键复现：`Object.hasOwn` 修复对应的是一个真实崩溃。** 在修复前的版本上，下列 effect 类型全部抛异常：

```
type=constructor / toString / __proto__ / hasOwnProperty / valueOf / isPrototypeOf
  -> TypeError: fields.includes is not a function
```

原因是 `RISU_TRIGGER_COPY_FIELDS` 为对象字面量，`map['constructor']` 命中的是 `Object` 构造函数而非 `undefined`。
该异常发生在 `POST /scan` 路径上，会导致扫描整体 500。修复后六种类型均安全跳过并返回 0 条候选。

**CBS 宏行为实测（本轮）**：

> 以下为当时有限样例，不能推广为所有宏内候选均受保护。条件操作数中的按钮和未闭合宏内按钮曾绕过过滤；该遗漏已在 §12 修复。

```
당신은 {{getvar::name}} 로 선택되었습니다.                 -> 提取 "당신은"、"로 선택되었습니다." 两段，宏本身不进候选
{{#if {{equal::{{getvar::st}}::사망}}}}사망 처리{{/if}}     -> 只提取 "사망 처리"，宏内比较操作数 사망 不提取
당신은 {{getvar::name 로 선택되었습니다.                    -> (无)，不闭合宏 fail-closed
```

### 11.2 补充修复：`moduleBase` 兜底

`export-service.ts` 的 `moduleBase` 在本轮补充修复中由

```ts
const moduleBase = existingDraftModule || originalModule;
```

改为 `existingDraftModule && originalModule ? restore(...) : originalModule`。
当项目存在 `draft_module_json` 但 `original_module_json` 为空时，该写法会退回 `null`，
随后把 `draft_module_json` 写成 `null`，**静默丢弃模块草稿**。

已改为保留草稿兜底：

```ts
const moduleBase = existingDraftModule
  ? (originalModule
    ? restoreProtectedModuleDraft(originalModule, existingDraftModule, segments)
    : existingDraftModule)
  : originalModule;
```

新增回归测试 `a module draft without a stored original module survives a save`
（`tests/protected-stored-path.test.ts`）。**变异验证**：把该行改回上述 `&&` 写法后，
该测试立即失败（`draft_module_json` 变为 `null`），说明测试确实锚定了行为。

触发条件很窄（正常导入流程会同时写入两者），属防御性修复，不影响任何现有项目。

### 11.3 验证环境说明（重要）

采集全量 `npm test` 结果时，工作区存在**另一个进程正在并发编辑** ST 预设相关文件：

```
21:00:12  export-service.ts            ← 本次修复
21:02:48  st-preset-convert.ts         ← 外部进程（本次构建恰好读到中间态，曾报 TS2741）
21:04:41  st-macro-map.test.ts         ← 外部进程
21:07:33  preset-capability.ts         ← 外部进程
21:07:56  st-macro-map.ts              ← 外部进程
```

因此**全量套件的数字是移动目标**，本节不作交付依据。判定与本次改动无关的证据：

1. 外部进程开始编辑（21:02:48）之前，全量为 **366 / 365 通过 / 1 失败**，唯一失败是既有的
   `tests/export-service-namespace.test.ts:296`。
2. 之后的失败全部落在 `preset-capability.test.ts` 与 `st-preset-compatibility.test.ts`，
   对应源码即上表被并发编辑的文件，与 Risu 模块触发器扫描无调用关系。
3. 本节改动的两个文件（`server/domain/card/card.ts`、`server/application/export/export-service.ts`）
   在 `tsc -p tsconfig.server.json --noEmit` 下**零报错**。
4. 聚焦测试 103/103 通过，与并发编辑无关。

**复核本节结论时，请先确认工作区无其它代理在写入，再重跑 §11.1 的命令。**


---

## 12. 宏内按钮与未闭合宏保护修复（2026-09-15）

### 12.1 复核发现

`extractRisuTriggerCopy()` 先调用通用 `extractVisibleText()` 提取按钮，之后只对新增正文排除宏范围，
没有过滤已经提取出来的按钮。实测下列两个字段都会生成 `선택하기` 候选，领域写回也会修改它：

```text
{{#if {{equal::{{getvar::state}}::{{button::선택하기::go}}}}}}안녕하세요{{/if}}
안녕하세요 {{getvar::name {{button::선택하기::go}}
```

因此 §11 对“宏内不提取、未闭合宏不提取”的概括不完整；这是 §10 补丁遗漏的边界。

### 12.2 实际修改

- `server/domain/card/card.ts`：触发器提取先收集最外层宏范围，再过滤所有通用提取候选。
  位于宏内的候选默认拒绝；只有完整、独立的按钮宏内的标签范围可以保留。
  因此条件表达式内部嵌套的按钮不会被误认为玩家可见按钮，条件块正文中的按钮仍可翻译。
- `templateMacros()` 增加可选 `includeIncomplete` 参数，只由触发器提取开启：未闭合宏从开头到字段末尾
  全部保护，包含其中的按钮、HTML 属性和文本候选。其他调用者保持原有默认行为。
- HTML 提取结果也经过上述宏边界过滤，不会通过 HTML 分支提前返回而绕过检查。
- 未闭合宏前面的明确正文仍可翻译；不闭合部分保持原样。本轮不是宏语法自动修复。
- `tests/card.test.ts` 新增 2 项回归测试，覆盖纯文本与 HTML、三个脚本文案范围、扫描与审核后领域写回。

### 12.3 验证结果

- `npx tsx --test tests/card.test.ts tests/protected-stored-path.test.ts`：**105/105 通过**。
- `npm test`：**376 项 / 375 通过 / 1 失败**。唯一失败仍为
  `tests/export-service-namespace.test.ts:296` 的预设兼容导出测试，`Missing expected rejection`；
  修改前复核结果为 374 项 / 373 通过 / 同一个失败。
- `git diff --check -- server/domain/card/card.ts tests/card.test.ts`：通过。
- `npm run build`：**通过（exit 0）**，包括 TypeScript 检查、Vite 前端构建和服务端编译。

### 12.4 范围与限制

本轮只修改扫描提取逻辑、回归测试及本文档；未读取真实项目数据、未启停 8787、未部署或提交 Git。
没有全语料或真实 CHARX 重新交付验证。此前已存在的错误候选和已经写入的译文不会因扫描器更新自动消失，
本轮不包含旧数据迁移。宏内的复杂可见表达式按保守规则跳过，不宣称完整支持全部 CBS 语法。
