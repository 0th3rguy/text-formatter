/* shot-final.js — 分页效果最终截图 + 填充率断言
   用法：node test/shot-final.js [docx路径]   不给则用内置示例 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const APP = path.join(OUT, '_shotfinal.html');

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, got) => {
  if (ok) { pass++; console.log('  PASS  ' + name + (got !== undefined && got !== '' ? '  ' + got : '')); }
  else { fail++; console.log('  FAIL  ' + name + '  ' + (got !== undefined ? got : '')); }
};

(async () => {
  if (!CHROME) { console.error('找不到 Chrome'); process.exit(1); }
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), APP);

  const PORT = 9901 + (process.pid % 60);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-shotfinal-'));
  const child = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
    '--allow-file-access-from-files', '--disable-breakpad', '--disable-crash-reporter',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    'file:///' + APP.replace(/\\/g, '/')
  ], { stdio: 'ignore' });

  let ws = null;
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) { ws = page.webSocketDebuggerUrl; break; }
    } catch (e) { /* 还没起来 */ }
    await sleep(250);
  }
  if (!ws) { child.kill(); throw new Error('Chrome 未就绪'); }

  const sock = new WebSocket(ws);
  let id = 0;
  const waiting = new Map();
  await new Promise(r => sock.addEventListener('open', r));
  sock.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); }
  });
  const send = (method, params) => new Promise(r => {
    const i = ++id; waiting.set(i, r);
    sock.send(JSON.stringify({ id: i, method, params: params || {} }));
  });

  await send('Runtime.enable');
  await send('DOM.enable');
  await send('Page.enable');
  await send('Page.reload', { ignoreCache: true });
  await sleep(1800);

  const ev = async expr => {
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true, userGesture: true
    });
    return r && r.result ? r.result.value : undefined;
  };

  console.log('=== 载入测试文档 ===');
  const arg = process.argv[2];
  if (arg && fs.existsSync(arg)) {
    const doc = await send('DOM.getDocument', { depth: -1 });
    const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
    await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [arg] });
    await ev('document.getElementById("file").dispatchEvent(new Event("change",{bubbles:true}));true');
    await sleep(2400);
    console.log('  载入: ' + path.basename(arg));
  } else {
    await ev('document.getElementById("btnSample").click();true');
    await sleep(1800);
    console.log('  载入内置示例');
  }

  /* 用「只在标题后留空行」—— 最常见公文版式 */
  await ev([
    'var q=document.getElementById("q_blank");',
    'if(q){q.value="heading_gap";q.dispatchEvent(new Event("change",{bubbles:true}));}',
    'true'
  ].join('\n'));
  await sleep(1500);

  const pages = await ev([
    '(function(){',
    '  var host=document.getElementById("pages");',
    '  var saved=host.style.transform; host.style.transform="none";',
    '  var PX=96/2.54;',
    '  var out=[...host.querySelectorAll(".page")].map(function(p){',
    '    var cs=getComputedStyle(p);',
    '    var avail=29.7*PX-(parseFloat(cs.paddingTop)||0)-(parseFloat(cs.paddingBottom)||0);',
    '    var kids=[...p.querySelector(".doc").children];',
    '    if(!kids.length) return {avail:Math.round(avail),used:0,pct:0,kids:0};',
    '    var top0=kids[0].getBoundingClientRect().top, bot=null;',
    '    kids.forEach(function(k){ bot=k.getBoundingClientRect().bottom; });',
    '    var used=bot-top0;',
    '    return {avail:Math.round(avail),used:Math.round(used),',
    '            pct:Math.round(used/avail*100),kids:kids.length};',
    '  });',
    '  host.style.transform=saved;',
    '  return out;',
    '})()'
  ].join('\n'));

  console.log('  各页填充率: ' + JSON.stringify(pages.map(p => p.pct)));
  check('多页正常分页', pages.length >= 1, pages.length + ' 页');
  const nonLast = pages.slice(0, -1);
  const worst = nonLast.length ? Math.max.apply(null, nonLast.map(p => p.avail - p.used)) : 0;
  check('非末页底部余量 ≤ 120px', worst <= 120, '最大 ' + Math.round(worst) + 'px');
  check('无内容溢出', pages.every(p => p.used <= p.avail + 2), '');
  check('无空页', pages.every(p => p.kids > 0), '');

  await send('Emulation.setDeviceMetricsOverride', {
    width: 1400, height: 980, deviceScaleFactor: 2, mobile: false
  });
  await sleep(700);

  const box = await ev([
    '(function(){',
    '  var p=document.querySelector("#pages .page");',
    '  if(!p) return null;',
    '  var r=p.getBoundingClientRect();',
    '  return {x:Math.round(r.left),y:Math.round(r.top),',
    '          width:Math.round(r.width),height:Math.round(r.height)};',
    '})()'
  ].join('\n'));
  if (box) {
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 }
    });
    const p1 = path.join(OUT, 'ui-final-page1.png');
    fs.writeFileSync(p1, Buffer.from(shot.data, 'base64'));
    console.log('  截图: ' + p1 + '  ' + box.width + 'x' + box.height);
  }

  const full = await send('Page.captureScreenshot', { format: 'png' });
  const p2 = path.join(OUT, 'ui-final-full.png');
  fs.writeFileSync(p2, Buffer.from(full.data, 'base64'));
  console.log('  截图: ' + p2);

  const errs = await ev('(window.__errs||[]).length');
  check('无未捕获错误', errs === 0, String(errs));

  console.log('\n' + '='.repeat(56));
  console.log('最终效果：' + (fail ? 'FAIL=' + fail : '全部通过') + '  PASS=' + pass);
  sock.close();
  child.kill();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e.message); process.exit(1); });
