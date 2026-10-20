/* probe-acc.js —— 验证分页的「高度累加」是否高估
   做法：在一页里放若干块，比较
     ① 累加法：Σ(块高 + 段后距)
     ② 真实几何：最后一块底边 − 第一块顶边
   若 ① > ②，说明相邻块的外边距被多算，页会提前断开、底部留白。
   用法: node probe-acc.js */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const APP = path.join(OUT, '_probe-acc.html');
const BROWSER = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const PORT = 9731 + (process.pid % 50);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SENT = '叉车作业时严格执行作业标准，按照货物摆放位置与重心要求分层码放，严禁超高、超重、倾斜堆码。';
const DOC = [];
for (let i = 1; i <= 8; i++) {
  let s = '第' + i + '段。';
  for (let k = 0; k < 3; k++) s += SENT;
  DOC.push(s);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), APP);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-acc-'));
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
  sock.addEventListener('message', e => {
    const m = JSON.parse(e.data);
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

  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.reload', { ignoreCache: true });
  await sleep(1600);
  await ev('(function(){var s=document.getElementById("src");s.value=' +
    JSON.stringify(DOC.join('\n')) + ';s.dispatchEvent(new Event("input",{bubbles:true}));return 1;})()');
  await sleep(1500);

  const data = await ev([
    '(function(){',
    '  var host=document.getElementById("pages");',
    '  var saved=host.style.transform; host.style.transform="none";',
    '  var page=host.querySelector(".page");',
    '  var cs=getComputedStyle(page);',
    '  var avail=page.clientHeight-(parseFloat(cs.paddingTop)||0)-(parseFloat(cs.paddingBottom)||0);',
    '  var kids=[...page.querySelector(".doc").children];',
    '  var sumH=0, sumMb=0, sumMt=0;',
    '  kids.forEach(function(k){',
    '    var ks=getComputedStyle(k);',
    '    sumH+=k.getBoundingClientRect().height;',
    '    sumMb+=parseFloat(ks.marginBottom)||0;',
    '    sumMt+=parseFloat(ks.marginTop)||0;',
    '  });',
    '  var first=kids[0].getBoundingClientRect();',
    '  var last=kids[kids.length-1].getBoundingClientRect();',
    '  var real=last.bottom-first.top;',
    '  host.style.transform=saved;',
    '  return {kids:kids.length, avail:Math.round(avail),',
    '          sumH:Math.round(sumH), sumMb:Math.round(sumMb*10)/10, sumMt:Math.round(sumMt*10)/10,',
    '          acc:Math.round(sumH+sumMb), real:Math.round(real),',
    '          diff:Math.round(sumH+sumMb-real)};',
    '})()'
  ].join('\n'));

  console.log('本页块数 ' + data.kids + '  可用高 ' + data.avail + 'px');
  console.log('  Σ块高            = ' + data.sumH + 'px');
  console.log('  Σ段后距(marginB) = ' + data.sumMb + 'px');
  console.log('  Σ段前距(marginT) = ' + data.sumMt + 'px');
  console.log('  累加法 Σ(高+段后) = ' + data.acc + 'px   ← 旧算法用的就是这个');
  console.log('  真实几何 首顶→末底 = ' + data.real + 'px');
  console.log('  高估 = ' + data.diff + 'px' + (data.diff > 1 ? '  ⚠ 累加法确实多算了' : '  基本一致'));

  sock.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
