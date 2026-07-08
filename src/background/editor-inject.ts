/**
 * 编辑器页面注入函数 —— 经 chrome.scripting.executeScript({ world: 'MAIN' }) 序列化后
 * 在飞书文档页面的主世界执行。
 *
 * ⚠️ 本文件的导出函数必须**完全自包含**：不引用任何 import / 外部变量 / 闭包，
 * 因为 executeScript 只序列化函数体本身。参数与返回值必须可 JSON 序列化。
 *
 * 注入路线（计划实验 1 的实测结论，2026-07-07 于 iflytek 私有化租户验证）：
 *   - 合成 paste / beforeinput / execCommand 全部被飞书编辑器忽略（只认可信输入）。
 *     合成 paste 仍保留为第一级快速尝试（1.5s 超时，其它部署可能认）。
 *   - 正路是 CDP（chrome.debugger）可信按键，SW 侧（editor.ts）编排四步：
 *     stage-copy（屏外临时节点装 HTML 并选中）→ 可信 Copy → target（还原目标选区）
 *     → 可信 Paste / Backspace → verify（轮询内容指纹）。
 *   - 生效判定一律用「内容指纹」（编辑器 innerText 里出现注入内容）。不能用
 *     MutationObserver——focus / 选区变化会触发编辑器自身渲染，纯突变判定会误报
 *     （上一版就是这么误报 paste 成功的）。
 */

export interface EditorStepPayload {
  /** synthetic=合成 paste 快速尝试；stage-copy=搭临时复制台；
   *  locate=算出目标点击坐标（可信鼠标点击才能驱动飞书的选区模型）；
   *  verify=轮询内容指纹确认生效 */
  action: 'synthetic' | 'stage-copy' | 'locate' | 'verify' | 'settle';
  /** append=文末追加；after=目标块后插入；replace=替换目标块；delete=删除目标块；
   *  replace-all=全选正文整体替换（blockId 传旧首块，用于定位点击与回读判据） */
  mode: 'append' | 'after' | 'replace' | 'delete' | 'replace-all';
  /** 目标块 ID（append 时是最后一个顶层块，用于把光标放到文末） */
  blockId?: string;
  /** 要注入的 HTML（marked 从 Markdown 转来；delete 时为空） */
  html?: string;
  /** text/plain 内容（原始 Markdown） */
  text?: string;
  /** 内容指纹：SW 侧从 Markdown 剥掉语法符号后的首行（渲染后文本里找得到它）。
   *  ⚠️ 不能直接用原始 Markdown 做指纹——innerText 是渲染结果，没有 #、- 这些符号 */
  fingerprint?: string;
  /** 末行指纹：长文档飞书虚拟化渲染，粘贴后视口在尾部，首行可能不在 DOM 里，
   *  末行指纹命中同样算成功 */
  fingerprintTail?: string;
  /** verify 用：locate 步骤返回的"末行指纹注入前已存在" */
  tailExisted?: boolean;
  /** verify 用：locate 步骤返回的注入前编辑器文本长度（去空白） */
  textLenBefore?: number;
  /** verify 用：locate 步骤返回的注入前块节点数量（纯图片写入文本不变，
   *  退化判据看块数量净增） */
  blockCountBefore?: number;
  /** verify 用：注入前文档里是否已含指纹（重复内容场景退化为长度判定） */
  fingerprintExisted?: boolean;
  /** verify 轮询超时毫秒数（默认 5000） */
  timeoutMs?: number;
  /** 纯文本粘贴模式：暂存台只装原始 Markdown 文本（不装 HTML），让飞书的
   *  Markdown 粘贴解析自己转块——HTML 表格会被转成异步提交的内嵌电子表格
   *  （后台页里数据提交不稳），md 文本表格则转成原生简单表格 */
  plainOnly?: boolean;
  /** 锚点块是列表项（bullet/ordered/todo）：回车产生的是新列表项，md 语法在
   *  列表上下文里不解析（### 行被吞，公有云实测）。SW 侧看到此标记会多按一次
   *  回车退出列表再粘贴。字段由 SW 填、SW 用，挂在 payload 上只是搭便车 */
  escapeList?: boolean;
  /** replace 专用（SW 填、SW 用）：目标块前面那一块的 ID 与列表标记。
   *  replace 走"先删后插"，删掉目标块后以前一块为锚点粘贴 */
  prevBlockId?: string;
  prevIsList?: boolean;
}

