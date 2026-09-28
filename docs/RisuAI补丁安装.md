# RisuAI 补丁安装

“插件与补丁”页是工作台自带页面，不需要另装网页。先按 RisuAI 所在位置选择“本机 RisuAI”“远程 RisuAI”或“只有网页权限”。页面按“补丁安装功能 → 桥接与预设 → 按需补丁”展示。补丁安装功能是运行在 RisuAI 所在电脑或服务器上的安装器，不是 RisuAI 插件；桥接插件可通过 RisuAI 网页直接导入。

## 网页安装的首次接入

浏览器插件没有服务器文件权限。工作台和 RisuAI 在同一台机器时，完成以下一次性接入，后续补丁都在网页上操作：

1. **Docker**：在工作台 `.env` 中设置 `RISUAI_PATCH_HOST_PATH` 为 RisuAI 源码或安装目录的宿主机绝对路径。首次接入使用 `docker/compose.patch.yml` 作为附加配置：

   ```text
   docker compose -f docker/compose.yml -f docker/compose.patch.yml up -d --build
   ```

   容器内挂载到 `/app/risuai`。运行工作台的容器用户必须对目标文件有写入权限。工作台仍只通过原有的回环端口提供网页。
2. **本机桌面版**：启动工作台桌面版，打开“插件与补丁”→“本机 RisuAI”→“选择本机 RisuAI 文件夹”。桌面版自带补丁脚本，目录只需选择一次，备份默认放在工作台私有数据目录。普通浏览器运行的工作台没有本机文件选择权限，可下载 Windows 安装包。
3. 选择补丁、预检，通过后点“安装补丁”。安装器备份、写入、回读，失败时回滚本次变更。

如果 RisuAI 在另一台服务器上，本机工作台可通过下文的 SSH 页面选择 Docker 容器或裸部署目录并安装固定补丁；也可下载远程安装包，在服务器上离线运行。普通浏览器本身没有远程文件权限，SSH 页面仅在本机回环地址的工作台或桌面版启用。

当前页面没有“上传补丁 ZIP 后安装”的接口。网页安装代理只调用工作台内置的固定补丁脚本，并且必须显式启用且能访问 RisuAI 目标目录；下载的 ZIP 用于在 RisuAI 所在环境离线执行。页面不再提供“已自行核验”勾选框，因为它原先只记录本机浏览器时间，不能证明目标文件已预检或安装成功。

服务器上试用时可以把运行中 RisuAI 文件复制到独立测试目录，并给工作台设置 `WORKBENCH_PATCH_TEST_MODE=1`。页面会明确标记测试副本；此时预检和安装都只修改副本，不会使运行中的 RisuAI 生效。正式部署须另行处理当前容器的程序文件、重启和版本更新后的重新预检。

远程首次接入不能被纯网页完全省掉：网页没有远程主机的文件系统权限，也不应代替用户保存 SSH 密码。补丁后的构建、服务重启和实际浏览器验证仍按目标部署流程执行。

当前可直接下载页面提供的 `risuai-cardloom-remote.zip`，解压到远端后执行：

```text
bash risuai-cardloom-remote/install-linux.sh
```

脚本自动搜索常见 RisuAI 目录，多个目录时按编号选择，再选择桥接插件或补丁。每项先预检，确认目标后输入 `INSTALL` 才应用。需要 Bash 和 Node.js 18+；没有 Bash 的 Docker 容器继续使用下列 Node 参数入口：

```text
node risuai-cardloom-remote/install-remote.mjs --root /app --mode bridge
node risuai-cardloom-remote/install-remote.mjs --root /app --mode bridge --apply
node risuai-cardloom-remote/install-remote.mjs --root /app --mode patch --patch preset-switch
node risuai-cardloom-remote/install-remote.mjs --root /app --mode patch --patch preset-switch --apply
```

