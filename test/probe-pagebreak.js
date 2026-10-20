/* 诊断：每页最后一块 / 下一页第一块的关系，判断页面底部空白是「块太高放不下」还是「分页逻辑提前断页」。
   用法: node probe-pagebreak.js [docx路径]   不给路径则用内置长段落样例。 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const APP = path.join(OUT, '_pagebreak.html');

const CHROMES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
];
const BROWSER = CHROMES.find(p => fs.existsSync(p));
const PORT = 9601 + (process.pid % 90);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 造一份「段落都很长」的文档，模拟用户那种情况 */
function longParas() {
  const seed = '叉车作业时严格执行作业标准，按照货物摆放位置和车辆载荷要求控制倾斜用度，' +
    '水平位移与纵向位移分开操作，做到稳定、稳运、稳放。专管归位，守牢现场“责任田”。' +
    '叉车仅限用于笼车卸车、空笼车装车作业，严禁擅自挪作他用，确有特殊需要的须提前报部门负责人审批。' +
    '作业完成后，笼车一律放置于规定标线区域内，不越线摆放、不随意堆放，确保通道畅通。';
  const paras = [];
  for (let i = 0; i < 14; i++) {
    let t = '第' + (i + 1) + '段。';
    while (t.length < 190) t += seed;
    paras.push(t);
  }
  return paras;
}

function buildSample() {
  const lines = ['关于现场作业标准化管理的通知', '各部门：', ''];
  for (const p of longParas()) lines.push(p, '');
  return lines.join('\n');
}

(async () => {
  if (!BROWSER) { console.error('找不到浏览器'); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), APP);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-pb-'));
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
  if (!ws) { console.error('CDP 连接失败'); process.exit(1); }

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

  await send('Runtime.enable'); await send('DOM.enable'); await send('Page.enable');
  await send('Page.reload', { ignoreCache: true });
  await sleep(1600);
  const ev = async expr =>
    (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result.value;

  const arg = process.argv[2] && process.argv[2] !== '-' ? process.argv[2] : '';
  if (arg && fs.existsSync(arg)) {
    const doc = await send('DOM.getDocument', { depth: -1 });
    const n = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
    await send('DOM.setFileInputFiles', { nodeId: n.nodeId, files: [arg] });
    await ev('document.getElementById("file").dispatchEvent(new Event("change",{bubbles:true}));true');
    await sleep(2000);
  } else {
    await ev('document.getElementById("src").value=' + JSON.stringify(buildSample()) + ';' +
      'document.getElementById("src").dispatchEvent(new Event("input",{bubbles:true}));true');
    await sleep(1400);
  }

  const expr = [
    '(function(){',
    '  const host=document.getElementById("pages");',
    '  const prev=host.style.transform; host.style.transform="none";',
    '  const pages=[...host.querySelectorAll(".page")];',
    '  const out=[];',
    '  pages.forEach((pg,pi)=>{',
    '    const cs=getComputedStyle(pg);',
    '    const padT=parseFloat(cs.paddingTop)||0, padB=parseFloat(cs.paddingBottom)||0;',
    '    const avail=pg.offsetHeight-padT-padB;',
    '    const doc=pg.querySelector(".doc");',
    '    const kids=[...doc.children];',
    '    const used=kids.reduce((s,el)=>s+el.offsetHeight,0);',
    '    const last=kids[kids.length-1];',
    '    const lastRect=last?last.getBoundingClientRect():null;',
    '    const docRect=doc.getBoundingClientRect();',
    '    const rest=lastRect?(docRect.top+avail)-(lastRect.top+lastRect.height):0;',
    '    out.push({page:pi+1,avail:Math.round(avail),used:Math.round(used),',
    '      pct:Math.round(used/avail*100),kids:kids.length,',
    '      restBlank:Math.round(rest),',
    '      lastH:last?Math.round(lastRect.height):0,',
    '      lastCls:last?last.className:"",',
    '      lastTxt:last?last.textContent.slice(0,26):""});',
    '  });',
    '  host.style.transform=prev;',
    '  return {pages:pages.length, detail:out};',
    '})()'
  ].join('\n');

  const res = await ev(expr);
  console.log('页数:', res.pages);
  console.log('');
  for (const p of res.detail) {
    console.log('第 ' + p.page + ' 页  可用 ' + p.avail + 'px  已用 ' + p.used + 'px (' + p.pct + '%)  ' +
      '块 ' + p.kids + '  底部余 ' + p.restBlank + 'px');
    console.log('        末块 ' + p.lastCls + ' 高 ' + p.lastH + 'px  「' + p.lastTxt + '」');
  }
  console.log('');
  console.log('判读：若某页「底部余」很大（>150px），说明下一块整段装不下 → 预览把整段挪到下一页；');
  console.log('      Word 里长段落会跨页续排，所以这是预览与 Word 的真实差异。');

  sock.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
