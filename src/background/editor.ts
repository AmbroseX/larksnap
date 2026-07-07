import { marked } from 'marked';
import type { Block, DocInfo } from '../shared/types';
import { detectDocFromUrl } from '../content/feishu-detect';
import { hasPermissionForHost } from './permissions';
import { setContentTab } from './feishu-proxy';
import { resolveObjToken, fetchClientVars } from './feishu-api';
import { buildBlockTree, type BlockTree } from './convert/adapter';
import { plainText } from './convert/apool';
import { waitForTabComplete } from './tab-util';
import {
  editorStepInPage,
  editorProbeInPage,
  type EditorStepPayload,
  type EditorStepResult,
} from './editor-inject';
import { track } from './analytics';

/**
 * 编辑任务编排（路线 C，docs/plans/2026-07-07-飞书文档编辑.md §4）：
 *   后台开文档标签页 → 读块树（复用 client_vars 读管线）→ 定位目标 →
 *   主世界注入（合成 paste 降级链）→ 等保存 → 回读校验 → 回结果。
 *
 * list-blocks 只走读管线不开编辑流程；probe 是开发用的 DOM 探测（实验记录用）。
 */

export interface EditJob {
  id: string;
  url: string;
  op: string;
  contentMd?: string;
  anchor?: { heading?: string; blockId?: string; expectSummary?: string };
  opts: { keepTab?: boolean; mdPaste?: boolean };
}

type Reply = (payload: Record<string, unknown>) => void;

/** list-blocks 输出的扁平块清单项（父子关系靠 parentId/depth 标清，防 CC 误删一整节） */
interface FlatBlock {
  id: string;
  parentId: string | null;
  type: string;
  depth: number;
  childCount: number;
  summary: string;
}

