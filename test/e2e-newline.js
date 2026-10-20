/* 换行保留回归测试（m01919 用户反馈）：
   用户从 Word 复制带格式文本 → 粘贴进文本框 → 预览里换行全没了。
   根因两条：
     ① textarea 里混入 \r / \u2028 / \u2029 等软换行，解析器只处理了 \r\n；
     ② 段落合并循环无条件把相邻非空行拼接，Word 形态（一段一行、段间无空行）被并成一段。
   本测试在真实浏览器里覆盖：真实粘贴事件（含多种分隔符）、纯文本键入、预览段落数。 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];
const BROWSER = CANDIDATES.find(p => fs.existsSync(p));
if (!BROWSER) { console.error('找不到浏览器'); process.exit(1); }

const appPath = path.join(OUT, '_e2e-nl.html');
fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), appPath);
const PORT = 9941;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-nl2-'));
const fileUrl = 'file:///' + appPath.replace(/\\/g, '/');

const browser = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--allow-file-access-from-files',
  '--disable-breakpad', '--disable-crash-reporter',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, fileUrl
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wsUrl() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch (e) {}
    await sleep(250);
  }
  throw new Error('调试端口未就绪');
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0; const waiting = new Map(); const exceptions = [];
    ws.addEventListener('open', () => resolve({
      exceptions,
      send(method, params) {
        return new Promise((res, rej) => {
          const mid = ++id; waiting.set(mid, { res, rej });
          ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
        });
      },
      close() { try { ws.close(); } catch (e) {} }
    }));
    ws.addEventListener('error', () => reject(new Error('WebSocket 错误')));
    ws.addEventListener('message', ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        exceptions.push((d.exception && d.exception.description) || d.text);
      }
      if (m.id && waiting.has(m.id)) {
        const w = waiting.get(m.id); waiting.delete(m.id);
        if (m.error) w.rej(new Error(JSON.stringify(m.error))); else w.res(m.result);
      }
    });
  });
}

const problems = [];
function check(label, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (extra ? '  ' + extra : ''));
  if (!cond) problems.push(label + (extra ? ' — ' + extra : ''));
}

/* Word 复制出的形态：一段一行，段间无空行 */
const WORDPASTE_LINES = [
  '卷烟物流配送中心“四个强化”夯实运营管理根基',
  '近日，卷烟物流配送中心聚焦运行管控、制度流程、成本压降、精益提升四项重点精准发力，推动整体运行平稳有序、提质增效。',
  '强化全域管控，下好协同联动“一盘棋”。针对区域物流业务模式，中心搭建一体化联动管控模式。',
  '强化制度执行，立好规范运营“一把尺”。对照业务模式，全面梳理干线交接作业流程。',
  '强化成本管控，算好节约降耗“一笔账”。聚焦车辆运维、燃油消耗等可控支出实施精细化管理。',
  '强化精益赋能，打好提质增效“一套拳”。聚焦配送效率、服务品质推进流程再造。'
];

