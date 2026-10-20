/* e2e-unitags.js — 逐个检查「自定义」与「规范」里每个数字输入框旁是否有单位 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const BIN = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9801 + (process.pid % 60);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (n, ok, info) => {
  if (ok) { pass++; console.log('  PASS  ' + n + (info ? '  ' + info : '')); }
  else { fail++; console.log('  FAIL  ' + n + '  ' + info); }
};

(async () => {
  const app = path.join(OUT, '_e2e_tags.html');
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), app);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-tags-'));
  const b = spawn(BIN, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--disable-extensions', '--allow-file-access-from-files',
    '--disable-breakpad', '--disable-crash-reporter',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + prof,
    'file:///' + app.replace(/\\/g, '/')], { stdio: 'ignore' });

  let ws = null;
  for (let i = 0; i < 100; i++) {
    try {
      const l = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const t = l.find(x => x.type === 'page' && x.webSocketDebuggerUrl);
      if (t) { ws = t.webSocketDebuggerUrl; break; }
    } catch (e) {}
    await sleep(250);
  }
  const s = new WebSocket(ws); let id = 0; const w = new Map();
  const exceptions = [];
  await new Promise(r => s.addEventListener('open', r));
  s.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') {
      exceptions.push((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text);
    }
    if (m.id && w.has(m.id)) { w.get(m.id)(m.result); w.delete(m.id); }
  });
  const send = (me, p) => new Promise(r => { const i = ++id; w.set(i, r); s.send(JSON.stringify({ id: i, method: me, params: p || {} })); });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.reload', { ignoreCache: true }); await sleep(1600);
  const ev = async ex => {
    const r = await send('Runtime.evaluate', { expression: ex, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text);
    return r.result.value;
  };

  /* 展开「自定义」里所有折叠区 */
  await ev(`(function(){
    document.querySelector('.tab[data-tab="adv"]').click();
    var hs=document.querySelectorAll('.collapse-h');
    for(var i=0;i<hs.length;i++){
      var bd=hs[i].parentNode.querySelector('.collapse-b');
      if(bd && bd.classList.contains('hide')) hs[i].click();
    }
    return true;
  })()`);
  await sleep(600);

  console.log('=== 1. 自定义面板：每个数字框旁边都要有单位 ===');
  const r1 = await ev(`(function(){
    var out=[], miss=[], total=0;
    var ins=document.querySelectorAll('.col-left input[type=number]');
    for(var i=0;i<ins.length;i++){
      var el=ins[i];
      if(!el.offsetParent) continue;
      total++;
      /* 单位可能在：同 .unitrow 里的 .utag、同 .field 里的 .utag、
         或紧邻的兄弟 span（「字符」「cm」等旧写法） */
      var box=el.closest('.unitrow')||el.closest('.field')||el.parentNode;
      var tag=box?box.querySelector('.utag'):null;
      var txt=tag?tag.textContent.trim():'';
      /* 单位也可能是同 .unitrow 里的「单位下拉」（磅/倍、字符/厘米/磅）——
         那比静态后缀更好：既显示单位又能直接切换。 */
      if(!txt && box){
        var us=box.querySelector('select[data-cfg$="_unit"]');
        if(us && us.options[us.selectedIndex]) txt=us.options[us.selectedIndex].text.trim();
      }
      if(!txt){
        var sib=el.nextElementSibling;
        if(sib && /^(cm|pt|磅|字符|页|%|倍)$/.test(sib.textContent.trim())) txt=sib.textContent.trim();
      }
      var key=el.dataset.cfg||el.id;
      if(txt) out.push(key+'='+txt); else miss.push(key);
    }
    return {total:total, withTag:out.length, miss:miss, sample:out.slice(0,40)};
  })()`);
  console.log('  可见数字框 ' + r1.total + ' 个，带单位 ' + r1.withTag + ' 个');
  if (r1.miss.length) console.log('  缺单位: ' + r1.miss.join(', '));
  check('所有可见数字框都标了单位', r1.miss.length === 0, r1.miss.join(',') || r1.withTag + '/' + r1.total);

  console.log('\n=== 2. 单位内容正确（不能全是同一个） ===');
  const uniq = new Set(r1.sample.map(x => x.split('=')[1]));
  check('单位种类 ≥ 4 种', uniq.size >= 4, Array.from(uniq).join(' / '));
  check('页边距用 cm', /margin_top=cm/.test(r1.sample.join(',')), r1.sample.find(x => /margin_top/.test(x)) || '无');
  check('首行缩进用「字符」', /indent_chars=字符/.test(r1.sample.join(',')), r1.sample.find(x => /indent_chars/.test(x)) || '无');
  check('字号用 pt', /_size=pt/.test(r1.sample.join(',')), r1.sample.find(x => /_size/.test(x)) || '无');

  console.log('\n=== 3. 「③ 规范」快速面板也有单位 ===');
  await ev(`document.querySelector('.tab[data-tab="preset"]').click();true`);
  await sleep(400);
  const r3 = await ev(`(function(){
    var ins=document.querySelectorAll('#pane-preset input[type=number]'), miss=[], total=0, got=[];
    for(var i=0;i<ins.length;i++){
      var el=ins[i];
      if(!el.offsetParent) continue;
      total++;
      var box=el.closest('.unitrow')||el.closest('.field')||el.parentNode;
      var tag=box?box.querySelector('.utag'):null;
      var t=tag?tag.textContent.trim():'';
      if(t) got.push((el.id||el.dataset.cfg)+'='+t); else miss.push(el.id||el.dataset.cfg);
    }
    return {total:total, got:got, miss:miss};
  })()`);
  console.log('  ' + JSON.stringify(r3.got));
  check('快速面板数字框都有单位', r3.miss.length === 0, r3.miss.join(',') || r3.got.length + '/' + r3.total);

  console.log('\n=== 4. 无未捕获错误 ===');
  check('零异常', exceptions.length === 0, exceptions.slice(0, 2).join(' | '));

  console.log('\n' + '='.repeat(56));
  console.log('单位标注：PASS=' + pass + ' FAIL=' + fail);
  s.close(); b.kill();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
