/* 验证「空行过多」提示条：出现条件、一键删除空行、删除后页数变化。
 *
 * 默认配置已改为 blank_line_mode='delete_single'（单个空行自动删除），
 * 所以提示条只在「最终还剩 >=3 个空行」时出现 —— 这些空行来自「连续多个空行」
 * 的段落（delete_single 只删恰好 1 个的连续段）。
 * 因此本测试的样例必须造出「连续多个空行」，而不是普通的段间单个空行。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const BROWSER = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));

const appPath = path.join(OUT, '_e2e-blankhint.html');
fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), appPath);
const PORT = 9975;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-bh-'));
const browser = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
  '--allow-file-access-from-files', '--disable-breakpad', '--disable-crash-reporter',
  '--hide-scrollbars',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
  'file:///' + appPath.replace(/\\/g, '/')
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
}

async function wsUrl() {
  for (let i = 0; i < 80; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = l.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch (e) {}
    await sleep(250);
  }
  throw new Error('端口未就绪');
}
function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let id = 0; const w = new Map();
    const exceptions = [];
    ws.addEventListener('open', () => res({
      exceptions,
      send(m, p) { return new Promise(r => { const i = ++id; w.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); }); },
      close() { try { ws.close(); } catch (e) {} }
    }));
    ws.addEventListener('error', () => rej(new Error('ws')));
    ws.addEventListener('message', ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.text);
      if (m.id && w.has(m.id)) { const f = w.get(m.id); w.delete(m.id); f(m.result); }
    });
  });
}

/* 造出「连续多个空行」：delete_single 只删恰好 1 个空行的连续段，
   连续 2 个以上会保留，从而出现 >=3 个空行块，触发提示。 */
const MULTI_BLANK_SAMPLE = [
  '关于测试空行提示的通知',
  '',
  '各部门：',
  '',
  '',
  '',
  '这是正文第一段，内容够长一些，用来确认排版正常。',
  '',
  '',
  '',
  '一、总体要求',
  '',
  '',
  '',
  '这是正文第二段，同样写长一点，避免被当成标题处理。',
  '',
  '',
  '',
  '二、工作要求',
  '',
  '',
  '',
  '这是正文第三段，收尾。'
].join('\n');

(async () => {
  const cdp = await connect(await wsUrl());
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 2, mobile: false });
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1700);
  const ev = async e => {
    const r = await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result.value;
  };

  console.log('=== 0. 默认空行模式应为 delete_single ===');
  const d0 = await ev(`(function(){
    var s=document.getElementById('c_blank_line_mode');
    var q=document.getElementById('q_blank');
    return JSON.stringify({ c: s ? s.value : null, q: q ? q.value : null });
  })()`);
  const z0 = JSON.parse(d0);
  check('默认空行模式 = delete_single', z0.c === 'delete_single', 'c=' + z0.c + ' q=' + z0.q);
  check('快速微调下拉同步', z0.q === 'delete_single', 'q=' + z0.q);

  console.log('=== 1. 连续多空行的文本 → 应出现提示 ===');
  await ev(`(function(){
    var t=document.getElementById('src');
    t.value=${JSON.stringify(MULTI_BLANK_SAMPLE)};
    t.dispatchEvent(new Event('input',{bubbles:true}));
    return true;
  })()`);
  await sleep(1500);
  const s1 = await ev(`(function(){
    var h=document.getElementById('blankHint');
    return JSON.stringify({
      visible: h ? h.style.display !== 'none' : false,
      text: h ? h.textContent.trim().slice(0,70) : '',
      hasBtn: !!document.getElementById('btnDropBlank'),
      pages: document.querySelectorAll('#pages .page').length,
      blocks: document.querySelectorAll('#pages .doc > *').length,
      blanks: document.querySelectorAll('#pages .blk-blank').length
    });
  })()`);
  const d1 = JSON.parse(s1);
  check('提示条已显示', d1.visible === true, JSON.stringify(d1.text));
  check('提示里有「删除全部空行」按钮', d1.hasBtn === true);
  check('确实还有空行块', d1.blanks >= 3, '空行 ' + d1.blanks + ' 个');
  const pagesBefore = d1.pages, blocksBefore = d1.blocks, blanksBefore = d1.blanks;

  console.log('=== 2. 点「删除全部空行」 ===');
  await ev(`document.getElementById('btnDropBlank').click();true`);
  await sleep(1500);
  const s2 = await ev(`(function(){
    var h=document.getElementById('blankHint');
    return JSON.stringify({
      visible: h ? h.style.display !== 'none' : false,
      pages: document.querySelectorAll('#pages .page').length,
      blocks: document.querySelectorAll('#pages .doc > *').length,
      blanks: document.querySelectorAll('#pages .blk-blank').length,
      qBlank: (document.getElementById('q_blank')||{}).value,
      cBlank: (document.getElementById('c_blank_line_mode')||{}).value
    });
  })()`);
  const d2 = JSON.parse(s2);
  check('提示条已隐藏', d2.visible === false);
  check('空行块已清零', d2.blanks === 0, '空行 ' + d2.blanks + ' 个（原 ' + blanksBefore + '）');
  check('块数减少', d2.blocks < blocksBefore, blocksBefore + ' → ' + d2.blocks);
  check('页数没有增加', d2.pages <= pagesBefore, pagesBefore + ' 页 → ' + d2.pages + ' 页');
  check('快速微调下拉已同步', d2.qBlank === 'delete_all', 'q_blank=' + d2.qBlank);
  check('自定义页下拉已同步', d2.cBlank === 'delete_all', 'c_blank_line_mode=' + d2.cBlank);

  console.log('=== 3. 改成 keep_all 后空行应回来 ===');
  await ev(`(function(){
    var s=document.getElementById('q_blank');
    s.value='keep_all'; s.dispatchEvent(new Event('change',{bubbles:true})); return true;
  })()`);
  await sleep(1400);
  const s3 = await ev(`(function(){
    var h=document.getElementById('blankHint');
    return JSON.stringify({visible: h ? h.style.display !== 'none' : false,
      blanks: document.querySelectorAll('#pages .blk-blank').length});
  })()`);
  const d3 = JSON.parse(s3);
  check('切回 keep_all 提示重现', d3.visible === true);
  check('空行块回来了', d3.blanks >= 3, '空行 ' + d3.blanks + ' 个');

  console.log('=== 4. 无空行的文本 → 不应出现提示 ===');
  await ev(`(function(){
    var t=document.getElementById('src');
    t.value='测试标题\\n各部门：\\n这是正文第一段。\\n这是正文第二段。\\n这是正文第三段。';
    t.dispatchEvent(new Event('input',{bubbles:true}));
    return true;
  })()`);
  await sleep(1400);
  const s4 = await ev(`(function(){
    var h=document.getElementById('blankHint');
    return JSON.stringify({visible: h ? h.style.display !== 'none' : false});
  })()`);
  check('无空行时不显示提示', JSON.parse(s4).visible === false);

  console.log('=== 5. 控制台错误 ===');
  check('无未捕获错误', cdp.exceptions.length === 0, JSON.stringify(cdp.exceptions));

  console.log('\n' + '='.repeat(56));
  console.log('空行提示：PASS=' + pass + ' FAIL=' + fail);
  cdp.close(); browser.kill();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('异常:', e.message); try { browser.kill(); } catch (x) {} process.exit(1); });
