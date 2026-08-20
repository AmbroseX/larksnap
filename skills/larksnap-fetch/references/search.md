# 浏览器网页搜索

`search.mjs` 用用户自己已登录的浏览器跑一次搜索：后台打开搜索引擎结果页，由扩展解析条目并把结构化结果写到 stdout。不调用付费检索 API。

```bash
node ~/.claude/skills/larksnap-fetch/scripts/search.mjs "<关键词>" \
  [--engine auto|bing|google|ddg] [--count 10] [--out <文件>] [--md] [--profile <code>]
```

- `--engine` 默认 `auto`，按 bing -> google -> ddg 依次尝试；输出 `engine` 是实际成功的引擎。
- `--count` 默认 10，最大 20，只取第一页，不翻页。
- 默认 stdout 输出一行 JSON：`{ok:true, engine, query, count, results:[{rank,title,url,snippet,site}]}`。
  `--md` 输出 Markdown 列表；`--out` 写入文件并输出 JSON 摘要。
- 没搜到不是失败：退出码 0、`count:0`。
- 退出码：`0` 成功（含没搜到）、`1` 被拦/失败、`2` 用法错、`4` 需授权域名、`5` 桥接未就绪。

搜索引擎域名可能需要用户手势授权。报 `need_domain_auth` 时，让用户点扩展图标打开侧边栏，选择「授权访问所有网站」；这样搜索结果里的链接后续也能直接交给 `fetch.mjs` 抓正文。

搜索被 `search_blocked` 拦截时，不要连续重试。让用户在 Chrome 中手动打开对应搜索引擎并完成验证，再重跑；也可以用 `--engine` 换一家。

搜索完成后按需抓正文：

```bash
node ~/.claude/skills/larksnap-fetch/scripts/search.mjs "关键词" --count 5
node ~/.claude/skills/larksnap-fetch/scripts/fetch.mjs "<results[].url>" ./out
```

约束：一次只取第一页、不并发批量查。搜索关键词不写入统计或日志，埋点只记录引擎名和成败。
