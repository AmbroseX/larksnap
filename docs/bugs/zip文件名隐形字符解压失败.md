# zip 文件名隐形字符导致 macOS 解压报"格式不支持"

日期：2026-07-14
状态：已在导出端修复（`safeName` 清洗），待真机验证

## 现象

用户下载的飞书导出 zip（`下载 (1).zip`），macOS 自带归档工具双击解压报**"格式不支持"**；命令行 `unzip` 能解出图片，但其中的 md 文件也被文件名坑住，最后用 python 手工捞出。

## 根因（两个，叠加触发）

1. **文件名里混入隐形字符**：`AI眼镜选型.md` 的标题里藏了一个零宽空格（U+200B，Unicode Cf 类），是从飞书文档标题原样带出来的。
2. **流式打包（data descriptor）**：那个包是飞书服务端 Java 产的，`ZipOutputStream` 压 DEFLATED 必写 data descriptor。macOS 归档工具对"流式 + UTF-8 文件名 + 隐形字符"的组合容忍度极差，`file` 命令都认成 DOS/MBR boot sector。

## 我们导出端的对照检查

- **根因 2 不中招**：扩展所有 zip 都走 `src/background/zip.ts` 的 `createZipDataUrl`，JSZip `generateAsync` 默认非流式（`streamFiles: false`），会回填完整本地头，不写 data descriptor。
- **根因 1 中招**：zip 内路径和落盘文件名都来自文档标题，此前 `safeName` 只删控制字符（Cc 类），不删格式类隐形字符（Cf 类）——飞书标题里的 U+200B 会原样进 zip。

## 修复

`src/background/download.ts` 的 `safeName`（所有导出器 + 小红书打包的唯一文件名入口）：

- 先做 `normalize('NFC')` 归一化；
- 整类剔除 Unicode Cf（`/\p{Cf}/gu`）：零宽空格/连接符、方向控制符、BOM 等。
  代价：标题里靠零宽连接符组合的 emoji 可能拆开，文件名场景可接受。

单测：`src/background/download.test.ts`。

## 验收标准（真机）

1. `file 导出.zip` 必须显示 `Zip archive data`；
2. Mac 双击解压一次，或 `ditto -xk 导出.zip /tmp/out`（ditto 与归档工具同一套解压逻辑，它能过用户就能过）。

## 备注

- 若日后引入"边生成边下载"的流式打包，退一步的兼容做法：只清洗文件名 + 全部条目 STORED 不压缩（图片本来压不动，这个案例 3MB 只压掉 0.3%，STORED 反而更快）。
- 用户侧碰到打不开的飞书 zip：`unzip` 或 python `zipfile` 基本都能救回来。