export async function runEditJob(job: EditJob, reply: Reply): Promise<void> {
  let tabId: number | undefined;
  try {
    const info = detectDocFromUrl(job.url);
    if (!info.isFeishuDoc || !['docx', 'wiki'].includes(info.docType)) {
      reply({
        type: 'error',
        subtype: 'edit_unsupported',
        message: `编辑只支持 docx / wiki 文档链接（当前识别为 ${info.isFeishuDoc ? info.docType : '非飞书文档'}）`,
      });
      return;
    }
    if (!(await hasPermissionForHost(info.host))) {
      reply({ type: 'need-auth', host: info.host });
      return;
    }

    reply({ type: 'progress', message: '正在后台打开文档…', percent: 5 });
    const tab = await chrome.tabs.create({ url: job.url, active: false });
    tabId = tab.id;
    if (tabId == null) throw new Error('无法打开标签页');
    await waitForTabComplete(tabId);
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    setContentTab(tabId);

    // 开发用探测：只收集编辑器 DOM 形态，不读内容不写入
    if (job.op === 'probe') {
      const probe = await runInPage(tabId, editorProbeInPage);
      reply({ type: 'result', probe });
      return;
    }

    reply({ type: 'progress', message: '正在读取文档块结构…', percent: 15 });
    const { tree } = await readTree(info);

    if (job.op === 'list-blocks') {
      void track({ name: 'edit', url: '/edit/list-blocks', data: { ok: true } });
      reply({ type: 'result', blocks: flatten(tree) });
      return;
    }

    // ---- 写操作：定位目标（含 block_changed / anchor 防呆）----
    const target = resolveTarget(job, tree);
    if ('error' in target) {
      reply(target.error);
      return;
    }

    reply({ type: 'progress', message: '正在把内容写入编辑器…', percent: 40 });
    const base: Omit<EditorStepPayload, 'action'> = {
      mode: target.mode,
      blockId: target.blockId,
      html: job.contentMd ? String(marked.parse(job.contentMd)) : '',
      text: job.contentMd ?? '',
      // 指纹用剥掉 Markdown 语法的首行 + 末行——页面 innerText 是渲染结果，带语法的
      // 原文匹配不上；长文档虚拟化渲染下首行可能不在 DOM 里，末行兜底
      fingerprint: meaningfulLines(job.contentMd ?? '')[0] ?? '',
      fingerprintTail: meaningfulLines(job.contentMd ?? '').slice(-1)[0] ?? '',
      plainOnly: job.opts.mdPaste === true,
    };

    // 第一级：合成 paste 快速尝试；被拒收（绝大多数飞书部署）→ CDP 可信输入兜底
    let r = (await runInPage(tabId, editorStepInPage, {
      ...base,
      action: 'synthetic',
    })) as EditorStepResult;
    if (!r?.ok && r?.reason === 'synthetic-rejected') {
      const granted = await chrome.permissions.contains({ permissions: ['debugger'] });
      if (!granted) {
        reply({ type: 'need-edit-grant' });
        return;
      }
      reply({ type: 'progress', message: '编辑器拒收合成输入，改用可信输入（CDP）…', percent: 55 });
      r = await cdpInject(tabId, base);
    }
    if (!r?.ok) {
      void track({ name: 'edit', url: '/edit/task', data: { ok: false, op: job.op } });
      if (r?.reason === 'not-editable') reply({ type: 'need-edit-permission' });
      else if (r?.reason === 'block-node-not-found')
        reply({ type: 'error', subtype: 'block_not_found', message: r.message });
      else reply({ type: 'error', subtype: 'inject_failed', message: r?.message || '注入失败' });
      return;
    }

    reply({
      type: 'progress',
      message: `已注入（${r.method}），正在回读校验…`,
      percent: 80,
    });
    // 给协同引擎一点提交时间再回读（页面上已确认内容出现，这里等的是服务端落库）
    await new Promise((res) => setTimeout(res, 2000));
    // 回读一次不中就再等 3s 重试一次（服务端落库可能比页面确认慢）
    let verified = await verify(info, job, target);
    if (!verified) {
      await new Promise((res) => setTimeout(res, 3000));
      verified = await verify(info, job, target);
    }
    void track({ name: 'edit', url: '/edit/task', data: { ok: verified, op: job.op, method: r.method ?? '' } });
    if (!verified) {
      reply({
        type: 'error',
        subtype: 'save_unconfirmed',
        message: `内容已注入编辑器（${r.method}）但回读未确认落地，内容可能已进文档，请人工检查`,
      });
      return;
    }
    reply({
      type: 'result',
      message: `${job.op} 完成（注入 ${r.method}，回读校验通过）`,
    });
  } catch (err) {
    void track({ name: 'edit', url: '/edit/task', data: { ok: false, op: job.op } });
    const message = err instanceof Error ? err.message : String(err);
    if (isLoginError(message)) reply({ type: 'need-login' });
    else reply({ type: 'error', message });
  } finally {
    setContentTab(null);
    if (tabId != null && job.opts.keepTab !== true) {
      // HTML 粘贴模式下表格会贴成内嵌电子表格，其单元格数据在页面里异步提交；
      // 标签页关太快会留下永远转圈的空表格（实测）。含表格的写入不管成败（报错时
      // 内容也可能已落地），关标签页前都多留提交时间。md 粘贴模式产原生简单表格，
      // 数据直接在文档模型里，无需等待。
      if (job.opts.mdPaste !== true && /^\s*\|.*\|\s*$/m.test(job.contentMd ?? '')) {
        await new Promise((res) => setTimeout(res, 8000));
      }
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        /* 标签页可能已被关闭 */
      }
    }
  }
}

// ==================== 读块树（复用 client_vars 读管线） ====================

async function readTree(info: DocInfo): Promise<{ tree: BlockTree }> {
  const resolved = await resolveObjToken(info);
  const cv = await fetchClientVars(resolved);
  const data = (cv.data ?? {}) as Record<string, unknown>;
  const blockMap = data.block_map as Record<string, unknown> | undefined;
  if (!blockMap || !Object.keys(blockMap).length) {
    throw new Error(`读取文档内容失败（code ${String(cv.code ?? '未知')}，块列表为空）`);
  }
  return { tree: buildBlockTree(data, resolved.objToken) };
}

