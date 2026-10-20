/* probe-frac.js —— 诊断分页「该切没切」：逐页量每块的 rect 高、段后距、可用高，
   看是否出现「文字排得下、只是段后距越界」的情况（这会导致整段被推到下一页）。
   用法: node probe-frac.js [docx路径|-] */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const APP = path.join(OUT, '_probe-frac.html');
const BROWSER = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const PORT = 9631 + (process.pid % 60);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const arg = (process.argv[2] && process.argv[2] !== '-') ? process.argv[2] : '';

const LONG = (() => {
  const parts = [];
  for (let i = 1; i <= 14; i++) {
    parts.push('第' + i + '段。叉车作业时严格执行作业标准，按照货物摆放位置与重心要求分层码放，' +
      '严禁超高、超重、倾斜堆码；作业前检查货叉与门架，确认无异常方可作业。' +
      '装卸过程中保持匀速平稳，转弯减速鸣笛，确保人员与货物安全。');
  }
  return parts.join('\n');
})();

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), APP);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-frac-'));
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

  if (arg) {
    const b64 = fs.readFileSync(arg).toString('base64');
    await ev([
      '(async function(){',
      '  var bin=atob(' + JSON.stringify(b64) + ');',
      '  var u=new Uint8Array(bin.length);',
      '  for(var i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i);',
      '  var f=new File([u],"t.docx",{type:"application/vnd.openxmlformats-officedocument.wordprocessingml.document"});',
      '  var dt=new DataTransfer(); dt.items.add(f);',
      '  var inp=document.getElementById("file");',
      '  inp.files=dt.files;',
      '  inp.dispatchEvent(new Event("change",{bubbles:true}));',
      '  return 1;',
      '})()'
    ].join('\n'));
    await sleep(2600);
  } else {
    await ev('(function(){var s=document.getElementById("src");s.value=' +
      JSON.stringify(LONG) + ';s.dispatchEvent(new Event("input",{bubbles:true}));return 1;})()');
    await sleep(1500);
  }

  /* 摘掉缩放再量，否则 rect 会被乘上缩放比 */
  const data = await ev([
    '(function(){',
    '  var host=document.getElementById("pages");',
    '  var saved=host.style.transform;',
    '  host.style.transform="none";',
    '  var pages=[...host.querySelectorAll(".page")];',
    '  var out=[];',
    '  pages.forEach(function(p,pi){',
    '    var cs=getComputedStyle(p);',
    '    var avail=p.clientHeight-(parseFloat(cs.paddingTop)||0)-(parseFloat(cs.paddingBottom)||0);',
    '    var doc=p.querySelector(".doc");',
    '    var kids=[...doc.children];',
    '    var used=0, rows=[];',
    '    kids.forEach(function(k){',
    '      var r=k.getBoundingClientRect();',
    '      var ks=getComputedStyle(k);',
    '      var mb=parseFloat(ks.marginBottom)||0;',
    '      used+=r.height+mb;',
    '      rows.push({cls:k.className,h:Math.round(r.height),mb:Math.round(mb),',
    '                 txt:(k.textContent||"").slice(0,14)});',
    '    });',
    '    out.push({page:pi+1,avail:Math.round(avail),used:Math.round(used),',
    '              rest:Math.round(avail-used),kids:kids.length,rows:rows});',
    '  });',
    '  host.style.transform=saved;',
    '  return out;',
    '})()'
  ].join('\n'));

  let total = 0;
  for (const p of data) {
    total += p.used;
    console.log('');
    console.log('第 ' + p.page + ' 页  可用 ' + p.avail + 'px  已用 ' + p.used +
      'px (' + Math.round(p.used / p.avail * 100) + '%)  底部余 ' + p.rest + 'px  块 ' + p.kids);
    for (const r of p.rows) {
      console.log('    ' + r.cls.padEnd(22) + ' 高' + String(r.h).padStart(4) +
        ' 段后' + String(r.mb).padStart(3) + '  「' + r.txt + '」');
    }
    if (p.rest > 150 && p.kids > 1) {
      console.log('    ⚠ 底部余 ' + p.rest + 'px —— 检查是不是「文字排得下、仅段后距越界」导致整段被推迟');
    }
  }
  console.log('');
  console.log('页数 ' + data.length + '  累计占用 ' + total + 'px');

  sock.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