(async () => {
  const cdp = await connect(await wsUrl());
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1600);

  async function evalJs(expr, awaitPromise) {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: !!awaitPromise, userGesture: true });
    if (r.exceptionDetails) throw new Error('页面异常: ' + ((r.exceptionDetails.exception
      && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result.value;
  }
  const clearAll = () => evalJs(`(() => {
    const ta = document.getElementById('src');
    ta.value = '';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const previewBlocks = () => evalJs(`(() => {
    const out = [];
    for (const el of document.querySelectorAll('#pages .doc > *')) {
      const t = (el.textContent || '').trim();
      if (t) out.push({ cls: el.className, text: t });
    }
    return JSON.stringify(out);
  })()`);

  /* ① 真实粘贴事件：text/plain 用 \r\n（Windows 剪贴板最常见） */
  console.log('=== 1. 粘贴 \\r\\n 换行（Windows/Word 常见）===');
  await clearAll();
  const wordCRLF = WORDPASTE_LINES.join('\r\n');
  await evalJs(`(() => {
    const ta = document.getElementById('src');
    const dt = new DataTransfer();
    dt.setData('text/plain', ${JSON.stringify(wordCRLF)});
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    ta.dispatchEvent(ev);
    return true;
  })()`);
  await sleep(900);
  let r = JSON.parse(await evalJs(`JSON.stringify({
    newlines: (document.getElementById('src').value.match(/\\n/g) || []).length,
    hasCR: /\\r/.test(document.getElementById('src').value),
    nonEmptyLines: document.getElementById('src').value.split('\\n').filter(x => x.trim()).length
  })`));
  check('粘贴后 \\r 已被消除', r.hasCR === false, 'hasCR=' + r.hasCR);
  check('粘贴后保留 5 个换行', r.newlines === 5, r.newlines + ' 个 \\n');
  check('粘贴后非空行 = 6', r.nonEmptyLines === 6, r.nonEmptyLines + ' 行');
  let pv = JSON.parse(await previewBlocks());
  check('预览保留 6 个段落（不被合并）', pv.length === 6, pv.length + ' 块');

  /* ② 粘贴含 U+2029（部分应用用段落分隔符） */
  console.log('\n=== 2. 粘贴 U+2029 段落分隔符 ===');
  await clearAll();
  const wordPS = WORDPASTE_LINES.join('\u2029');
  await evalJs(`(() => {
    const ta = document.getElementById('src');
    const dt = new DataTransfer();
    dt.setData('text/plain', ${JSON.stringify(wordPS)});
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return true;
  })()`);
  await sleep(900);
  r = JSON.parse(await evalJs(`JSON.stringify({
    hasPS: /\\u2029/.test(document.getElementById('src').value),
    newlines: (document.getElementById('src').value.match(/\\n/g) || []).length
  })`));
  check('粘贴后 U+2029 已转为 \\n', r.hasPS === false, 'hasPS=' + r.hasPS);
  check('U+2029 转换后换行数正确', r.newlines === 5, r.newlines + ' 个 \\n');
  pv = JSON.parse(await previewBlocks());
  check('U+2029 场景预览保留 6 段', pv.length === 6, pv.length + ' 块');

  /* ③ 只有 text/html flavor 时（少数应用） */
  console.log('\n=== 3. 剪贴板只给 text/html 时兜底 ===');
  await clearAll();
  const htmlFlavor = '<p>' + WORDPASTE_LINES.map(l => l).join('</p><p>') + '</p>';
  await evalJs(`(() => {
    const ta = document.getElementById('src');
    const dt = new DataTransfer();
    dt.setData('text/html', ${JSON.stringify(htmlFlavor)});
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return true;
  })()`);
  await sleep(900);
  pv = JSON.parse(await previewBlocks());
  check('HTML flavor 兜底也能分出多段', pv.length >= 6, pv.length + ' 块');

  /* ④ 直接赋值（不经粘贴事件）也必须分得开 */
  console.log('\n=== 4. 直接赋值（模拟脚本填入 / 文件读入）===');
  await clearAll();
  await evalJs(`(() => {
    const ta = document.getElementById('src');
    ta.value = ${JSON.stringify(WORDPASTE_LINES.join('\n'))};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(900);
  pv = JSON.parse(await previewBlocks());
  check('直接赋值也保留 6 段', pv.length === 6, pv.length + ' 块');
  if (pv.length === 6) {
    check('首段识别为主标题', /blk-title/.test(pv[0].cls), pv[0].cls);
    check('第 2 段是正文且未被并入标题', /blk-body/.test(pv[1].cls), pv[1].cls);
  }

  /* ⑤ 硬折行文本仍应合并（不能为了修 bug 破坏原能力） */
  console.log('\n=== 5. 硬折行文本仍应合并为一段 ===');
  await clearAll();
  const hardWrap = [
    '关于测试硬折行合并的通知',
    '这是第一段的内容，它被硬折行切成了好几个物理行，',
    '每一行都不长，也没有句末标点，',
    '最后在这里结束。'
  ].join('\n');
  await evalJs(`(() => {
    const ta = document.getElementById('src');
    ta.value = ${JSON.stringify(hardWrap)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(900);
  pv = JSON.parse(await previewBlocks());
  const bodyBlocks = pv.filter(b => /blk-body/.test(b.cls));
  check('硬折行仍合并成 1 个正文段', bodyBlocks.length === 1, bodyBlocks.length + ' 个正文块');
  if (bodyBlocks.length === 1) {
    check('合并后包含全部三行内容',
      /每一行都不长/.test(bodyBlocks[0].text) && /最后在这里结束/.test(bodyBlocks[0].text),
      bodyBlocks[0].text.slice(0, 50));
  }

  console.log('\n=== 6. 控制台错误 ===');
  check('无未捕获错误', cdp.exceptions.length === 0, JSON.stringify(cdp.exceptions));

  cdp.close(); browser.kill();
  console.log('\n' + '='.repeat(56));
  if (problems.length) {
    console.log('失败项 (' + problems.length + '):');
    problems.forEach(x => console.log('  * ' + x));
    process.exitCode = 1;
  } else console.log('换行保留：全部通过');
})().catch(e => {
  console.error('异常:', e.message);
  try { browser.kill(); } catch (x) {}
  process.exitCode = 1;
});