/** 未登录的典型症状：GET 403 / csrf 文案 / 登录页 HTML 导致 JSON 解析失败 */
function isLoginError(message: string): boolean {
  return (
    /HTTP 40[13]/.test(message) ||
    /csrf token error/i.test(message) ||
    /Unexpected token|not valid JSON/i.test(message) ||
    /登录|not.?logged|login/i.test(message)
  );
}

// ==================== 块清单与定位 ====================

/** 空白归一（编辑器可能重排空白，比对一律去空白） */
function normalize(s: string): string {
  return s.replace(/\s+/g, '');
}

/** 块内容摘要：文本类取纯文本前 80 字，非文本类给类型占位 */
function summaryOf(b: Block): string {
  const t = plainText(b.text).replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 80) : `[${b.type}]`;
}

/** 按文档顺序深度优先展开块树 */
function flatten(tree: BlockTree): FlatBlock[] {
  const out: FlatBlock[] = [];
  const seen = new Set<string>();
  const walk = (id: string, depth: number) => {
    const b = tree.map[id];
    if (!b || seen.has(id)) return;
    seen.add(id);
    out.push({
      id,
      parentId: b.parentId,
      type: b.type,
      depth,
      childCount: b.children.length,
      summary: summaryOf(b),
    });
    for (const c of b.children) walk(c, depth + 1);
  };
  for (const id of tree.order) walk(id, 0);
  return out;
}

type Target = { mode: EditorStepPayload['mode']; blockId?: string };

function resolveTarget(job: EditJob, tree: BlockTree): Target | { error: Record<string, unknown> } {
  switch (job.op) {
    case 'append':
      // 光标锚点用最后一个顶层块；文档为空时退回编辑器根
      return { mode: 'append', blockId: tree.order[tree.order.length - 1] };

    case 'insert-after': {
      const want = normalize(job.anchor?.heading ?? '');
      const hits = Object.values(tree.map).filter(
        (b) => b.type.startsWith('heading') && normalize(plainText(b.text)) === want
      );
      if (hits.length === 0) {
        return {
          error: {
            type: 'error',
            subtype: 'anchor_not_found',
            message: `没找到标题「${job.anchor?.heading ?? ''}」（按文本精确匹配）`,
          },
        };
      }
      if (hits.length > 1) {
        return {
          error: {
            type: 'error',
            subtype: 'anchor_ambiguous',
            message: `标题「${job.anchor?.heading ?? ''}」匹配到 ${hits.length} 处，请改用 insert-after-block 以块 ID 定位`,
          },
        };
      }
      return { mode: 'after', blockId: hits[0].id };
    }

    case 'insert-after-block':
    case 'replace-block':
    case 'delete-block': {
      const id = job.anchor?.blockId ?? '';
      const b = tree.map[id];
      if (!b) {
        return {
          error: {
            type: 'error',
            subtype: 'block_not_found',
            message: `块 ${id} 不在当前文档里（可能已被删除或 ID 有误）`,
          },
        };
      }
      // 防呆：replace/delete 前比对内容摘要，不一致说明文档被并发修改过
      if (job.op !== 'insert-after-block') {
        const now = summaryOf(b);
        const expect = job.anchor?.expectSummary ?? '';
        if (normalize(now) !== normalize(expect)) {
          return {
            error: {
              type: 'error',
              subtype: 'block_changed',
              message: `目标块内容与预期不一致（当前「${now}」/ 预期「${expect}」），文档可能被修改过`,
            },
          };
        }
      }
      const mode =
        job.op === 'insert-after-block' ? 'after' : job.op === 'replace-block' ? 'replace' : 'delete';
      return { mode, blockId: id };
    }

    default:
      return { error: { type: 'error', message: `未知编辑操作「${job.op}」` } };
  }
}

// ==================== 回读校验 ====================

/** 取 Markdown 里有比对价值的行（剥掉块前缀与行内标记；表格行整行剔除——
 *  表格贴成飞书原生表格后读管线读不到单元格文字，拿表格行比对必假失败） */
