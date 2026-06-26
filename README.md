# 飞书文档导出助手（Chrome 扩展 · MV3）

在飞书文档页面一键导出为 **Markdown / PDF / HTML**、批量下载附件、离线缓存文档。
架构参考 LLMCrawler 扩展（React + Vite + TypeScript + MV3），当前为**骨架版本**：
UI、消息链路、文档识别已打通，各导出器为占位实现，待补全真实抓取/转换逻辑。

## 目录结构

```
manifest.json          # MV3 清单（side panel 为主入口）
vite.config.ts         # 构建：React 多入口 + content script 单独打 IIFE + 生产混淆
build.sh               # 构建 / 打包脚本
sidepanel.html         # 侧边栏入口（主 UI，对应 PRD）
options.html           # 设置页
popup.html             # 后备弹窗入口
src/
  background/          # Service Worker
    index.ts           #   消息路由 + 打开侧边栏
    doc-detect.ts      #   注入 content script 识别当前飞书文档
    progress.ts        #   统一进度上报（写状态 + 推送 UI）
    exporters/         #   markdown / pdf / html / attachments（占位）
    cache-manager.ts   #   本地缓存读写
    diagnostic.ts      #   导出诊断信息
  content/             # 注入页面的脚本
    feishu-detect.ts   #   从 URL/DOM 识别文档类型、token、标题
    index.ts           #   content 消息处理（detect / snapshot）
  sidepanel/           # 侧边栏 UI（React）
    SidePanel.tsx      #   操作清单 + 状态栏
    CacheView.tsx      #   缓存管理视图
    actions.ts         #   操作清单配置
  options/             # 设置页 UI
  popup/               # 弹窗 UI
  shared/              # 类型 / 常量 / storage / 消息封装
```

## 开发

```bash
npm install
npm run dev      # watch 构建到 dist/（含热重载）
```

浏览器打开 `chrome://extensions` → 开启开发者模式 → 「加载已解压的扩展程序」→ 选择 `dist/`。

## 构建发布

```bash
npm run build        # 生产构建 + 代码混淆 → dist/
./build.sh --zip     # 额外打包成 release/*.zip
```

## 待办（真实功能）

- [ ] Markdown：解析文档块 / 调用开放接口，转换 + 下载图片 + zip 打包
- [ ] PDF：滚动加载 → 打印样式 → 生成高清 PDF
- [ ] HTML：DOM 快照内联资源 → 单文件下载
- [ ] 附件：解析 image/file token → 素材下载接口批量保存
- [ ] 缓存：补全离线快照内容与离线浏览页
- [ ] Word：待规划
```