export interface EditorStepResult {
  ok: boolean;
  reason?:
    | 'not-editable'
    | 'block-node-not-found'
    | 'synthetic-rejected'
    | 'stage-failed'
    | 'verify-timeout';
  /** 生效的注入方式（synthetic 成功时为 'paste'，CDP 路径由 SW 侧填） */
  method?: string;
  /** locate 步骤返回：注入前编辑器文本长度（去空白后） */
  textLenBefore?: number;
  /** locate 步骤返回：注入前块节点数量 */
  blockCountBefore?: number;
  /** locate 步骤返回：指纹是否已存在于注入前文本 */
  fingerprintExisted?: boolean;
  /** locate 步骤返回：末行指纹是否已存在于注入前文本 */
  tailExisted?: boolean;
  /** locate 步骤返回：可信鼠标点击的视口坐标 */
  x?: number;
  y?: number;
  message?: string;
}

export async function editorStepInPage(p: EditorStepPayload): Promise<EditorStepResult> {
  const STAGE_ID = 'larksnap-cdp-stage';
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const squash = (s: string) => s.replace(/\s+/g, '');
  // 指纹：SW 传来的剥语法首行/末行，去空白后取前 24 个字符
  const fingerprint = squash(p.fingerprint ?? '').slice(0, 24);
  const tailFp = squash(p.fingerprintTail ?? '').slice(0, 24);

  // ---- 编辑器根：页面里面积最大的 contenteditable 元素（只读视图没有编辑器实例）----
  function findRoot(): HTMLElement | null {
    const cands = Array.from(
      document.querySelectorAll<HTMLElement>('[contenteditable="true"]')
    ).filter((el) => el.isConnected && el.id !== STAGE_ID);
    if (!cands.length) return null;
    const area = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return r.width * r.height;
    };
    cands.sort((a, b) => area(b) - area(a));
    return cands[0];
  }

  // ---- 块 ID → DOM 节点：候选属性逐个试（docx / wiki 两种壳，见计划实验 3）----
  const BLOCK_ATTRS = ['data-block-id', 'data-record-id', 'data-node-id', 'data-blockid'];
  function findBlockNode(id: string): HTMLElement | null {
    const esc = window.CSS && CSS.escape ? CSS.escape(id) : id;
    for (const attr of BLOCK_ATTRS) {
      const el = document.querySelector<HTMLElement>(`[${attr}="${esc}"]`);
      if (el) return el;
    }
    return null;
  }

  const editorText = () => {
    const r = findRoot();
    return r ? squash(r.innerText || '') : '';
  };

  // ---- 目标选区：按 mode 把光标/选区放到位（synthetic / target 两步共用）----
  function placeSelection(): EditorStepResult | null {
    const root = findRoot();
    if (!root) {
      return {
        ok: false,
        reason: 'not-editable',
        message: '页面上没有可编辑的编辑器实例（可能是只读权限或页面未加载完）',
      };
    }
    const sel = window.getSelection();
    if (!sel) return { ok: false, reason: 'stage-failed', message: '无法获取选区' };
    root.focus();
    const range = document.createRange();
    if (p.mode === 'append') {
      // 光标放到最后一个块（拿不到就编辑器根）的内容末尾
      const anchor = (p.blockId && findBlockNode(p.blockId)) || root;
      range.selectNodeContents(anchor);
      range.collapse(false);
    } else {
      const node = findBlockNode(p.blockId ?? '');
      if (!node) {
        return {
          ok: false,
          reason: 'block-node-not-found',
          message: `页面 DOM 里找不到块 ${p.blockId}（data-block-id 类属性未命中）`,
        };
      }
      range.selectNodeContents(node);
      if (p.mode === 'after') range.collapse(false); // 块尾光标
      // replace / delete：选区铺满整块
    }
    sel.removeAllRanges();
    sel.addRange(range);
    return null; // 成功
  }

  switch (p.action) {
    // ============ 第一级：合成 paste 快速尝试（isTrusted=false，多数部署会忽略） ============
    case 'synthetic': {
      // 删除/全文替换没有合成通道（合成按键与合成 SelectAll 同样不可信），直接交给 CDP
      if (p.mode === 'delete' || p.mode === 'replace-all') {
        return { ok: false, reason: 'synthetic-rejected' };
      }
      const err = placeSelection();
      if (err) return err;
      const before = editorText();
      const dt = new DataTransfer();
      dt.setData('text/html', p.html ?? '');
      dt.setData('text/plain', p.text ?? '');
      const sel = window.getSelection();
      const anchorEl =
        sel?.anchorNode instanceof HTMLElement
          ? sel.anchorNode
          : sel?.anchorNode?.parentElement || findRoot();
      anchorEl?.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
      );
      const t0 = Date.now();
      while (Date.now() - t0 < 1500) {
        await sleep(150);
        const now = editorText();
        if (fingerprint && now.includes(fingerprint) && !before.includes(fingerprint)) {
          return { ok: true, method: 'paste' };
        }
      }
      return { ok: false, reason: 'synthetic-rejected' };
    }

    // ============ CDP 第 1 步：屏外临时节点装内容并选中，等 SW 发可信 Copy ============
    case 'stage-copy': {
      document.getElementById(STAGE_ID)?.remove();
      if (p.plainOnly) {
        // 纯文本模式暂存台必须用 textarea：从 textarea 复制，系统剪贴板只会有
        // text/plain 一种口味。之前用 contenteditable div，execCommand('copy')
        // 兜底路径会连带产生 text/html 口味，飞书一看到 html 就走 HTML 粘贴、
        // 跳过 Markdown 解析，整篇落成字面文本（R1 实测，偶发取决于走哪条复制路径）
        const ta = document.createElement('textarea');
        ta.id = STAGE_ID;
        ta.value = p.text ?? '';
        ta.style.cssText = 'position:fixed;left:-99999px;top:0;width:600px;height:400px;opacity:0;';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        return { ok: true };
      }
      const div = document.createElement('div');
      div.id = STAGE_ID;
      div.contentEditable = 'true';
      // 屏外但可选中（display:none 的内容选不了也复制不了）
      div.style.cssText =
        'position:fixed;left:-99999px;top:0;width:600px;opacity:0;white-space:pre-wrap;';
      div.innerHTML = p.html ?? '';
      document.body.appendChild(div);
      const sel = window.getSelection();
      if (!sel) return { ok: false, reason: 'stage-failed', message: '无法获取选区' };
      div.focus();
      const range = document.createRange();
      range.selectNodeContents(div);
      sel.removeAllRanges();
      sel.addRange(range);
      return { ok: true };
    }

    // ============ CDP 第 2 步：拆复制台，算目标点击坐标 ============
    // DOM Selection 驱动不了飞书自己的选区模型（实测：铺满整块的选区被归一成块尾
    // 光标，Backspace 只删一个字），必须用可信鼠标点击让飞书自己定位光标。
    case 'locate': {
      document.getElementById(STAGE_ID)?.remove();
      const before = editorText();
      const root = findRoot();
      if (!root) {
        return {
          ok: false,
          reason: 'not-editable',
          message: '页面上没有可编辑的编辑器实例（可能是只读权限或页面未加载完）',
        };
      }
      let node = p.blockId ? findBlockNode(p.blockId) : null;
      if (!node && p.blockId && p.mode !== 'append') {
        // 长文档虚拟化渲染：块不在视口附近就不在 DOM 里，滚动扫描全文找它
        const scroller =
          (function findScroller(el: HTMLElement | null): HTMLElement | null {
            for (let cur = el; cur; cur = cur.parentElement) {
              if (cur.scrollHeight > cur.clientHeight + 50) return cur;
            }
            return null;
          })(root) || (document.scrollingElement as HTMLElement | null);
        if (scroller) {
          const stepPx = Math.max(300, window.innerHeight * 0.8);
          for (let pos = 0; pos <= scroller.scrollHeight && !node; pos += stepPx) {
            scroller.scrollTop = pos;
            await sleep(250); // 等虚拟化渲染补块
            node = findBlockNode(p.blockId);
          }
        }
      }
      if (!node && p.mode !== 'append') {
        return {
          ok: false,
          reason: 'block-node-not-found',
          message: `页面 DOM 里找不到块 ${p.blockId}（含全文滚动扫描，data-block-id 类属性未命中）`,
        };
      }
      if (!node && p.mode === 'append') {
        // 没给块 ID（分片粘贴的后续片 / 空文档）：取当前 DOM 里最后一个块当锚点
        // （长文档虚拟化渲染下它就在当前视口附近，粘贴后视口本来就在尾部）
        const all = root.querySelectorAll<HTMLElement>('[data-record-id],[data-block-id]');
        node = all.length ? all[all.length - 1] : null;
      }
      const base = {
        ok: true,
        textLenBefore: before.length,
        blockCountBefore: document.querySelectorAll('[data-record-id],[data-block-id]').length,
        fingerprintExisted: !!fingerprint && before.includes(fingerprint),
        tailExisted: !!tailFp && before.includes(tailFp),
      };
      if (!node) {
        // 空文档：点编辑器内容区靠下位置（钳在视口内），飞书会把光标放到文末
        const r = root.getBoundingClientRect();
        return {
          ...base,
          x: r.left + r.width / 2,
          y: Math.min(Math.max(r.top + 10, r.bottom - 30), window.innerHeight - 10),
        };
      }
      node.scrollIntoView({ block: 'center' });
      await sleep(300); // 等滚动与懒渲染稳定
      if (p.mode === 'append' || p.mode === 'after') {
        // 点到块内文本的最末端：Range 行盒里筛掉零宽的装饰矩形，取最靠下再靠右的
        // 那一个（嵌套结构会产生 0 宽矩形，直接取最后一个会把光标带到块首）
        const range = document.createRange();
        range.selectNodeContents(node);
        const rects = Array.from(range.getClientRects()).filter(
          (q) => q.width > 1 && q.height > 1
        );
        const r = rects.length
          ? rects.reduce((a, b) =>
              b.bottom > a.bottom || (b.bottom === a.bottom && b.right > a.right) ? b : a
            )
          : node.getBoundingClientRect();
        return { ...base, x: Math.max(r.left + 1, r.right - 2), y: r.top + r.height / 2 };
      }
      // replace / delete / replace-all：点块内第一行文本矩形的中点，不点块盒子的
      // 几何中心——公有云上最后一个列表项的盒子比文本行高（往下多占一截），点
      // 几何中心会落到下一个块上，Esc+Backspace 连环误删邻居块（实测三轮追凶）
      {
        const range = document.createRange();
        range.selectNodeContents(node);
        const rects = Array.from(range.getClientRects()).filter(
          (q) => q.width > 1 && q.height > 1
        );
        if (rects.length) {
          const top = rects.reduce((a, b) =>
            b.top < a.top || (b.top === a.top && b.left < a.left) ? b : a
          );
          return { ...base, x: top.left + top.width / 2, y: top.top + top.height / 2 };
        }
        // 块内没有文本矩形（图片等）：点盒子顶部往下一点，避开盒子下缘
        const r = node.getBoundingClientRect();
        return { ...base, x: r.left + r.width / 2, y: r.top + Math.min(14, r.height / 2) };
      }
    }

    // ============ CDP 第 3 步：轮询内容指纹，确认可信输入真的进了编辑器 ============
    case 'verify': {
      const limit = p.timeoutMs ?? 5000;
      const t0 = Date.now();
      while (Date.now() - t0 < limit) {
        // 删除/替换→目标块 DOM 节点消失（精确判据；替换后飞书会换块 ID，实测。
        // 文本长短判据会被"只删了一个字"或"换入更短内容"骗过）；
        // 插入→首行或末行指纹出现即命中（长文档飞书虚拟化渲染，粘贴后视口在
        // 尾部，首行可能不在 DOM 里）；两个指纹注入前都已存在→退化为长度变长
        let hit: boolean;
        if (p.mode === 'delete' || p.mode === 'replace' || p.mode === 'replace-all') {
          // replace-all 的 blockId 是旧首块：整体替换后飞书会给新内容发新块 ID，
          // 旧首块节点消失即说明"真替换了"而不是"追加在后面"（服务端回读再把关一次）
          hit = !findBlockNode(p.blockId ?? '');
        } else {
          const now = editorText();
          const headUsable = !!fingerprint && !p.fingerprintExisted;
          const tailUsable = !!tailFp && !p.tailExisted;
          // 没有可用指纹（纯图片写入等）→ 退化判据：文本变长或块数量净增
          const blocksNow = document.querySelectorAll('[data-record-id],[data-block-id]').length;
          hit =
            (headUsable && now.includes(fingerprint)) ||
            (tailUsable && now.includes(tailFp)) ||
            (!headUsable &&
              !tailUsable &&
              (now.length > (p.textLenBefore ?? 0) ||
                (p.blockCountBefore != null && blocksNow > p.blockCountBefore)));
        }
        if (hit) return { ok: true };
        await sleep(200);
      }
      document.getElementById(STAGE_ID)?.remove();
      return {
        ok: false,
        reason: 'verify-timeout',
        message: '可信输入后编辑器内容未出现预期变化',
      };
    }

    // ============ CDP 第 4 步：等转换稳定 ============
    // 大段 Markdown 粘贴后飞书是渐进式解析转块的，转换没做完就关标签页会截断内容
    // （实测 20KB 丢了尾部）。轮询块数量与文本长度，连续 3 秒不变才算转换完成。
    case 'settle': {
      const limit = p.timeoutMs ?? 15000;
      const snap = () =>
        `${document.querySelectorAll('[data-record-id],[data-block-id]').length}:${editorText().length}`;
      const t0 = Date.now();
      let last = snap();
      let stableSince = Date.now();
      while (Date.now() - t0 < limit) {
        await sleep(500);
        const now = snap();
        if (now !== last) {
          last = now;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= 3000) {
          return { ok: true };
        }
      }
      // 超时不算失败：后面还有服务端回读把关
      return { ok: true };
    }
  }
  return { ok: false, message: `未知步骤 ${String(p.action)}` };
}

