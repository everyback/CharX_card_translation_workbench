# AI 协作说明

## 项目定位

这是一个独立运行的卡片翻译工作台。它导入 JSON、PNG、CHARX 和 RISUM 格式的卡片或模块，扫描可翻译内容，调度模型请求，支持人工审核，并导出审核后的结果。

## 代码边界

- `config/`：配置默认值和环境变量校验。
- `server/domain/`：格式解析、保护规则、协议、Lua、资源和导出逻辑。优先在这里实现纯逻辑。
- `server/routes/`：HTTP 路由；新功能不要把大型解析或事务流程直接塞进路由处理器。
- `server/application/`：扫描重建、翻译任务、审核和应用/导出的事务编排。服务通过注入数据库、时钟和外部依赖来保证可测试性。
- `server/repositories/`、`server/db*.ts`：SQLite 访问、异步 Worker 和持久化。
- `server/scheduler.ts`：模型调度、批次、重试和任务状态。
- `src/app/`：应用级状态与协调；`src/features/`：功能页面；`src/components/`：通用组件。
- `tests/`：每次修改格式解析、保护规则、导出或调度时补充回归测试。

`server/index.ts` 负责组装依赖、注册路由和 HTTP 响应；扫描、任务创建、审核、应用和导出的事务编排放在 `server/application/`。新增工作流时优先扩展对应窄服务，并为成功路径、回滚路径和保护规则失败路径增加单元测试。

## 必须保持的行为

- 翻译先写入草稿，审核通过后才能应用或导出。
- 世界书原始触发词和结构键必须保留；目标语言别名只能以追加方式进入 `keys` / `secondary_keys`。
- Lua、正则、协议外壳、变量、路径、URL、ID、资源文件名和按钮触发器默认保护；只翻译明确可见文字。
- 语言、翻译范围、并发和批次大小不能写死为单一语言或固定上限。
- API Key 只在后端使用；不要写入日志、前端响应、构建产物或测试快照。
- 默认只绑定 `127.0.0.1`。除非用户明确要求并先补鉴权，不要改成公网监听。

## 本地验证

根据运行环境选择以下一组命令。不要读取或覆盖已有 `.env`；仅在它不存在时从示例文件创建。

### Windows PowerShell

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm ci
npm test
npm run build
npm audit --omit=dev --audit-level=high
docker compose -f docker/compose.yml config
docker compose -f docker/compose.yml up -d --build
Invoke-WebRequest http://127.0.0.1:8787/api/health
```

端口被占用时：

```powershell
$env:WORKBENCH_BIND_PORT = '18880'
docker compose -f docker/compose.yml up -d --build
Invoke-WebRequest http://127.0.0.1:18880/api/health
Remove-Item Env:WORKBENCH_BIND_PORT
```

### Linux shell

```bash
[ -f .env ] || cp .env.example .env
npm ci
npm test
npm run build
npm audit --omit=dev --audit-level=high
docker compose -f docker/compose.yml config
docker compose -f docker/compose.yml up -d --build
curl --fail --silent --show-error http://127.0.0.1:8787/api/health
```

端口被占用时：

```bash
WORKBENCH_BIND_PORT=18880 docker compose -f docker/compose.yml up -d --build
curl --fail --silent --show-error http://127.0.0.1:18880/api/health
```

部署操作请看 [docs/部署说明.md](./docs/部署说明.md)。本文件只描述公开代码边界，不记录本机路径、账号、服务地址或密钥。

## 敏感数据

不要读取、提交或输出 `.env`、`data/`、`backups/`、SQLite 文件、远程配置和真实 API Key。需要调试配置时只报告是否配置、模型名和脱敏后的元数据。

## Git 提交

- 每个提交只覆盖一个明确目的；提交前先检查暂存区，不能把用户的无关改动一并提交。
- 提交标题必须使用 `类型: 中文说明` 格式；类型限于 `update`、`fix`、`new feature`、`docs`、`remove`、`refactor`、`test`、`build`、`ci`、`perf`、`style`、`chore`，不用 `WIP` 或泛泛说明。
- 提交前运行与改动相称的测试，并在提交或交付说明中记录实际执行的验证。
