RisuAI 桥接插件与预设管理员工具

一、普通用户：导入桥接插件
在 RisuAI 网页的插件管理中导入 bridge-plugin/risu-bridge.plugin.js，启用后刷新页面。
工作台导出的 .risup 预设也应优先通过 RisuAI 网页的“导入预设”功能导入。

二、管理员：网页导入预设不可用时，写入单个预设 JSON
install-risu-preset.cjs 接收单个 RisuAI 预设对象的 JSON 文件，不接收 .risup 文件，也不接收工作台的整个转换存档 ZIP 或 SillyTavern 原始预设 JSON。
如果手上只有工作台导出的 .risup，请使用上面的网页导入方式；不要把 .risup 改名为 .json 交给脚本。

1. 把本包解压到能访问 RisuAI 存档的电脑或服务器；准备好 preset.json。
2. 确认 --save-dir 指向 RISUSAVE 文件所在目录，例如容器内 /app/save。运行前暂停 RisuAI 写入，避免覆盖正在保存的数据。
3. 在压缩包解压目录执行（需要 Node.js）：

   node bridge-plugin/install-risu-preset.cjs --preset preset.json --save-dir /app/save

   如果要覆盖已有预设并指定名称，可在命令末尾添加 --name "预设名"。

脚本会立即备份 database.bin 并写入，没有预检和二次确认。成功输出中的 backupKey 是备份在 RISUSAVE 里的逻辑路径；重新打开 RisuAI 后在预设列表中核验。

Docker：如果在宿主机执行脚本，请把 --save-dir 换成宿主机实际挂载的存档目录。若只在容器里有 Node.js，可以先把本目录和 preset.json 复制进容器，再用 docker exec 运行同一命令；操作期间确保 RisuAI 不在写入。

三、管理员：网页导入桥接插件不可用时
在确认 RisuAI 不在写入后，运行：

   node bridge-plugin/install-risu-v2-plugin.cjs --plugin bridge-plugin/risu-bridge.plugin.js --save-dir /app/save

脚本也会先备份 RISUSAVE。Windows 或宿主机部署时，请把 /app/save 换成实际目录。