Docker 可以先用 `docker cp` 把目录复制进容器，再用 `docker exec` 执行同一入口。包默认自动查找 RISUSAVE 和构建文件；多个构建并存时，使用 `--save-dir`、`--frontend`、`--server` 或 `--target` 指定目标。完整说明在远程包内的 `README.txt`。

本机 Windows 用户下载 `risuai-cardloom-windows-installer.zip`，解压后双击 `risuai-cardloom-remote/install-windows.cmd`。需要 Node.js 18 或更高版本。脚本自动查找常见 RisuAI 目录；若找到多个，按编号选择。确认预检结果后输入 `INSTALL` 才会写入。两种压缩包内容相同，区别是页面给出的使用入口。

## 新用户从哪里开始

1. **本机 RisuAI**：若需要补丁，使用上面的 Windows 安装包或桌面版工作台的目录选择；随后下载 `risu-bridge.plugin.js`，在 RisuAI 插件管理中导入并启用。
2. **远程 RisuAI**：使用远程安装包在服务器预检与应用所需补丁；可在 RisuAI 网页导入桥接插件。无法网页导入时，工具包中另有插件数据库安装脚本：

   ```text
   node bridge-plugin/install-risu-v2-plugin.cjs --plugin bridge-plugin/risu-bridge.plugin.js --save-dir /app/save
   ```

   脚本会先备份 RISUSAVE，并只处理插件相关区块。容器名、挂载路径和服务重启方式需要按实际部署填写。
3. **只有网页权限**：可在 RisuAI 插件管理中导入桥接插件及工作台导出的预设；源码或服务补丁需要服务器管理员执行安装器。只有导入提示不支持 API 2.1，或明确需要性能、缓存、图像路由等功能时，才应用对应补丁。

`bridge-plugin/install-risu-preset.cjs` 是管理员用的预设 JSON 数据库写入脚本。下载的桥接工具包内有 `README.txt`，远程安装包内有 `bridge-plugin/README-install.txt`。两者都附带命令和适用条件：

```text
node bridge-plugin/install-risu-preset.cjs --preset preset.json --save-dir /app/save
```

脚本只接收单个 **RisuAI 预设对象 JSON**，不能直接接收工作台导出的 `.risup`、整个存档 ZIP 或原始 SillyTavern 预设 JSON。运行时会立即备份并写入，没有预检模式；运行前须确保 RisuAI 没有并发写入。一般用户优先用 RisuAI 网页导入 `.risup`。

## 使用

先运行预检，确认目标文件和脚本锚点匹配：

```text
node patches/risuai/install.mjs --patch preset-switch --frontend <database.js>
node patches/risuai/install.mjs --patch read-performance --frontend <database.js> --server <server.cjs>
node patches/risuai/install.mjs --patch plugin-v21-import --target <plugins.svelte.ts>
```

预检生成临时结果并进行语法检查，不改目标文件。安装时在同一命令后加 `--apply --backup-dir <已有的私有备份目录>`。安装器会先准备所有目标文件的结果，再创建独立备份、替换、回读 SHA-256；出错时恢复本次已替换的文件。备份目录应位于公开静态资源目录之外。

页面的“下载补丁脚本”会把全部脚本放进一个 ZIP。下载不修改 RisuAI，安装时每次按 `--patch` 选择一项。一个补丁涉及多个文件或连续脚本时，安装器会先在临时副本上完成该项预定修改与预检，然后写回。它不是任意版本代码的自动合并；目标锚点不匹配就会停止，也不会替用户自动构建或重启。

补丁脚本目前按唯一代码锚点做局部替换；多步修改先在临时副本中组合，再进行语法检查。安装器最后会以原子替换方式写回整个目标文件，因此“局部替换”不等于完全避免同文件冲突。固定行号不适合构建后压缩文件；源码可考虑 AST/函数级转换，但仍要检查唯一目标、原代码特征和转换后的行为。对于未知新版、锚点缺失或其他补丁占用同一位置，停止并人工核对，不做模糊匹配或强制三方合并。

