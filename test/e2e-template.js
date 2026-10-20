/* 用户正规模板端到端测试：
   读入用户实际在用的公文 .docx，检查
     ① 预览区段落的内联 + 计算样式确实体现「标题方正小标宋二号 / 正文仿宋_GB2312 三号 / 首行缩进 2 字符」；
     ② 导出的 .docx 与预览一致（字体、字号、缩进、行距）。
   这是 m00721 反馈「预览里没有实现」的回归防线。 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const TEMPLATE = process.argv[2] ||
  'D:\\Work\\政务信息\\2026\\2026.6.23卷烟物流配送中心“四个强化”夯实运营管理根基.docx';

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];
const BROWSER = CANDIDATES.find(p => fs.existsSync(p));
if (!BROWSER) { console.error('找不到浏览器'); process.exit(1); }
if (!fs.existsSync(TEMPLATE)) { console.error('模板不存在: ' + TEMPLATE); process.exit(1); }

const appPath = path.join(OUT, '_e2e-tpl.html');
fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), appPath);
const PORT = 9917;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-tpl-'));
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

(async () => {
  const cdp = await connect(await wsUrl());
  await cdp.send('Runtime.enable'); await cdp.send('DOM.enable'); await cdp.send('Page.enable');
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1500);

  async function evalJs(expr, awaitPromise) {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: !!awaitPromise, userGesture: true });
    if (r.exceptionDetails) throw new Error('页面异常: ' + ((r.exceptionDetails.exception
      && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result.value;
  }
  async function setFile(files) {
    const doc = await cdp.send('DOM.getDocument', { depth: -1 });
    const n = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
    await cdp.send('DOM.setFileInputFiles', { nodeId: n.nodeId, files });
    await evalJs(`document.getElementById('file').dispatchEvent(new Event('change',{bubbles:true})); true`);
  }

  console.log('=== 读入用户正规模板 ===');
  console.log('  ' + TEMPLATE);
  await setFile([TEMPLATE]);
  await sleep(2000);

  const info = JSON.parse(await evalJs(`JSON.stringify({
    fileInfo: document.getElementById('fileInfo').textContent.trim(),
    stats: document.getElementById('stStats').textContent,
    preview: (() => {
      const out = [];
      for (const el of document.querySelectorAll('#pages .doc > *')) {
        const cs = getComputedStyle(el);
        const t = (el.textContent || '').trim();
        if (!t) continue;
        out.push({
          cls: el.className,
          text: t.slice(0, 22),
          inlineFF: el.style.fontFamily || '(unset)',
          ff: cs.fontFamily.split(',')[0].replace(/["']/g, ''),
          sizePx: parseFloat(cs.fontSize),
          sizePt: +(parseFloat(cs.fontSize) * 72 / 96).toFixed(1),
          indentPx: parseFloat(cs.textIndent) || 0,
          align: cs.textAlign, weight: cs.fontWeight,
          linePx: parseFloat(cs.lineHeight)
        });
      }
      return out;
    })()
  })`));

  console.log('  fileInfo: ' + info.fileInfo);
  console.log('  stats: ' + info.stats);
  console.log('  --- 预览区实测样式 ---');
  for (const p of info.preview.slice(0, 8)) {
    console.log(`   [${p.cls || '-'}] ${p.text}`);
    console.log(`        font=${p.ff}  ${p.sizePt}pt(${p.sizePx}px)  indent=${p.indentPx}px  align=${p.align}  w=${p.weight}  lh=${p.linePx}px`);
  }

  // 断言：段落内联样式必须真的被浏览器接受（缺陷 E 的回归防线）
  const withFont = info.preview.filter(p => p.inlineFF !== '(unset)');
  check('段落内联 font-family 未被引号截断（缺陷 E 回归）',
    withFont.length === info.preview.length,
    withFont.length + '/' + info.preview.length + ' 段有内联字体');

  const title = info.preview.find(p => p.cls.indexOf('blk-title') >= 0);
  check('识别出主标题', !!title, title ? title.text : '无');
  if (title) {
    check('主标题字号 = 二号 22pt', Math.abs(title.sizePt - 22) < 0.6, title.sizePt + 'pt');
    check('主标题字体 = 方正小标宋简体', /方正小标宋/.test(title.ff), title.ff);
    check('主标题居中', title.align === 'center', title.align);
  }

  const body = info.preview.find(p => p.cls.indexOf('blk-body') >= 0);
  check('识别出正文段落', !!body, body ? body.text : '无');
  if (body) {
    check('正文字号 = 三号 16pt', Math.abs(body.sizePt - 16) < 0.6, body.sizePt + 'pt');
    check('正文字体 = 仿宋', /仿宋/.test(body.ff), body.ff);
    check('正文首行缩进 2 字符（=2em）',
      Math.abs(body.indentPx - body.sizePx * 2) < 1.5,
      body.indentPx + 'px ≈ 2×' + body.sizePx + 'px');
    check('正文两端对齐', body.align === 'justify', body.align);
  }

  const h1 = info.preview.find(p => p.cls.indexOf('blk-head') >= 0);
  if (h1) {
    check('一级标题字号 = 三号 16pt', Math.abs(h1.sizePt - 16) < 0.6, h1.sizePt + 'pt');
    check('一级标题字体 = 黑体', /黑体|SimHei/i.test(h1.ff), h1.ff);
  }

  console.log('\n=== 导出并检查产物与预览一致 ===');
  await evalJs(`(() => {
    window.__blob = null;
    const o = URL.createObjectURL.bind(URL);
    URL.createObjectURL = b => { window.__blob = b; return o(b); };
    HTMLAnchorElement.prototype.click = function(){ window.__clicked = this.download; };
    document.getElementById('btnRun').click();
    return true;
  })()`);

  let b64 = null;
  for (let i = 0; i < 48; i++) {
    await sleep(250);
    b64 = await evalJs(`(async () => {
      if (!window.__blob) return null;
      const b = new Uint8Array(await window.__blob.arrayBuffer());
      let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
      return btoa(s);
    })()`, true);
    if (b64) break;
  }
  check('产出 docx', !!b64);
  if (b64) {
    const buf = Buffer.from(b64, 'base64');
    const outp = path.join(OUT, 'reflowed-template.docx');
    fs.writeFileSync(outp, buf);
    console.log('  写出: ' + outp + '  ' + buf.length + ' 字节');
    check('产出是合法 ZIP', buf[0] === 0x50 && buf[1] === 0x4B);
  }

  console.log('\n=== 控制台错误 ===');
  check('无未捕获错误', cdp.exceptions.length === 0, JSON.stringify(cdp.exceptions));

  cdp.close(); browser.kill();
  console.log('\n' + '='.repeat(56));
  if (problems.length) {
    console.log('失败项 (' + problems.length + '):');
    problems.forEach(x => console.log('  * ' + x));
    process.exitCode = 1;
  } else console.log('正规模板对齐：全部通过');
})().catch(e => {
  console.error('异常:', e.message);
  try { browser.kill(); } catch (x) {}
  process.exitCode = 1;
});
