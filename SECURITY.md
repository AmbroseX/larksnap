# 安全策略

## 报告漏洞

**请不要开公开 issue 报告安全问题。** 请通过 GitHub 的
[Private Security Advisory](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
私密上报(仓库 **Security → Report a vulnerability**)。请附上复现步骤与影响范围;涉及真实飞书环境的数据请先脱敏。

我们会尽快确认并在修复发布后再公开细节。

## 威胁模型(桥接 daemon)

技能通过一个本地 daemon 把命令行与已登录扩展打通,其边界如下:

- daemon **只绑回环地址** `127.0.0.1`,不监听外部网卡。
- 校验请求 `Origin`:非 `chrome-extension://` 一律拒绝;写操作要求自定义头 `X-Larksnap`,
  以此挡掉网页发起的 CSRF(浏览器简单请求带不了该头,预检会被拒)。
- 导出产物仅在本地落盘,不上传任何第三方服务。

**已知残留风险:** 本机上的其它进程仍可连接回环端口(loopback 固有限制)。本工具定位为个人自用,
该风险在此场景可接受;请勿在多用户共享主机上以不受信任的本地环境运行。

## 数据与权限

- 扩展对公有云域名使用固定 host 权限,对私有化 / 自建域名走 `optional_host_permissions` + 用户手势运行时授权,不预取全站权限。
- 登录态仅存在于用户浏览器,扩展不外发 cookie / token。
