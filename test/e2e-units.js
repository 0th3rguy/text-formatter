/* e2e-units.js — 行距单位 / 缩进单位 / 各级标题缩进 / 左栏伸缩时控件宽度
 *
 * 覆盖用户 m03106 的四项诉求：
 *  ② 左缩进单位可选（字符 / 厘米 / 磅）
 *  ③ 各级标题可选是否缩进几字符
 *  ④ 行距值单位可选（倍 / 磅）
 *  ⑤ 左栏拖宽时字号框要跟着变宽（不能只有字体框变大）
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const CHROMES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const BIN = CHROMES.find(p => fs.existsSync(p));
if (!BIN) { console.error('未找到浏览器'); process.exit(1); }

const PORT = 9985 + (process.pid % 100);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
}

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const app = path.join(OUT, '_units-app.html');
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), app);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-un-'));
  const browser = spawn(BIN, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
    '--disable-breakpad', '--disable-crash-reporter', '--disable-dev-shm-usage',
    '--allow-file-access-from-files',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    'file:///' + app.replace(/\\/g, '/'),
  ], { stdio: 'ignore' });

  async function wsUrl() {
    for (let i = 0; i < 100; i++) {
      try {
        const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
        const t = list.find(x => x.type === 'page' && x.webSocketDebuggerUrl);
        if (t) return t.webSocketDebuggerUrl;
      } catch (e) { /* 还没起来 */ }
      await sleep(250);
    }
    throw new Error('CDP 未就绪');
  }

  const url = await wsUrl();
  const sock = new WebSocket(url);
  let id = 0;
  const waiters = new Map();
  const exceptions = [];
  await new Promise(r => sock.addEventListener('open', r));
  sock.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m.result); waiters.delete(m.id); }
    else if (m.method === 'Runtime.exceptionThrown') {
      exceptions.push((m.params.exceptionDetails.exception || {}).description ||
        m.params.exceptionDetails.text);
    }
  });
  const send = (method, params) => new Promise(r => {
    const i = ++id; waiters.set(i, r);
    sock.send(JSON.stringify({ id: i, method, params: params || {} }));
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.reload', { ignoreCache: true });
  await sleep(1500);

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + expr.slice(0, 140));
    return r.result.value;
  };

  console.log('=== 1. 新控件都存在 ===');
  const present = await ev(`(function(){
    var ids=['lineSpacingUnit','lineSpacingHint'];
    var cfgs=['line_spacing_unit','left_indent_value','left_indent_unit',
              'right_indent_value','right_indent_unit','title_indent_chars',
              'h1_indent_chars','h2_indent_chars','h3_indent_chars','h4_indent_chars'];
    var out={};
    ids.forEach(function(i){ out[i]=!!document.getElementById(i) });
    cfgs.forEach(function(c){ out['cfg_'+c]=!!document.querySelector('[data-cfg="'+c+'"]') });
    out.oldLeftCm=!!document.querySelector('[data-cfg="left_indent_cm"]');
    out.oldRightCm=!!document.querySelector('[data-cfg="right_indent_cm"]');
    return JSON.stringify(out)})()`);
  const P = JSON.parse(present);
  console.log('  ' + present);
  check('行距单位下拉存在', P.lineSpacingUnit === true);
  check('行距单位提示存在', P.lineSpacingHint === true);
  check('左缩进 值+单位 存在', P.cfg_left_indent_value && P.cfg_left_indent_unit);
  check('右缩进 值+单位 存在', P.cfg_right_indent_value && P.cfg_right_indent_unit);
  check('主标题缩进输入存在', P.cfg_title_indent_chars === true);
  ['h1', 'h2', 'h3', 'h4'].forEach(lv => {
    check(lv + ' 缩进输入存在', P['cfg_' + lv + '_indent_chars'] === true);
  });
  check('旧的 left_indent_cm 控件已移除', P.oldLeftCm === false);
  check('旧的 right_indent_cm 控件已移除', P.oldRightCm === false);

  console.log('\n=== 2. 行距单位切换改变产物 ===');
  await ev(`document.getElementById('btnSample').click();true`);
  await sleep(1200);

  /* 取出 document.xml 的明文：.docx 是 ZIP，document.xml 被 deflate 压缩过，
     直接对 base64 解出来的字节搜字符串是搜不到的，必须用页面里的 WFPZip 解包。 */
  const exportXml = async () => {
    return await ev(`(function(){
      return new Promise(function(resolve){
        var oldCreate=URL.createObjectURL, oldClick=HTMLAnchorElement.prototype.click, done=false;
        URL.createObjectURL=function(b){
          if(!done){ done=true;
            b.arrayBuffer().then(function(ab){
              return window.WFPZip.readZip(new Uint8Array(ab));
            }).then(function(files){
              var doc=files['word/document.xml'];
              var txt=window.WFPZip.fromUtf8(doc);
              setTimeout(function(){ URL.createObjectURL=oldCreate; resolve(txt); },0);
            }).catch(function(e){
              setTimeout(function(){ URL.createObjectURL=oldCreate; resolve('ERR:'+e.message); },0);
            });
          }
          return oldCreate.call(URL,b);
        };
        HTMLAnchorElement.prototype.click=function(){};
        setTimeout(function(){ HTMLAnchorElement.prototype.click=oldClick; },0);
        document.getElementById('btnRun').click();
        setTimeout(function(){ if(!done){ URL.createObjectURL=oldCreate; resolve(''); } },9000);
      });
    })()`);
  };

  const setCfg = async (key, val) => {
    await ev(`(function(){
      var el=document.querySelector('[data-cfg="${key}"]');
      el.value='${val}';
      el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));
      return true})()`);
    await sleep(900);
  };

  // 固定值 28 磅（基准）
  await setCfg('line_spacing_rule', 'fixed');
  await setCfg('line_spacing_unit', 'pt');
  await setCfg('line_spacing_value', '28');
  const pt28 = await exportXml();
  check('导出并解出 document.xml', pt28.indexOf('<w:document') >= 0, pt28.slice(0, 40));

  // 换成「倍 1.75」：1.75 × 16pt = 28pt，与 28 磅等价
  await setCfg('line_spacing_unit', 'mult');
  await setCfg('line_spacing_value', '1.75');
  const mult175 = await exportXml();

  check('磅与等效倍率产生相同行高（28pt == 1.75×16pt）', pt28 === mult175,
    pt28.length + ' / ' + mult175.length + ' 字符');

  const lines = (txt) => {
    const m = txt.match(/w:line="(\d+)"/g) || [];
    return Array.from(new Set(m));
  };
  const Lpt = lines(pt28);
  const Lmult = lines(mult175);
  console.log('  28磅: ' + Lpt.slice(0, 4).join(' ') + '  1.75倍: ' + Lmult.slice(0, 4).join(' '));
  check('「磅」模式写 28pt（twip 560）', Lpt.some(s => /w:line="560"/.test(s)), Lpt.join(' '));
  check('「倍」模式 1.75×16pt=28pt 也是 560 twip', Lmult.some(s => /w:line="560"/.test(s)), Lmult.join(' '));

  // 换一个真正不同的倍率，确认换算生效
  await setCfg('line_spacing_unit', 'mult');
  await setCfg('line_spacing_value', '1');
  const mult1 = await exportXml();
  const L1 = lines(mult1);
  console.log('  1倍: ' + L1.slice(0, 4).join(' '));
  check('「倍」模式 1×16pt=16pt → 320 twip（确实做了换算）',
    L1.some(s => /w:line="320"/.test(s)), L1.join(' '));

  console.log('\n=== 3. 左缩进单位换算 ===');
  await setCfg('line_spacing_unit', 'pt');
  await setCfg('line_spacing_value', '28');

  const indOf = (txt) => Array.from(new Set(txt.match(/w:ind w:left="(\d+)"/g) || []));

  // 2 字符 ≈ 32pt（正文 16pt）→ 640 twip
  await setCfg('left_indent_unit', 'chars');
  await setCfg('left_indent_value', '2');
  const lChars = await exportXml();
  const indChars = indOf(lChars);
  console.log('  左缩进 2 字符: ' + indChars.slice(0, 2).join(' '));
  check('左缩进「字符」按正文字号换算（2×16pt=640twip）',
    indChars.some(s => /w:left="640"/.test(s)), indChars.join(' '));

  // 1 厘米 = 566.93 twip ≈ 567
  await setCfg('left_indent_unit', 'cm');
  await setCfg('left_indent_value', '1');
  const lCm = await exportXml();
  const indCm = indOf(lCm);
  console.log('  左缩进 1cm: ' + indCm.slice(0, 2).join(' '));
  check('左缩进「厘米」换算正确（1cm≈567twip）',
    indCm.some(s => /w:left="56[67]"/.test(s)), indCm.join(' '));

  // 20 磅 = 400 twip
  await setCfg('left_indent_unit', 'pt');
  await setCfg('left_indent_value', '20');
  const lPt = await exportXml();
  const indPt = indOf(lPt);
  console.log('  左缩进 20磅: ' + indPt.slice(0, 2).join(' '));
  check('左缩进「磅」换算正确（20pt=400twip）',
    indPt.some(s => /w:left="400"/.test(s)), indPt.join(' '));

  await setCfg('left_indent_value', '0');

  console.log('\n=== 4. 各级标题缩进生效 ===');
  await setCfg('h1_indent_chars', '2');
  await setCfg('h2_indent_chars', '1');
  const headInd = await exportXml();
  const fl = (headInd.match(/w:firstLineChars="(\d+)"/g) || []);
  console.log('  firstLineChars: ' + Array.from(new Set(fl)).join(' '));
  check('各级标题缩进写进 firstLineChars（200 = 2 字符）',
    fl.some(s => /="200"/.test(s)), Array.from(new Set(fl)).join(' '));
  check('各级标题缩进写进 firstLineChars（100 = 1 字符）',
    fl.some(s => /="100"/.test(s)), Array.from(new Set(fl)).join(' '));

  console.log('\n=== 5. 预览同步反映缩进 ===');
  const pvIndent = await ev(`(function(){
    var hs=[].slice.call(document.querySelectorAll('#pages .blk-head'));
    var out=[];
    for(var i=0;i<hs.length&&i<6;i++){
      out.push({lv:hs[i].dataset.lv, indent:getComputedStyle(hs[i]).textIndent});
    }
    return JSON.stringify(out);
  })()`);
  console.log('  ' + pvIndent);
  const PV = JSON.parse(pvIndent);
  const h1 = PV.filter(x => x.lv === '1');
  const h2 = PV.filter(x => x.lv === '2');
  check('预览一级标题有缩进', h1.length > 0 && h1.some(x => parseFloat(x.indent) > 30),
    h1.length ? h1[0].indent : '无 H1');
  check('预览二级标题有缩进（1 字符 ≈ 21px）',
    h2.length > 0 && h2.some(x => parseFloat(x.indent) > 15 && parseFloat(x.indent) < 30),
    h2.length ? h2[0].indent : '无 H2');

  await setCfg('h1_indent_chars', '0');
  await setCfg('h2_indent_chars', '0');

  console.log('\n=== 6. 左栏拖宽：字体框与字号框必须一起变 ===');
  /* 字体表在「③ 自定义」页签的折叠区里，先切过去并展开，否则量到的是隐藏元素的 0 宽。 */
  await ev(`(function(){
    document.querySelector('.tab[data-tab="adv"]').click();
    var hs=document.querySelectorAll('.collapse-h');
    for(var i=0;i<hs.length;i++){
      var b=document.getElementById('b'+hs[i].id.slice(1));
      if(b && b.classList.contains('hide')){ hs[i].click(); }
    }
    return true})()`);
  await sleep(500);

  const widths = async () => await ev(`(function(){
    var q=function(s){var e=document.querySelector(s);return e?e.offsetWidth:0};
    return JSON.stringify({
      font:q('.fontline .fl-font'), size:q('.fontline .fl-size'),
      qfont:q('.qline .ql-font'), qsize:q('.qline .ql-size')})})()`);

  const w400 = JSON.parse(await widths());
  console.log('  左栏 400px: ' + JSON.stringify(w400));

  // 「② 规范」页的 .qline 在另一个页签里，切过去单独量
  const qWidths = async () => await ev(`(function(){
    document.querySelector('.tab[data-tab="preset"]').click();
    var q=function(s){var e=document.querySelector(s);return e?e.offsetWidth:0};
    return JSON.stringify({qfont:q('.qline .ql-font'), qsize:q('.qline .ql-size')})})()`);
  const q400 = JSON.parse(await qWidths());
  await ev(`(function(){
    document.querySelector('.tab[data-tab="adv"]').click(); return true})()`);
  await sleep(300);
  console.log('  规范页 400px: ' + JSON.stringify(q400));

  await ev(`(function(){
    var s=document.getElementById('splitter');
    var main=s.parentNode;
    var r=s.getBoundingClientRect();
    s.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:r.left+5,clientY:r.top+100}));
    document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:r.left+5+220,clientY:r.top+100}));
    document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:r.left+5+220,clientY:r.top+100}));
    return document.getElementById('colLeft').offsetWidth})()`);
  await sleep(600);
  const w620 = JSON.parse(await widths());
  const q620 = JSON.parse(await qWidths());
  console.log('  左栏加宽后: ' + JSON.stringify(w620));
  console.log('  规范页加宽后: ' + JSON.stringify(q620));

  check('字体框随左栏变宽', w620.font > w400.font + 100, w400.font + ' → ' + w620.font);
  check('字号框也随左栏变宽（用户诉求 ⑤）', w620.size > w400.size + 20,
    w400.size + ' → ' + w620.size);
  check('② 规范页的字体框同步变宽', q620.qfont > q400.qfont + 100,
    q400.qfont + ' → ' + q620.qfont);
  check('② 规范页的字号框同步变宽', q620.qsize > q400.qsize + 20,
    q400.qsize + ' → ' + q620.qsize);

  console.log('\n=== 7. 控件不溢出、文字不截断 ===');
  const trunc = await ev(`(function(){
    var bad=[], total=0;
    var sels=document.querySelectorAll('.col-left select,.col-left input[type=number]');
    for(var i=0;i<sels.length;i++){
      var el=sels[i];
      /* 只检查当前可见的控件：非活动页签、折叠区里的元素量出来是 0 宽，必然误报 */
      if(!el.offsetParent) continue;
      if(el.clientWidth < 8) continue;
      total++;
      var cs=getComputedStyle(el);
      var inner=el.clientWidth-(parseFloat(cs.paddingLeft)||0)-(parseFloat(cs.paddingRight)||0);
      var probe=document.createElement('span');
      probe.style.cssText='position:absolute;visibility:hidden;white-space:nowrap;font:'+cs.font;
      var txt = el.tagName==='SELECT' ? (el.options[el.selectedIndex]||{}).text||'' : el.value;
      probe.textContent=txt;
      document.body.appendChild(probe);
      var w=probe.getBoundingClientRect().width;
      document.body.removeChild(probe);
      if(w>inner+2) bad.push({tag:el.tagName,cfg:el.dataset.cfg||el.id,txt:txt,w:Math.round(w),inner:Math.round(inner)});
    }
    return JSON.stringify({total:total, bad:bad.slice(0,10), badN:bad.length})})()`);
  const T = JSON.parse(trunc);
  console.log('  可见控件 ' + T.total + ' 个，截断 ' + T.badN + ' 个');
  if (T.badN) console.log('  ' + JSON.stringify(T.bad, null, 1));
  check('左栏加宽后无可见控件文字截断', T.badN === 0, T.badN + ' 个截断 / ' + T.total + ' 个控件');

  console.log('\n=== 8. 控制台错误 ===');
  check('无未捕获错误', exceptions.length === 0, JSON.stringify(exceptions.slice(0, 3)));

  console.log('\n' + '='.repeat(56));
  console.log(`行距/缩进单位 + 控件宽度：PASS=${pass} FAIL=${fail}`);
  sock.close();
  browser.kill();
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('异常:', e.message);
  process.exit(1);
});
