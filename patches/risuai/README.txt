RisuAI 补丁脚本包

这个 ZIP 一次下载全部已收录的补丁脚本和安装器；下载本身不修改 RisuAI。
安装器每次通过 --patch 选择一项补丁，并在指定的目标源码或构建文件上应用该项预定修改。涉及前后端或同一文件多个脚本时，它会先在临时副本中按固定顺序运行全部脚本，检查版本锚点和语法，再给出预检结果。
这不是任意版本的代码自动合并，也不会自动构建、重启 RisuAI 或安装包里全部补丁。目标版本不匹配时会报错停止，需要重新核对补丁，不能强行覆盖。

先查看可选项：
  node patches/risuai/install.mjs --help

补丁依赖：资源清单缓存（list-cache）必须在远程读取性能（read-performance）与远程资源本地缓存（read-cache）均安装后执行。
预检和安装都会检查目标文件中的前置实现。跳过或缺失时提示先安装对应补丁，不写入任何目标文件；其他独立补丁没有强制顺序。

只读预检示例：
  node patches/risuai/install.mjs --patch preset-switch --frontend <database.js>
  node patches/risuai/install.mjs --patch api-profiles --frontend <index.js>

api-profiles 支持从旧版模型列表或配置档补丁升级，提供新建、切换、重命名、确认覆盖及确认删除。已是当前版本时不会重复修改。
若入口代理对带哈希的 /assets/ 文件设置了 immutable 缓存，安装后还须在备份 index.html 的前提下运行 remote/activate-cached-asset.mjs，为更新后的 index JS 生成新文件名并更新 HTML 引用；否则已有浏览器可能继续使用旧文件。

确认目标正确后，创建私有备份目录，在同一命令末尾添加：
  --apply --backup-dir <已有的私有备份目录> --manifest <服务器上的清单文件>

安装记录与卸载：
  node patches/risuai/patch-state.mjs status --root /path/to/RisuAI --manifest /opt/cardloom-patch-backups/manifest.json
  node patches/risuai/patch-state.mjs remove --id RECORD_ID --root /path/to/RisuAI --manifest /opt/cardloom-patch-backups/manifest.json
Docker 镜像安装记录与恢复（需管理权限）：
  bash /opt/cardloom-patch-backups/docker-history.sh history CONTAINER
  bash /opt/cardloom-patch-backups/docker-history.sh remove CONTAINER RECORD_ID EXPECTED_IMAGE_SHA256
文件恢复会检查目标与备份哈希、后续补丁和依赖。Docker 仅允许恢复当前记录镜像，配置变更时拒绝回滚；恢复失败会尝试恢复当前补丁镜像。
安装记录不等于运行验证：源码目录需要重建和部署；Docker 仅自动核对镜像与容器健康状态，实际网页行为仍需验证。
只有安装时传入 --manifest 才会记录；卸载会恢复清单中最近一次安装的备份。

写入前会为每个变更文件备份，写入后回读哈希；本次操作出错会尝试恢复已写文件。源码补丁应用后需重新构建；构建补丁或服务补丁应用后按部署方式重启并在浏览器核验。