可选补丁名：`plugin-v21-import`、`preset-switch`、`api-profiles`、`image-router`、`read-performance`、`read-cache`、`list-cache`。`read-cache` 依赖 `read-performance`，`list-cache` 依赖读取链路；同一个目标构建上的其他补丁也须按实际锚点和安装记录确认顺序。模型列表与 API 配置档共用 `api-profiles` 脚本，旧的 `patch-custom-models.mjs` 是历史实现，不应重放。

`api-profiles` 当前版本支持新建、重命名、确认覆盖和确认删除配置档。安装器可从原始模型输入框、旧版模型列表或旧版配置档补丁升级；已安装当前版本时预检显示无需更改。删除配置档不会清空当前填写的 URL、Key 和模型。

`plugin-v21-import` 是源码补丁，应用后须重新构建 RisuAI。其余脚本针对特定已核对构建的产物；更新 RisuAI 后重新预检，不能把旧版本的成功记录当作当前兼容性证明。前后端文件的部署、服务重启、浏览器验证和远程回滚仍按目标实例的部署流程执行。入口代理缓存是配置变更，没有通用安装脚本，未纳入安装器。

## 本机工作台通过 SSH 管理远程补丁

将工作台桌面版或 Node 版运行在自己的电脑上，打开“插件与补丁”→“远程 RisuAI”→“通过 SSH 安装远程补丁”。选择 Docker 或裸部署，填写服务器地址、SSH 用户，并拖入私钥文件、选择文件或填写本机密钥绝对路径，然后扫描目标。SSH 密钥投放区不会触发全局卡片导入。Docker 模式列出 `docker ps` 中运行的容器供选择；裸部署会搜索 `/opt`、`/srv`、`/home`、`/var/www` 和 `/app` 下有限深度的 RisuAI 项目，也能手动输入绝对目录。连接字段和上次选择保存在本机浏览器的 localStorage；手填路径会保存，拖入密钥只传给本机回环工作台临时使用，不保存到浏览器，未连接时 30 分钟后或关闭工作台时删除，连接后在断开时删除。需预先用系统 SSH 命令记录并核对主机指纹，使用已有的免交互密钥登录；远程用户须具备免交互 `sudo`。Docker 模式还需要 Docker 管理权限、Docker Compose 与 `node:22-alpine` 镜像。服务器不需要另装工作台或开放新端口。

页面依次执行“连接所选目标 → 读取目标文件 → 选择文件 → 预检兼容性 → 确认安装”。多份 `index*.js` 并存时必须手动确认实际入口资源。Docker 预检读取当前运行镜像和文件 SHA-256，将固定脚本临时送入 SSH 会话，借助临时 Node 容器在文件副本上运行。源码补丁 `plugin-v21-import` 只在裸部署的源码目录可选，应用后仍需自行构建。

只有匹配的预检产生一次性安装令牌（15 分钟有效）。Docker 安装再次核对原镜像与文件哈希，在副本上应用补丁、备份原 Compose 文件、标记旧镜像、构建派生镜像，然后通过原 Compose 项目和附加 override 切换服务。新容器无法启动或健康检查失败时自动用旧镜像重建并报告错误；备份保存在服务器的 `/opt/cardloom-patch-backups/`。RISUSAVE 挂载保持原样。1Panel 后续单独重建/升级可能丢失 override 效果。

裸部署要求服务器已有 Node.js 18+。服务仅接受识别为 RisuAI 的目录及其中固定位置的源码、前端或服务文件；安装前再次核对哈希，安装器在 `/opt/cardloom-patch-backups/` 下备份并回读目标。此模式只改文件，需按项目的实际部署方式重新构建或重启，再在网页验证。两种模式升级后都必须重新预检。

此 SSH 页面仅在监听本机回环地址的工作台或桌面版中启用；Docker/公网工作台不会开放远程执行入口。如不希望本机也出现该入口，可设置 `WORKBENCH_REMOTE_PATCH_AGENT=0`。不要把私钥内容粘贴进路径输入框；拖入或选择文件会通过本机上传暂存，重启后需要重新选择。
