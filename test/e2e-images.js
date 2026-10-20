/* 图片保留测试：读入带图的 .docx → 重新排版 → 检查产出是否仍含图片。
   这是「已知未完成点」的验证。 */
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
const appPath = path.join(OUT, '_e2e-img.html');
fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), appPath);
const PORT = 9903;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-img-'));
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

  const f = path.join(OUT, 'with-images.docx');
  console.log('=== 读入带图 .docx ===');
  check('测试文件存在', fs.existsSync(f), f);
  await setFile([f]);
  await sleep(1900);

  const read = await evalJs(`JSON.stringify({
    fileInfo: document.getElementById('fileInfo').textContent.trim(),
    src: document.getElementById('src').value,
    imagePlaceholders: (document.getElementById('src').value.match(/\\[图片[：:]/g) || []).length,
    pvText: document.getElementById('pages').textContent.slice(0, 150)
  })`);
  console.log('  fileInfo: ' + JSON.parse(read).fileInfo);
  console.log('  文本框前 200 字: ' + JSON.parse(read).src.slice(0, 200).replace(/\n/g, ' ⏎ '));
  let r = JSON.parse(read);
  check('读入时识别出 2 张图片', r.imagePlaceholders === 2, r.imagePlaceholders + ' 个占位');

  console.log('\n=== 重新排版并导出 ===');
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
    const outp = path.join(OUT, 'reflowed-with-images.docx');
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
  } else console.log('图片保留：全部通过');
})().catch(e => {
  console.error('异常:', e.message);
  try { browser.kill(); } catch (x) {}
  process.exitCode = 1;
});
