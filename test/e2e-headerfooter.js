/* e2e-headerfooter.js — 验证页脚距 1.75cm、纸张默认 A4、各级标题行距可独立设置 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const BIN = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));
const PORT = 9993 + (process.pid % 60);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, info) => {
  if (ok) { pass++; console.log('  PASS  ' + name + (info ? '  ' + info : '')); }
  else { fail++; console.log('  FAIL  ' + name + '  ' + info); }
};

(async () => {
  const app = path.join(OUT, '_e2e_hf.html');
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), app);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-hf-'));
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
  if (!ws) { console.error('CDP 未就绪'); process.exit(1); }

  const s = new WebSocket(ws); let id = 0; const w = new Map();
  await new Promise(r => s.addEventListener('open', r));
  const exceptions = [];
  s.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      exceptions.push((d.exception && d.exception.description) || d.text);
    }
    if (m.id && w.has(m.id)) { w.get(m.id)(m.result); w.delete(m.id); }
  });
  const send = (me, p) => new Promise(r => { const i = ++id; w.set(i, r); s.send(JSON.stringify({ id: i, method: me, params: p || {} })); });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.reload', { ignoreCache: true }); await sleep(1600);
  const ev = async ex => {
    const r = await send('Runtime.evaluate', { expression: ex, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result.value;
  };

  console.log('=== 1. 默认值：页脚距 1.75 / 页眉距 1.5 / 纸张 A4 ===');
  const d = await ev(`(function(){
    var D=window.WFPDefaults, c=D.DEFAULT_CONFIG;
    return {footer:c.footer_distance, header:c.header_distance,
      paper:c.paper_size, forceA4:c.force_a4,
      hasPaperSizes: Array.isArray(D.PAPER_SIZES)?D.PAPER_SIZES.length:0,
      hasRoleRule: Array.isArray(D.ROLE_LINE_SPACING_RULE_OPTIONS)?D.ROLE_LINE_SPACING_RULE_OPTIONS.length:0,
      h1rule:c.h1_line_rule, h2rule:c.h2_line_rule};
  })()`);
  check('页脚距默认 1.75cm', d.footer === 1.75, 'footer=' + d.footer);
  check('页眉距默认 1.5cm', d.header === 1.5, 'header=' + d.header);
  check('纸张默认 A4', d.paper === 'A4', 'paper=' + d.paper);
  check('强制 A4 打开', d.forceA4 === true, 'force_a4=' + d.forceA4);
  check('纸张选项已定义', d.hasPaperSizes >= 5, d.hasPaperSizes + ' 种');
  check('各级标题行距规则选项已定义', d.hasRoleRule >= 6, d.hasRoleRule + ' 项');
  check('一级/二级标题行距默认跟随正文', d.h1rule === 'inherit' && d.h2rule === 'inherit',
    'h1=' + d.h1rule + ' h2=' + d.h2rule);

  console.log('\n=== 2. 界面：纸张下拉 + 单位后缀 + 各级标题行距表 ===');
  await ev(`document.querySelector('.tab[data-tab="adv"]').click();true`);
  await sleep(400);
  const ui = await ev(`(function(){
    var o={};
    var ps=document.getElementById('paperSize');
    o.paperOpts = ps ? ps.options.length : 0;
    o.paperSel = ps ? ps.value : null;
    var ft=document.querySelector('[data-cfg="footer_distance"]');
    o.footerVal = ft ? ft.value : null;
    var hd=document.querySelector('[data-cfg="header_distance"]');
    o.headerVal = hd ? hd.value : null;
    o.utags = document.querySelectorAll('.utag').length;
    o.hlines = document.querySelectorAll('.hline').length;
    var h1=document.querySelector('.hline[data-role="h1"]');
    if(h1){
      o.h1rule = h1.querySelector('.hl-rule').value;
      o.h1valDisabled = h1.querySelector('.hl-val').disabled;
    }
    return o;
  })()`);
  check('纸张下拉已填充', ui.paperOpts >= 5, ui.paperOpts + ' 项');
  check('纸张当前选中 A4', ui.paperSel === 'A4', ui.paperSel);
  check('页脚距输入框显示 1.75', Number(ui.footerVal) === 1.75, ui.footerVal);
  check('页眉距输入框显示 1.5', Number(ui.headerVal) === 1.5, ui.headerVal);
  check('数字框旁有单位后缀', ui.utags >= 15, ui.utags + ' 个');
  check('各级标题行距表已生成', ui.hlines === 5, ui.hlines + ' 行');
  check('一级标题行距默认「跟随正文」', ui.h1rule === 'inherit', ui.h1rule);
  check('「跟随正文」时数值框置灰', ui.h1valDisabled === true, 'disabled=' + ui.h1valDisabled);

  console.log('\n=== 3. 预览：页码位置随页脚距变化 ===');
  await ev(`document.getElementById('btnSample').click();true`);
  await sleep(1500);
  await ev(`(function(){var p=document.getElementById('zoomPct');p.value='100';p.dispatchEvent(new Event('change'));return true})()`);
  await sleep(600);
  const f1 = await ev(`(function(){
    var pg=document.querySelector('#pages .page');
    var ft=document.querySelector('#pages .ftr');
    if(!pg||!ft) return null;
    var pr=pg.getBoundingClientRect(), fr=ft.getBoundingClientRect();
    var cs=getComputedStyle(pg);
    return {paperW:Math.round(pr.width), paperH:Math.round(pr.height),
      ftrBottomGapCm: +(((pr.bottom - fr.bottom)/96*2.54)).toFixed(2),
      ftrDistVar: cs.getPropertyValue('--ftrDist').trim()};
  })()`);
  check('预览纸张宽 793px（A4 21cm）', Math.abs(f1.paperW - 794) <= 2, f1.paperW + 'px');
  check('预览纸张高 1123px（A4 29.7cm）', Math.abs(f1.paperH - 1123) <= 3, f1.paperH + 'px');
  check('--ftrDist 变量为 1.75cm', f1.ftrDistVar === '1.75cm', f1.ftrDistVar);
  check('页码距纸底边缘 ≈1.75cm', f1.ftrBottomGapCm > 1.0 && f1.ftrBottomGapCm < 2.6, f1.ftrBottomGapCm + 'cm');

  console.log('\n=== 4. 改页脚距 → 预览跟着动 ===');
  await ev(`(function(){
    var el=document.querySelector('[data-cfg="footer_distance"]');
    el.value='3.5';
    /* 数字框的监听是 input（边打字边更新），不是 change —— 派错事件就测不到东西 */
    el.dispatchEvent(new Event('input',{bubbles:true}));
    return true;
  })()`);
  await sleep(700);
  const f2 = await ev(`(function(){
    var pg=document.querySelector('#pages .page');
    var ft=document.querySelector('#pages .ftr');
    var pr=pg.getBoundingClientRect(), fr=ft.getBoundingClientRect();
    return {gap: +(((pr.bottom-fr.bottom)/96*2.54)).toFixed(2),
      v:getComputedStyle(pg).getPropertyValue('--ftrDist').trim()};
  })()`);
  check('页脚距改 3.5cm 后变量同步', f2.v === '3.5cm', f2.v);
  check('页码位置随之上移', f2.gap > f1.ftrBottomGapCm + 0.8, f1.ftrBottomGapCm + 'cm → ' + f2.gap + 'cm');

  console.log('\n=== 5. 一级标题独立行距（固定值 40 磅）→ 预览与 .docx 都变 ===');
  const before = await ev(`(function(){
    var h=document.querySelector('#pages .blk-head');
    return {lh:getComputedStyle(h).lineHeight, fs:getComputedStyle(h).fontSize};
  })()`);
  await ev(`(function(){
    var line=document.querySelector('.hline[data-role="h1"]');
    var rule=line.querySelector('.hl-rule');
    rule.value='fixed'; rule.dispatchEvent(new Event('change',{bubbles:true}));
    var val=line.querySelector('.hl-val');
    val.value='40'; val.dispatchEvent(new Event('change',{bubbles:true}));
    return true;
  })()`);
  await sleep(900);
  const after = await ev(`(function(){
    var h=document.querySelector('#pages .blk-head');
    var line=document.querySelector('.hline[data-role="h1"]');
    return {lh:getComputedStyle(h).lineHeight, fs:getComputedStyle(h).fontSize,
      valDisabled:line.querySelector('.hl-val').disabled,
      cfgVal: 1};
  })()`);
  check('改规则后数值框解禁', after.valDisabled === false, 'disabled=' + after.valDisabled);
  check('一级标题行高变为 40 磅（53.33px）',
    Math.abs(parseFloat(after.lh) - 53.33) < 1.5,
    before.lh + ' → ' + after.lh);

  const xml = await ev(`(function(){
    return new Promise(function(res){
      var OrigURL=URL.createObjectURL;
      URL.createObjectURL=function(bl){ window.__blob=bl; return OrigURL.call(URL, bl); };
      document.getElementById('btnRun').click();
      var t=0;
      var iv=setInterval(function(){
        t++;
        if(window.__blob || t>90){
          clearInterval(iv);
          if(!window.__blob){ res(''); return; }
          window.__blob.arrayBuffer().then(function(ab){
            var u=new Uint8Array(ab);
            return window.WFPZip.readZip(u);
          }).then(function(files){
            res(window.WFPZip.fromUtf8(files['word/document.xml']));
          }).catch(function(e){ res('ERR:'+e.message); });
        }
      },100);
    });
  })()`);
  check('导出的 document.xml 里一级标题行距 800 twip（40 磅）',
    /w:line="800"[^/]*w:lineRule="exact"/.test(xml), /w:line="800"[^/]*w:lineRule="exact"/.test(xml) ? 'OK' : 'xml 里没找到');
  check('正文行距仍是 560 twip（28 磅）',
    /w:line="560"/.test(xml), /w:line="560"/.test(xml) ? 'OK' : '未找到');

  console.log('\n=== 6. 纸张换 A3 → 预览页面变宽 ===');
  await ev(`(function(){
    var fs=document.querySelector('[data-cfg="force_a4"]');
    fs.value='false'; fs.dispatchEvent(new Event('change',{bubbles:true}));
    var ps=document.getElementById('paperSize');
    ps.value='A3'; ps.dispatchEvent(new Event('change',{bubbles:true}));
    return true;
  })()`);
  await sleep(900);
  const a3 = await ev(`(function(){
    var p=document.querySelector('#pages .page');
    var r=p.getBoundingClientRect();
    return {w:Math.round(r.width), h:Math.round(r.height)};
  })()`);
  check('A3 预览宽 1122px（29.7cm）', Math.abs(a3.w - 1122) <= 4, a3.w + 'px');
  check('A3 预览高 1587px（42cm）', Math.abs(a3.h - 1587) <= 6, a3.h + 'px');

  const a3xml = await ev(`(function(){
    return new Promise(function(res){
      window.__blob=null;
      document.getElementById('btnRun').click();
      var t=0;
      var iv=setInterval(function(){
        t++;
        if(window.__blob || t>90){
          clearInterval(iv);
          if(!window.__blob){ res(''); return; }
          window.__blob.arrayBuffer().then(function(ab){
            return window.WFPZip.readZip(new Uint8Array(ab));
          }).then(function(files){
            res(window.WFPZip.fromUtf8(files['word/document.xml']));
          }).catch(function(e){ res('ERR:'+e.message); });
        }
      },100);
    });
  })()`);
  check('A3 的 w:pgSz 宽 16838 twip',
    /w:pgSz w:w="16838"/.test(a3xml), (a3xml.match(/w:pgSz[^/]*/) || [''])[0]);

  console.log('\n=== 7. 无未捕获异常 ===');
  check('页面无未捕获错误', exceptions.length === 0, exceptions.join(' | '));

  console.log('\n' + '='.repeat(56));
  console.log('页脚距/纸张/标题行距：PASS=' + pass + ' FAIL=' + fail);
  s.close(); b.kill();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