function meaningfulLines(md: string): string[] {
  return md
    .split('\n')
    .map((raw) => {
      let l = raw.trim();
      if (l.startsWith('|')) return '';
      l = l.replace(/^(#{1,9}|[-*+]|\d+\.|>+)\s+/, '');
      l = l.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
      l = l.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
      l = l.replace(/[*_`~|]/g, ' ');
      return l.trim();
    })
    .filter((l) => l.length >= 2 && !/^[:\-\s]+$/.test(l));
}

/**
 * 回读校验：重新拉块树，检查写入内容的首/末行出现在文档纯文本里（delete 检查块消失）。
 * 只做包含性检查——导出转换与粘贴解析对复杂语法的归一化不完全一致，不做逐字对比。
 */
async function verify(
  info: DocInfo,
  job: EditJob,
  target: Target
): Promise<boolean> {
  try {
    const { tree } = await readTree(info);
    if (target.mode === 'delete') return !tree.map[target.blockId ?? ''];
    // 替换会换块 ID（实测）：旧块必须已消失，且新内容出现（下方包含性检查）
    if (target.mode === 'replace' && tree.map[target.blockId ?? '']) return false;
    const lines = meaningfulLines(job.contentMd ?? '');
    if (!lines.length) return true; // 没有可比对的文本（如纯分隔线）→ 视为通过
    const docText = normalize(
      Object.values(tree.map)
        .map((b) => plainText(b.text))
        .join('\n')
    );
    return docText.includes(normalize(lines[0])) && docText.includes(normalize(lines[lines.length - 1]));
  } catch {
    return false; // 回读失败按未确认处理（上层报 save_unconfirmed）
  }
}

// ==================== CDP 可信输入（计划实验 1 第 3 级兜底） ====================

/**
 * 把 Markdown 按顶层块边界切成不超过 maxLen 字符的片：只在代码围栏之外的空行处
 * 下刀，保证列表、代码块、表格不会被从中间切断。
 */
function splitMarkdown(md: string, maxLen: number): string[] {
  if (md.length <= maxLen) return [md];
  const chunks: string[] = [];
  let cur: string[] = [];
  let curLen = 0;
  let inFence = false;
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    cur.push(line);
    curLen += line.length + 1;
    if (!inFence && curLen >= maxLen && line.trim() === '') {
      chunks.push(cur.join('\n'));
      cur = [];
      curLen = 0;
    }
  }
  if (cur.join('').trim()) chunks.push(cur.join('\n'));
  return chunks;
}

/**
 * 用 chrome.debugger 发可信输入完成写入（合成事件被飞书编辑器忽略，实测结论）：
 *   stage-copy（屏外临时节点装 HTML 并选中）→ 可信 Copy（内容落系统剪贴板，会
 *   占用用户剪贴板，SKILL.md 有说明）→ locate（算目标坐标）→ 可信鼠标点击定位
 *   （DOM Selection 驱动不了飞书的选区模型，实测）→ replace/delete 先按 Esc 进入
 *   块选中态 → 可信 Paste / Backspace → verify（轮询内容指纹/块节点消失）。
 * 附加调试器期间页面顶部有"正在调试此浏览器"横幅，任务结束即消失。
 */
async function cdpInject(
  tabId: number,
  base: Omit<EditorStepPayload, 'action'>
): Promise<EditorStepResult> {
  const dbg = { tabId };
  const step = (extra: Partial<EditorStepPayload>) =>
    runInPage(tabId, editorStepInPage, { ...base, ...extra } as EditorStepPayload);
  // 一次按键 = keyDown + keyUp；commands 让 Blink 直接执行编辑命令（跨平台，
  // 不依赖 Cmd/Ctrl 修饰键的浏览器级快捷键分发）
  const key = async (spec: {
    key: string;
    code: string;
    vk: number;
    commands?: string[];
  }): Promise<void> => {
    await chrome.debugger.sendCommand(dbg, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.vk,
      nativeVirtualKeyCode: spec.vk,
      ...(spec.commands ? { commands: spec.commands } : {}),
    });
    await chrome.debugger.sendCommand(dbg, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.vk,
      nativeVirtualKeyCode: spec.vk,
    });
  };

  await chrome.debugger.attach(dbg, '1.3');
  try {
    // 后台标签页没有页面焦点，Blink 编辑命令（Copy/Paste）对非激活页面不执行，
    // 用 CDP 的焦点仿真让页面自认为处于前台
    await chrome.debugger.sendCommand(dbg, 'Emulation.setFocusEmulationEnabled', {
      enabled: true,
    });
    // 可信鼠标点击：让飞书自己把光标放到目标位置
    const click = async (x: number, y: number): Promise<void> => {
      for (const type of ['mousePressed', 'mouseReleased'] as const) {
        await chrome.debugger.sendCommand(dbg, 'Input.dispatchMouseEvent', {
          type,
          x,
          y,
          button: 'left',
          clickCount: 1,
        });
      }
    };
    const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

    // ---- 删除：点击 → Esc 块选中 → Backspace ----
    if (base.mode === 'delete') {
      const tg = (await step({ action: 'locate' })) as EditorStepResult;
      if (!tg?.ok) return tg ?? { ok: false, message: '目标定位失败' };
      await click(tg.x ?? 0, tg.y ?? 0);
      await sleep(400); // 等编辑器完成光标定位
      await key({ key: 'Escape', code: 'Escape', vk: 27 });
      await sleep(300);
      await key({ key: 'Backspace', code: 'Backspace', vk: 8 });
      const vr = (await step({
        action: 'verify',
        textLenBefore: tg.textLenBefore,
      })) as EditorStepResult;
      if (!vr?.ok) return vr ?? { ok: false, message: '删除确认失败' };
      return { ok: true, method: 'cdp:backspace' };
    }

    // ---- 写入：剪贴板工具 ----
    {
      // 写剪贴板绝不能信任返回值：execCommand('copy') 在后台页会返回 true 但实际
      // 没写进系统剪贴板（实测，曾把上一次任务的旧剪贴板内容贴进文档造成污染）。
      // 所以：优先 async Clipboard API（失败会真拒绝），execCommand 原子「重选+复制」
      // 兜底；每次写完都用隐藏 textarea 执行一次 paste 回读，和暂存节点比对，
      // 校验不过就重试，三次都不行直接报错——宁可失败也不能把旧内容贴进文档。
      // 纯文本模式只给 text/plain 口味（原始 Markdown），飞书自己解析转块
      const plainOnly = base.plainOnly === true;
      const writeClip = async (): Promise<void> => {
        await chrome.debugger.sendCommand(dbg, 'Runtime.evaluate', {
          expression: `(async () => {
            const d = document.getElementById('larksnap-cdp-stage');
            if (!d) return 'no-stage';
            try {
              const flavors = { 'text/plain': new Blob([d.innerText], { type: 'text/plain' }) };
              if (!${plainOnly}) {
                flavors['text/html'] = new Blob([d.innerHTML], { type: 'text/html' });
              }
              await navigator.clipboard.write([new ClipboardItem(flavors)]);
              return 'ok';
            } catch (e) {
              // 兜底：同一段同步脚本里原子完成「重选暂存节点 + 复制」（分两步会被
              // 页面异步组件插队清选区）
              d.focus();
              const s = window.getSelection();
              const r = document.createRange();
              r.selectNodeContents(d);
              s.removeAllRanges();
              s.addRange(r);
              document.execCommand('copy');
              return 'fallback';
            }
          })()`,
          userGesture: true,
          awaitPromise: true,
          returnByValue: true,
        });
      };
      const verifyClip = async (): Promise<boolean> => {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            // 隐藏 textarea 里 paste 一次，回读系统剪贴板的纯文本口味和暂存节点比对
            const d = document.getElementById('larksnap-cdp-stage');
            const want = (d?.innerText || '').replace(/\s+/g, '');
            if (!want) return false;
            const ta = document.createElement('textarea');
            ta.style.cssText = 'position:fixed;left:-99999px;top:0;';
            document.body.appendChild(ta);
            ta.focus();
            document.execCommand('paste');
            const got = ta.value.replace(/\s+/g, '');
            ta.remove();
            return got.slice(0, 30) === want.slice(0, 30);
          },
        });
        return r?.result === true;
      };
      const ensureClipboard = async (): Promise<boolean> => {
        for (let i = 0; i < 3; i++) {
          await writeClip();
          if (await verifyClip()) return true;
          await sleep(400);
        }
        return false;
      };

      // ---- 分片粘贴：飞书 md 解析对单次粘贴有量的上限（20KB 实测在 238 块处
      // 截断丢尾），append 大内容按顶层块边界切成小片逐片贴 ----
      const chunks =
        plainOnly && base.mode === 'append'
          ? splitMarkdown(base.text ?? '', 6000)
          : [base.text ?? ''];
      let firstLocate: EditorStepResult | null = null;
      for (let ci = 0; ci < chunks.length; ci++) {
        // 后续片一律贴到文末（前一片粘贴后文档结构已变，原锚点失效）
        const chunkPatch = ci === 0 ? {} : { blockId: undefined };
        const staged = (await step({
          ...chunkPatch,
          action: 'stage-copy',
          text: chunks[ci],
        })) as EditorStepResult;
        if (!staged?.ok) return staged ?? { ok: false, message: '复制台搭建失败' };
        if (!(await ensureClipboard())) {
          return {
            ok: false,
            message: '内容写入系统剪贴板失败（回读校验三次未通过），为避免贴入旧内容已中止',
          };
        }
        const tg = (await step({ ...chunkPatch, action: 'locate' })) as EditorStepResult;
        if (!tg?.ok) return tg ?? { ok: false, message: '目标定位失败' };
        if (ci === 0) firstLocate = tg;
        await click(tg.x ?? 0, tg.y ?? 0);
        await sleep(400); // 等编辑器完成光标定位

        if (base.mode === 'replace' && ci === 0) {
          // Esc：光标所在块进入"块选中"态，之后的粘贴替换整块
          await key({ key: 'Escape', code: 'Escape', vk: 27 });
        } else {
          // append / after：光标已在锚点块末尾，先回车新起一块再粘贴，
          // 否则粘贴的首段会并进锚点块内部（标题块尤其难看）
          await key({ key: 'Enter', code: 'Enter', vk: 13 });
        }
        await sleep(300);

        // 粘贴走内容脚本世界的 execCommand('paste')（需要 clipboardRead 权限）：
        // 浏览器会对焦点编辑器派发真正可信的 paste 事件，飞书按正常粘贴处理。
        // mac 上 CDP 按键附带的 Paste 编辑命令进不了渲染进程，不能依赖。
        const [pasted] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => document.execCommand('paste'),
        });
        if (pasted?.result !== true) {
          // 退回可信按键（Windows/Linux 上修饰键组合由渲染进程自己映射）
          await key({ key: 'v', code: 'KeyV', vk: 86, commands: ['Paste'] });
        }
        // 每片都等飞书把 md 转完块再继续（渐进式转换，急着走会截断/错位）
        await step({
          action: 'settle',
          timeoutMs: Math.min(60000, 5000 + chunks[ci].length * 2),
        });
      }

      const vr = (await step({
        action: 'verify',
        textLenBefore: firstLocate?.textLenBefore,
        fingerprintExisted: firstLocate?.fingerprintExisted,
        tailExisted: firstLocate?.tailExisted,
        // 大内容飞书要渲染更久，超时按内容大小自适应（19KB 实测 5s 不够）
        timeoutMs: Math.min(30000, 5000 + (base.text?.length ?? 0)),
      })) as EditorStepResult;
      if (!vr?.ok) return vr ?? { ok: false, message: '写入确认失败' };
      return { ok: true, method: 'cdp:paste' };
    }
  } finally {
    try {
      await chrome.debugger.detach(dbg);
    } catch {
      /* 标签页可能已关闭 */
    }
  }
}

// ==================== 主世界注入 ====================

async function runInPage<A extends unknown[], R>(
  tabId: number,
  func: (...args: A) => R,
  ...args: A
): Promise<Awaited<R>> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func,
    args: args as never,
  });
  return results[0]?.result as Awaited<R>;
}
