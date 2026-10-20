/* probe-gap2.js — 检查「只在标题后留空行」时空行到底落在哪些块之间
   用法：node test/probe-gap2.js [docx路径] */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const APP = path.join(OUT, '_probegap2.html');
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), APP);
  const PORT = 9951 + (process.pid % 40);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-gap2-'));
  spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--allow-file-access-from-files', '--disable-breakpad', '--disable-crash-reporter',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + prof,
    'file:///' + APP.replace(/\\/g, '/')], { stdio: 'ignore' });

  let ws = null;
  for (let i = 0; i < 100; i++) {
    try {
      const l = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const p = l.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) { ws = p.webSocketDebuggerUrl; break; }
    } catch (e) { /* noop */ }
    await sleep(250);
  }
  const sock = new WebSocket(ws);
  let id = 0; const w = new Map();
  await new Promise(r => sock.addEventListener('open', r));
  sock.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && w.has(m.id)) { w.get(m.id)(m.result); w.delete(m.id); }
  });
  const send = (method, params) => new Promise(r => {
    const i = ++id; w.set(i, r);
    sock.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  await send('Runtime.enable'); await send('DOM.enable'); await send('Page.enable');
  await send('Page.reload', { ignoreCache: true }); await sleep(1700);
  const ev = async expr => {
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true, userGesture: true
    });
    return r && r.result ? r.result.value : undefined;
  };

  const arg = process.argv[2];
  if (arg && fs.existsSync(arg)) {
    const doc = await send('DOM.getDocument', { depth: -1 });
    const n = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
    await send('DOM.setFileInputFiles', { nodeId: n.nodeId, files: [arg] });
    await ev('document.getElementById("file").dispatchEvent(new Event("change",{bubbles:true}));true');
  } else {
    await ev('document.getElementById("btnSample").click();true');
  }
  await sleep(2000);
  await ev([
    'var q=document.getElementById("q_blank");',
    'q.value="heading_gap";q.dispatchEvent(new Event("change",{bubbles:true}));true'
  ].join('\n'));
  await sleep(1600);

  /* 直接看解析出的块序列（不经过分页，只看文档流顺序） */
  const blks = await ev([
    '(function(){',
    '  var out=[];',
    '  document.querySelectorAll("#pages .doc > *").forEach(function(el){',
    '    var cls=(el.className||"").replace("blk-","");',
    '    out.push({cls:cls, txt:(el.textContent||"").replace(/\\u00a0/g,"").slice(0,18)});',
    '  });',
    '  return out;',
    '})()'
  ].join('\n'));

  console.log('块序列（共 ' + blks.length + '）：');
  let bad = 0;
  for (let i = 0; i < blks.length; i++) {
    const b = blks[i];
    const nx = blks[i + 1];
    let tag = '';
    if (b.cls === 'blank') {
      const prev = blks[i - 1], next = nx;
      if (prev && next) {
        const prevIsHead = /^(title|sub|head|att|cap)$/.test(prev.cls);
        const nextIsHead = /^(title|sub|head|att|cap)$/.test(next.cls);
        if (!prevIsHead) { tag = '  ✗ 空行前面不是标题（' + prev.cls + '）'; bad++; }
        else if (nextIsHead) { tag = '  ✗ 空行后面还是标题（' + next.cls + '）'; bad++; }
        else tag = '  ✓';
      }
    }
    console.log(('  ' + i).slice(-4) + '  ' + (b.cls || '?').padEnd(8) + '  ' + b.txt + tag);
  }
  console.log('\n空行位置错误: ' + bad);

  sock.close();
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e.message); process.exit(1); });