/**
 * 探测函数（开发/实验用）：收集编辑器 DOM 形态，供三个可行性实验记录结论。
 * 经 edit.mjs 的隐藏子命令 probe 触发。
 */
export function editorProbeInPage(): Record<string, unknown> {
  const editables = Array.from(
    document.querySelectorAll<HTMLElement>('[contenteditable="true"]')
  ).map((el) => ({
    tag: el.tagName,
    cls: (el.className || '').toString().slice(0, 120),
    childCount: el.childElementCount,
    rect: (() => {
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    })(),
  }));

  // 采样带“块标识”味道的 data-* 属性名（前 5000 个元素里找）
  const attrStats: Record<string, number> = {};
  const sampleNodes: Array<Record<string, string>> = [];
  const all = document.querySelectorAll('*');
  const n = Math.min(all.length, 5000);
  for (let i = 0; i < n; i++) {
    const el = all[i];
    for (const a of Array.from(el.attributes ?? [])) {
      if (/^data-.*(block|record|node)/i.test(a.name) && /^[A-Za-z0-9_-]{8,}$/.test(a.value)) {
        attrStats[a.name] = (attrStats[a.name] || 0) + 1;
        if (sampleNodes.length < 10) {
          sampleNodes.push({ attr: a.name, value: a.value.slice(0, 40), tag: el.tagName });
        }
      }
    }
  }

  // 保存指示候选：短文本节点里含 保存/saved 字样的
  const saveHints: string[] = [];
  const short = document.querySelectorAll('span,div');
  for (let i = 0; i < short.length && saveHints.length < 8; i++) {
    const el = short[i];
    const t = el.childElementCount === 0 ? (el.textContent || '').trim() : '';
    if (t && t.length <= 20 && /保存|saved|saving|同步/i.test(t)) saveHints.push(t);
  }

  return {
    url: location.href,
    readyState: document.readyState,
    hasFocus: document.hasFocus(),
    visibility: document.visibilityState,
    editableCount: editables.length,
    editables: editables.slice(0, 3),
    blockAttrStats: attrStats,
    sampleBlockNodes: sampleNodes,
    saveHints,
  };
}
