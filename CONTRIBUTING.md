# 贡献指南

感谢参与!本项目是一个飞书 / Lark 文档导出的 **Chrome MV3 扩展**,外加一个可 `npx skills` 安装的 Claude Code 技能(`skills/larksnap-fetch/`)。

## 开发环境

- Node.js ≥ 18(建议 20 LTS)、npm
- Chrome / Chromium(加载未打包扩展)

```bash
npm ci                 # 安装依赖(按锁文件)
npm run typecheck      # 类型检查
npm run build          # 生产构建 → dist/
npm run dev            # 开发构建 + watch
```

加载扩展:`chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」选 `dist/` → 点扩展图标唤醒后台。

## 提 PR 前

1. `npm run typecheck` 与 `npm run build` 均通过(CI 会再跑一遍)。
2. 改动若涉及扩展与桥接 daemon 的通信,请注意**两侧端口/协议常量需保持一致**:
   扩展侧 `src/background/bridge.ts`,daemon 侧 `skills/larksnap-fetch/scripts/bridge/protocol.mjs`。
3. 桥接技能是**自包含**的——`skills/larksnap-fetch/scripts/bridge/` 是 daemon 的唯一来源,
   不要在仓库其它位置再放一份拷贝。
4. 尽量附上复现步骤或前后对比(尤其私有化部署相关的改动)。

## 提交信息

采用 [Conventional Commits](https://www.conventionalcommits.org/):`feat` / `fix` / `docs` / `chore` / `refactor` …,
可带作用域,例如 `feat(exporters): 支持表格块转 Markdown`。

## 行为准则与合规

本工具仅供**合法、获授权**的文档导出与个人备份。请勿提交用于绕过组织安全策略、抓取无权访问内容的功能。
涉及私有化部署的调试数据请先脱敏(域名 / token / 客户信息),再放进 issue 或 PR。
