# 踩过的坑

按「换个站还会不会再遇到」排序，越靠前越容易复发。

## 1. 尾斜杠决定相对链接怎么解析（最隐蔽）

VitePress 的 `/guide/` 页面里写 `./cli`，指的是 `/guide/cli`。
但如果按惯例把种子地址的尾斜杠抹掉存成 `/guide`，`urljoin` 就把它当**文件**而不是目录，
`./cli` 解析成 `/cli`，越界后被 scope 全部丢弃。

**症状**：只抓到 1 页就结束，队列压根没展开，没有任何报错。

**处理**：记住哪些路径原本带尾斜杠（`self.dirs`），解析相对链接时补回去。
注意 `/guide/`（目录）和 `/guide/build`（文件）里的 `./x` 含义确实不同，不能一刀切。

## 2. 整站跳转会换域名

`docs.claude.com` 跳到 `platform.claude.com`，正文里的链接全是新域名，
同源检查一刀切掉 → 只抓到 1 页。而且路径结构也从 `/en/docs/` 变成了 `/docs/en/`，
连 scope 都得改。

**处理**：跟完跳转后把最终域名也加进允许集合。写死的旧地址要定期核对。

## 3. 文档根不一定在站点根

`/en/latest/`、`/docs/stable/` 这类带语言和版本号的站，`search_index.json`、
`llms.txt`、`objects.inv` 挂在第二三层。只试站点根会漏——vLLM 的索引、PyTorch 的
`llms.txt`、numpy 和 PyTorch 的 `objects.inv` 全是这么漏掉的。

**处理**：把路径每一级都当候选文档根试一遍。

## 4. 软 404：返回 200，内容是 HTML 错误页

Palantir 的 `/docs/zh/pagefind/pagefind-entry.json` 返回 200 且有 180KB，
但那是一个 Next.js 错误页。`objects.inv` 在某些站也这样。

**处理**：每种格式按类型校验（见 routes.md），别只看状态码。

## 5. 只读前 N 字节做判断，但那是 gzip 流

为了省流量只读 200KB 就 `gzip.decompress`，截断的 gzip 必然解压失败，
于是 800KB 的 MkDocs 索引被误判成"不是 JSON"。

**处理**：用 `zlib.decompressobj(16 + zlib.MAX_WBITS)` 增量解压。
另外大 JSON 只看首字符是不是 `{`，**别整体解析**。

## 6. 并发线程提前散伙

worker 在队列空 N 秒就退出——首页还没抓完，其余线程就全自杀了，
实际退化成单线程。表现是"能跑完但慢得离谱"（单线程 4 分钟 vs 并发 38 秒）。

**处理**：加在途计数，只有「队列空 **且** 没人在抓」才允许退出。

## 7. 断点续抓会连出链一起跳过

跳过已落盘的页 = 跳过解析 = 那一页的出链也丢了，BFS 直接断。
种子页在磁盘上时，1.9 秒"抓完"0 页。

**处理**：出链单独存 `_links.jsonl`，续抓时靠它继续展开队列。
另外收尾写索引时要跟已有 manifest 合并，或从磁盘文件的 YAML 头重建，
否则续抓会把 `_index.md` 覆盖成空的。

## 8. `.md` 文件可能自带 YAML 头

react.dev 的 `.md` 自带 `title:`，如果只找 `# ` 标题就会套两层头、标题为空。

**处理**：先解析自带的 YAML 头，标题优先取里面的。

## 9. `llms-full.txt` 格式不统一

Mintlify 系每页带 `Source: <网址>` 标记，可以可靠切分。
但 Ray 那份 6MB 的是把 reStructuredText 源码直接拼起来的，**没有任何分页标记**，
还原不了页面边界。

**处理**：认不出分页标记就直接报错说明原因，不要硬猜着切。

## 10. MkDocs 全文索引丢结构

索引存的是剥掉 HTML 标签的纯文本。实测：

| 同样 29 个 vLLM design 页面 | 代码块 | 链接 | 表格 | 总字节 |
|---|---|---|---|---|
| HTML 转换路线 | 25 | 28 | 11 | 454K |
| MkDocs 索引路线 | 0 | 0 | 0 | 427K |

字节数差不多，结构全没。uv 也一样：84 个页面 0 个代码块。
而且覆盖还不全，vLLM sitemap 有 2451 页，索引里只有 314 页。

**处理**：只在明确"仅做全文检索"时用，存档一律走 sitemap + HTML 转换。

## 11. 侧边栏只覆盖当前分类

Palantir 单页的侧边栏有 705 条链接，但 transforms-python 那节只有 8 条——
侧边栏是按**分类**给的，单页拿不到全站。

**处理**：BFS 时四个来源都收：侧边栏、顶部导航、上一页/下一页、正文里的站内链接。

## 12. sitemap 不一定可信，也不一定叫这个名

Palantir 的 `docs/sitemap.xml` 有 3089 条，但 2453 条是日文、566 条韩文，中文只有 2 条。
starlight.astro.build 的 `/sitemap.xml` 是 404，真正的在 `/sitemap-index.xml`。
tailwindcss.com 干脆没有 sitemap。

**处理**：抓之前先数一下 sitemap 里符合 scope 的有几条，跟侧边栏规模对不对得上。
没有 sitemap 就用 `crawl_html.py --seed` 走 BFS。
