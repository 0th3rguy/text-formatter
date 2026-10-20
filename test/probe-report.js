/* probe-report.js — 诊断用户反馈述职报告的两个问题
   A. 段落被切出「掌」「握」这种 1~2 字的碎块
   B. 「只在标题后留空行」模式下正文里仍出现空行
   用法：node test/probe-report.js [txt路径] */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const APP = path.join(OUT, '_probereport.html');
const TXT = process.argv[2] && fs.existsSync(process.argv[2])
  ? process.argv[2] : path.join(ROOT, 'test', 'sample-shuzhi.txt');

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), APP);
  const PORT = 9971 + (process.pid % 40);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-rep-'));
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

  /* 把文本填进输入框（走 paste 通道，和用户操作一致） */
  const text = fs.readFileSync(TXT, 'utf8');
  await ev([
    'var ta=document.getElementById("src");',
    'ta.value=' + JSON.stringify(text) + ';',
    'ta.dispatchEvent(new Event("input",{bubbles:true}));true'
  ].join('\n'));
  await sleep(2200);

  /* 选「只在标题后留空行」 */
  const mode = await ev([
    'var q=document.getElementById("q_blank");',
    'q.value="heading_gap";q.dispatchEvent(new Event("change",{bubbles:true}));',
    'q.value'
  ].join('\n'));
  await sleep(2200);
  console.log('空行模式: ' + mode);

  /* ---------- 问题 B：正文里的空行 ---------- */
  const blanks = await ev([
    '(function(){',
    '  var out=[];',
    '  var all=[...document.querySelectorAll("#pages .doc > *")];',
    '  all.forEach(function(el,i){',
    '    if(!el.classList.contains("blk-blank")) return;',
    '    var prev=all[i-1], next=all[i+1];',
    '    out.push({',
    '      prev: prev?(prev.className||"?"):"(none)",',
    '      prevTxt: prev?(prev.textContent||"").slice(0,14):"",',
    '      next: next?(next.className||"?"):"(none)",',
    '      nextTxt: next?(next.textContent||"").slice(0,14):""',
    '    });',
    '  });',
    '  return out;',
    '})()'
  ].join('\n'));

  console.log('\n=== 问题 B：正文空行位置（共 ' + blanks.length + ' 处）===');
  let badBlank = 0;
  blanks.forEach((b, i) => {
    const prevIsHead = /blk-(title|sub|head|att|cap)/.test(b.prev);
    const nextIsHead = /blk-(title|sub|head|att|cap)/.test(b.next);
    let tag = '';
    if (!prevIsHead) { tag = '  ✗ 空行前面不是标题 [' + b.prev + ']'; badBlank++; }
    else if (nextIsHead) { tag = '  ✗ 空行后面还是标题 [' + b.next + ']'; badBlank++; }
    else tag = '  ✓';
    console.log('  ' + i + '  前[' + b.prev + '] "' + b.prevTxt + '"  →  后[' + b.next + '] "' + b.nextTxt + '"' + tag);
  });
  console.log('  错误空行: ' + badBlank);

  /* ---------- 问题 A：碎块段落 ---------- */
  const frags = await ev([
    '(function(){',
    '  var out=[];',
    '  var pages=[...document.querySelectorAll("#pages .page")];',
    '  pages.forEach(function(p,pi){',
    '    [...p.querySelector(".doc").children].forEach(function(el,ei){',
    '      var t=(el.textContent||"").replace(/\\u00a0/g,"").trim();',
    '      if(!t) return;',
    '      if(!/blk-(body)/.test(el.className)) return;',
    '      if(t.length<=6){',
    '        out.push({page:pi+1, idx:ei, len:t.length, txt:t, cls:el.className});',
    '      }',
    '    });',
    '  });',
    '  return out;',
    '})()'
  ].join('\n'));

  console.log('\n=== 问题 A：长度 ≤6 字的正文碎片（共 ' + frags.length + ' 处）===');
  frags.forEach(f => {
    console.log('  第' + f.page + '页 第' + f.idx + '块  长度' + f.len + '  「' + f.txt + '」  ' + f.cls);
  });

  /* 长段落的切分情况：看每个 cont 段的开头 */
  const conts = await ev([
    '(function(){',
    '  var out=[];',
    '  var pages=[...document.querySelectorAll("#pages .page")];',
    '  pages.forEach(function(p,pi){',
    '    [...p.querySelector(".doc").children].forEach(function(el,ei){',
    '      if(!el.classList.contains("cont")) return;',
    '      out.push({page:pi+1, idx:ei, len:(el.textContent||"").length,',
    '                head:(el.textContent||"").slice(0,10)});',
    '    });',
    '  });',
    '  return out;',
    '})()'
  ].join('\n'));
  console.log('\n=== 跨页续排段（cont）共 ' + conts.length + ' 处 ===');
  conts.forEach(c => console.log('  第' + c.page + '页 第' + c.idx + '块  长度' + c.len + '  「' + c.head + '」'));

  /* 页数与每页块数 */
  const info = await ev([
    '(function(){',
    '  return [...document.querySelectorAll("#pages .page")].map(function(p){',
    '    return {kids:p.querySelector(".doc").children.length,',
    '            conts:p.querySelectorAll(".cont").length,',
    '            blanks:p.querySelectorAll(".blk-blank").length};',
    '  });',
    '})()'
  ].join('\n'));
  console.log('\n=== 分页概览 ===');
  info.forEach((p, i) => console.log('  第' + (i + 1) + '页  块' + p.kids + '  续排' + p.conts + '  空行' + p.blanks));

  sock.close(); child.kill();
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
