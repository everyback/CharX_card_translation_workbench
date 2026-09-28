CardLoom Translate · RisuAI 远程安装包

1. 把整个 risuai-cardloom-remote 文件夹复制到 RisuAI 所在的服务器。
2. 服务器需要 Node.js 18 或更高版本。Docker 用户可以把本目录挂载或复制到容器里。
3. 先执行只读预检，再决定是否加 --apply 写入。

Linux Bash 交互安装：
  1. 把完整的 risuai-cardloom-remote 文件夹放到 RisuAI 所在服务器。
  2. 在文件夹的上级目录运行 bash risuai-cardloom-remote/install-linux.sh。
  3. 选择 RisuAI 目录、桥接插件或补丁，核对预检结果后输入 INSTALL。
  4. 自动搜索不到时可指定目录：
     bash risuai-cardloom-remote/install-linux.sh --root /path/to/risuai

Linux / macOS 手动参数模式（容器没有 Bash 时使用 Node 入口）：
  ./install-remote.sh --root /path/to/risuai --mode bridge
  ./install-remote.sh --root /path/to/risuai --mode bridge --apply
  ./install-remote.sh --root /path/to/risuai --mode patch --patch preset-switch
  ./install-remote.sh --root /path/to/risuai --mode patch --patch preset-switch --apply

Windows PowerShell:
  .\install-remote.ps1 --root C:\RisuAI --mode bridge
  .\install-remote.ps1 --root C:\RisuAI --mode bridge --apply

Windows 双击安装（推荐）：
  1. 双击 install-windows.cmd。
  2. 安装器会在当前用户目录、AppData、Program Files 和常见 RisuAI 目录中自动搜索。
  3. 选择“桥接插件”“源码补丁”或“两者都安装”。
  4. 先看只读预检；确认目标正确后输入 INSTALL，才会备份并写入。
  5. 如果找到多个目录，按编号选择；也可以把目录拖到命令行入口，或运行：
     powershell -ExecutionPolicy Bypass -File .\install-windows.ps1 -Root C:\RisuAI

Windows 脚本需要 Node.js 18 或更高版本。安装包无法替用户安装运行时；如果双击提示找不到 Node.js，先安装 Node.js LTS。

Docker:
  docker cp risuai-cardloom-remote <容器名>:/tmp/cardloom
  docker exec -it <容器名> bash /tmp/cardloom/install-linux.sh --root /app
  docker exec <容器名> node /tmp/cardloom/install-remote.mjs --root /app --mode bridge

说明：
- 默认只预检，不修改 RisuAI；确认输出后再加 --apply。
- 自动搜索只检查有限深度的常见目录，不扫描整块磁盘；无法确定时要求显式指定 --root。
- Linux Bash 脚本需要 Bash 和 Node.js 18+；标准输入非交互或自动化场景可传 --root、--mode、--patch 与 --apply。
- 桥接插件会自动查找 RISUSAVE；找不到时用 --save-dir 指定。
- 补丁目标会自动查找；多个构建并存时用 --frontend、--server 或 --target 指定。
- 补丁备份默认放在 RisuAI 目录旁边的 <目录名>-cardloom-backups，可用 --backup-dir 改变。
- 不要删除备份，升级 RisuAI 前先重新预检。

预设写入工具（管理员手动操作）：
- 详细步骤见 bridge-plugin/README-install.txt；它不属于上面的桥接/补丁交互安装选项。
- 仅接受单个 RisuAI 预设对象 JSON；工作台导出的 .risup 应优先在 RisuAI 网页导入，不能直接传给脚本。
- 确认 RisuAI 没有同时写入存档后，按实际位置替换 preset.json 和 /app/save：
  node bridge-plugin/install-risu-preset.cjs --preset preset.json --save-dir /app/save
- 该脚本会立即备份并写入 RISUSAVE，没有预检或二次确认。
