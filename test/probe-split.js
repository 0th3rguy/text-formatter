/* probe-split.js — 找出所有「同一段落被切成多块」的情况，并标出页边界处的断字
   用法：node test/probe-split.js [txt路径] */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const APP = path.join(OUT, '_probesplit.html');
const TXT = process.argv[2] && fs.existsSync(process.argv[2])
  ? process.argv[2] : path.join(ROOT, 'test', 'sample-shuzhi.txt');

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), APP);
  const PORT = 9931 + (process.pid % 40);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-split-'));
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
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
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.reload', { ignoreCache: true }); await sleep(1700);
  const ev = async expr => {
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true, userGesture: true
    });
    return r && r.result ? r.result.value : undefined;
  };

  const text = fs.readFileSync(TXT, 'utf8');
  await ev([
    'var ta=document.getElementById("src");',
    'ta.value=' + JSON.stringify(text) + ';',
    'ta.dispatchEvent(new Event("input",{bubbles:true}));true'
  ].join('\n'));
  await sleep(2200);
  await ev([
    'var q=document.getElementById("q_blank");',
    'q.value="heading_gap";q.dispatchEvent(new Event("change",{bubbles:true}));true'
  ].join('\n'));
  await sleep(2200);

  const data = await ev([
    '(function(){',
    '  var host=document.getElementById("pages");',
    '  var saved=host.style.transform; host.style.transform="none";',
    '  var pages=[...host.querySelectorAll(".page")];',
    '  var PX=96/2.54;',
    '  var out=[];',
    '  pages.forEach(function(p,pi){',
    '    var cs=getComputedStyle(p);',
    '    var avail=29.7*PX-(parseFloat(cs.paddingTop)||0)-(parseFloat(cs.paddingBottom)||0);',
    '    var kids=[...p.querySelector(".doc").children];',
    '    var used=0;',
    '    if(kids.length){',
    /* 基准必须是「页面内容区顶部（= 页框顶 + 上内边距）」，不能取首块的 top —
       首块自带 margin-top（.blk-body 有 .15em），拿它当原点会少算 5~6px，
       于是本来正好排满的页会被报成 101% 溢出。 */
    '      var top0=p.getBoundingClientRect().top+(parseFloat(cs.paddingTop)||0);',
    '      var bot=null; kids.forEach(function(k){bot=k.getBoundingClientRect().bottom;});',
    '      used=bot-top0;',
    '    }',
    '    out.push({',
    '      page:pi+1, avail:Math.round(avail), used:Math.round(used),',
    '      pct:avail>0?Math.round(used/avail*100):0,',
    '      kids:kids.map(function(el){',
    '        return {cls:el.className,',
    '                len:(el.textContent||"").replace(/\\u00a0/g,"").length,',
    '                head:(el.textContent||"").replace(/\\u00a0/g,"").slice(0,12),',
    '                tail:(el.textContent||"").replace(/\\u00a0/g,"").slice(-12)};',
    '      })',
    '    });',
    '  });',
    '  host.style.transform=saved;',
    '  return out;',
    '})()'
  ].join('\n'));

  console.log('=== 每页填充率 ===');
  data.forEach(p => {
    console.log('第' + p.page + '页  ' + p.pct + '%  (' + p.used + '/' + p.avail + ')  块' + p.kids.length);
  });

  console.log('\n=== 页边界处被切开的段落（cont 链）===');
  let frag = 0;
  data.forEach((p, i) => {
    const conts = p.kids.filter(k => /cont/.test(k.cls));
    if (!conts.length) return;
    console.log('\n第' + p.page + '页  续排段 ' + conts.length + ' 个，填充 ' + p.pct + '%');
    p.kids.forEach((k, j) => {
      if (i === 0 && j === 0) return;
      const isCont = /cont/.test(k.cls);
      const isFirst = j === 0;
      if (isCont && isFirst && p.pct < 90) {
        console.log('  ⚠ 第' + j + '块 cont 在页首但本页只填了 ' + p.pct + '%  → ' +
          '「…' + k.head + '」  len=' + k.len);
        frag++;
      } else if (isCont) {
        console.log('    第' + j + '块 cont  len=' + k.len + '  「' + k.head + '…」');
      }
    });
  });

  console.log('\n可疑碎片: ' + frag);

  /* 检查上一页末尾 + 下一页开头拼起来是否通顺（有没有断在词中间） */
  console.log('\n=== 页尾 → 页首 断点 ===');
  for (let i = 0; i + 1 < data.length; i++) {
    const a = data[i];
    const b = data[i + 1];
    const lastA = a.kids.filter(k => /blk-(body)/.test(k.cls)).pop();
    const firstB = b.kids[0];
    if (!lastA || !firstB) continue;
    if (!/cont/.test(firstB.cls)) continue;
    console.log('第' + a.page + '页末「…' + lastA.tail + '」 → 第' + b.page + '页首「' +
      firstB.head + '…」');
  }

  sock.close(); child.kill();
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
