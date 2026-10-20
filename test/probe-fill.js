/* probe-fill.js —— 量每页填充率（用于确认「页面下方空白太大」已修复）
   用法: node probe-fill.js [docx路径|-]  （不给路径则用内置长段落样例） */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const APP = path.join(OUT, '_probe-fill2.html');
const CHROMES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
];
const BROWSER = CHROMES.find(p => fs.existsSync(p));
const PORT = 9461 + (process.pid % 60);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DOCX = (process.argv[2] && process.argv[2] !== '-') ? process.argv[2] : '';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), APP);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-pf-'));
  spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
    '--allow-file-access-from-files', '--disable-breakpad', '--disable-crash-reporter',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + prof,
    'file:///' + APP.replace(/\\/g, '/')], { stdio: 'ignore' });

  let ws = null;
  for (let i = 0; i < 90; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const pg = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (pg) { ws = pg.webSocketDebuggerUrl; break; }
    } catch (e) { /* retry */ }
    await sleep(250);
  }
  const sock = new WebSocket(ws);
  let id = 0; const waiters = new Map();
  await new Promise(r => sock.addEventListener('open', r));
  sock.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m.result); waiters.delete(m.id); }
  });
  const send = (method, params) => new Promise(r => {
    const i = ++id; waiters.set(i, r);
    sock.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  const ev = async expr => {
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true, userGesture: true
    });
    return r && r.result ? r.result.value : undefined;
  };

  await send('Runtime.enable'); await send('DOM.enable'); await send('Page.enable');
  await send('Page.reload', { ignoreCache: true });
  await sleep(1700);

  if (DOCX) {
    const doc = await send('DOM.getDocument', { depth: -1 });
    const n = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
    await send('DOM.setFileInputFiles', { nodeId: n.nodeId, files: [DOCX] });
    await ev('document.getElementById("file").dispatchEvent(new Event("change",{bubbles:true}));true');
    await sleep(2200);
    console.log('目标: ' + DOCX);
  } else {
    await ev('document.getElementById("btnSample").click();true');
    await sleep(1500);
    console.log('目标: 内置示例');
  }

  const res = await ev([
    '(function(){',
    '  /* 关键：预览用 transform:scale 缩放，getBoundingClientRect 会带上缩放比，',
    '     而 computed padding 是布局值（不缩放），混用会算出错误的可用高度。',
    '     量之前必须先把 transform 摘掉，量完再还原。 */',
    '  const host=document.getElementById("pages");',
    '  const savedT=host.style.transform;',
    '  host.style.transform="none";',
    '  const pages=[...document.querySelectorAll("#pages .page")];',
    '  const out=[];',
    '  pages.forEach((p,i)=>{',
    '    const cs=getComputedStyle(p);',
    '    const padT=parseFloat(cs.paddingTop)||0, padB=parseFloat(cs.paddingBottom)||0;',
    '    const avail=p.getBoundingClientRect().height - padT - padB;',
    '    const doc=p.querySelector(".doc");',
    '    const kids=[...doc.children];',
    '    let used=0, rest=0, blanks=0, blankH=0;',
    '    if(kids.length){',
    '      const first=kids[0].getBoundingClientRect();',
    '      const last=kids[kids.length-1].getBoundingClientRect();',
    '      used=last.bottom-first.top;',
    '      const docTop=doc.getBoundingClientRect().top;',
    '      rest=(docTop+avail)-last.bottom;',
    '    }',
    '    kids.forEach(k=>{ if(k.classList.contains("blk-blank")){blanks++;blankH+=k.getBoundingClientRect().height;} });',
    '    out.push({p:i+1,kids:kids.length,avail:Math.round(avail),used:Math.round(used),',
    '      pct:Math.round(used/avail*100),rest:Math.round(rest),blanks:blanks,blankH:Math.round(blankH)});',
    '  });',
    '  host.style.transform=savedT;',
    '  return out;',
    '})()'
  ].join('\n'));

  if (!res) { console.log('量取失败（预览为空？）'); sock.close(); process.exit(1); }
  for (const r of res) {
    console.log('第 ' + r.p + ' 页  块 ' + r.kids + '  可用 ' + r.avail + 'px  占用 ' +
      r.used + 'px (' + r.pct + '%)  底部余 ' + r.rest + 'px  空行 ' + r.blanks +
      (r.blankH ? '（占 ' + r.blankH + 'px）' : ''));
  }
  const avg = Math.round(res.reduce((a, r) => a + r.pct, 0) / res.length);
  const total = res.reduce((a, r) => a + r.used, 0);
  const totalAvail = res.reduce((a, r) => a + r.avail, 0);
  console.log('---');
  console.log('共 ' + res.length + ' 页  平均填充 ' + avg + '%  总填充率 ' +
    Math.round(total / totalAvail * 100) + '%（' + Math.round(total) + '/' + Math.round(totalAvail) + 'px）');

  sock.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
