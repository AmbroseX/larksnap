# 安装、排查与视频下载

# 首次安装(仅一次,只需加载扩展,无系统级安装)

扩展来自 larksnap 仓库(本技能不含扩展本体,只含桥接 daemon):

1. 在 larksnap 仓库根 `npm run build`。
2. 到 `chrome://extensions` 开「开发者模式」→「加载已解压的扩展程序」选 `dist/`。
3. 点一下扩展图标唤醒后台 Service Worker —— 它会自动连本地 daemon(daemon 由首次 `fetch.mjs` 拉起)。

> 不需要绑扩展 ID、不写任何系统清单。换机器只要重复这三步(再把本技能目录拷到新机器的 `~/.claude/skills/`)。

# 排查

- `~/.larksnap/daemon.log` 看 daemon 是否在 listen、扩展是否连上、任务是否派发;`~/.larksnap/daemon.pid` 是在监听实例的 PID。
- 连不上:确认 Chrome 开着、扩展已加载;扩展后台休眠时第一条命令可能要等它经 `/ping` 重连(alarms ~24s),点一下扩展图标可立即唤醒。
- 端口冲突:daemon 默认 `127.0.0.1:19925`,可用环境变量 `LARKSNAP_PORT` 改(需与扩展 `src/background/bridge.ts` 里的 `PORT` 一致)。
- 图片缺失/某域名导出失败:多为未按「基础域通配」授权该域名(含图片 drive-stream 子域),在侧边栏重新授权。
- 版本漂移:fetch.mjs 发现在跑的 daemon 版本和本技能不一致时会**自动重启**到自己带的版本(装在多个项目的旧技能不会悄悄坏掉,但旧技能副本建议也更新);扩展和 daemon 的 WS 握手互报协议版本,不一致时 popup 会提示更新。
- 安全:daemon 只绑回环、校验 Origin(非 `chrome-extension://` 拒)+ 要求 `X-Larksnap` 头,挡掉网页 CSRF;CLI→daemon 的请求另有 **HMAC-SHA256 签名**(key 在 `~/.larksnap/secret`,0600,首次自动生成;签名覆盖时间戳/method/path/body 摘要,60s 防重放,无回落),挡掉本机其他身份的冒充。扩展侧 WS 读不了 key 文件,维持 Origin 校验(已知局限)。

# 网页视频下载(daemon 顺带承载,不走 CLI)

daemon(v1.4.0 / 协议 v3 起)还承载一条**扩展发起**的反向任务:用户在视频站点(B 站/YouTube/
抖音/TikTok)的扩展侧边栏点「下载视频」,扩展把页面 URL 经 WS 交给 daemon,daemon 在本机跑
`yt-dlp` 下载合并,落到 `~/Downloads/larksnap-video/`,进度推回侧边栏显示。

- **本功能没有 CLI 入口**,触发点只在扩展侧边栏;本技能的职责是把新版 daemon 分发出去。
- **额外依赖 `yt-dlp` 和 `ffmpeg`**(仅视频下载用到,抓取/编辑飞书文档不需要):
  macOS `brew install yt-dlp ffmpeg`;Windows `winget install yt-dlp.yt-dlp Gyan.FFmpeg`。
  缺失时侧边栏会收到明确的安装提示,不影响其他功能。
- daemon 是旧版时,侧边栏的下载按钮会提示更新本技能;更新技能文件后杀掉旧 daemon
  (`pkill -f bridge/daemon.mjs` 或等它空闲自退)即可。
