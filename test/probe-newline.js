/* 探针：模拟「从 Word 复制」的纯文本（段间只有单个 \n，无空行），
   检查 ① textarea 里换行是否还在；② 预览里换行是否被合并掉。 */
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
const appPath = path.join(OUT, '_probe-nl.html');
fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), appPath);
const PORT = 9933;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-nl-'));
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

(async () => {
  const cdp = await connect(await wsUrl());
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1500);

  async function evalJs(expr, awaitPromise) {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: !!awaitPromise, userGesture: true });
    if (r.exceptionDetails) throw new Error('页面异常: ' + ((r.exceptionDetails.exception
      && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result.value;
  }

  // Word 复制出来的纯文本：每段一行，段间单个换行，无空行
  const wordPaste = [
    '关于进一步加强信息化建设工作的通知',
    '各部门、各直属单位：',
    '为深入贯彻落实上级关于数字化转型的决策部署，进一步提升我单位信息化建设水平，现将有关事项通知如下。',
    '一、总体要求',
    '坚持以需求为导向、以应用为核心，统筹推进基础设施、业务系统与数据资源的协调发展。',
    '二、重点任务',
    '加快网络升级改造，提升带宽保障能力。',
    '三、工作要求',
    '各单位要高度重视，明确专人负责，确保各项任务按期完成。'
  ].join('\n');

  console.log('=== 输入（Word 复制形态，段间单个 \\n）===');
  console.log(wordPaste.split('\n').map((l, i) => '  ' + (i + 1) + '. ' + l).join('\n'));
  console.log('  换行符数: ' + (wordPaste.match(/\n/g) || []).length);

  const r = JSON.parse(await evalJs(`(() => {
    const ta = document.getElementById('src');
    ta.value = ${JSON.stringify(wordPaste)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return JSON.stringify({
      textareaNewlines: (ta.value.match(/\\n/g) || []).length,
      textareaLines: ta.value.split('\\n').length,
      textareaValue: ta.value
    });
  })()`));

  console.log('\n=== textarea 内 ===');
  console.log('  换行符数: ' + r.textareaNewlines + '   行数: ' + r.textareaLines);
  console.log('  与输入完全一致: ' + (r.textareaValue === wordPaste));

  await sleep(900);

  const p = JSON.parse(await evalJs(`JSON.stringify({
    stats: document.getElementById('stStats').textContent,
    blocks: (window.__blocks || null)
  })`));

  const pv = JSON.parse(await evalJs(`(() => {
    const out = [];
    for (const el of document.querySelectorAll('#pages .doc > *')) {
      const t = (el.textContent || '').trim();
      if (t) out.push({ cls: el.className, text: t });
    }
    return JSON.stringify(out);
  })()`));

  console.log('\n=== 预览区实际渲染的段落 ===');
  pv.forEach((b, i) => console.log('  [' + i + '] [' + (b.cls || '-') + '] ' + b.text.slice(0, 70)));
  console.log('\n  预览段落数: ' + pv.length + '   （输入有 9 个非空行）');
  console.log('  状态栏: ' + p.stats);

  cdp.close(); browser.kill();
  process.exit(0);
})().catch(e => {
  console.error('异常:', e.message);
  try { browser.kill(); } catch (x) {}
  process.exit(1);
});
