/* 探针：在真实浏览器里量预览区的实际计算样式，确认"预览没体现排版"的原因。
   输出每个预览段落的 font-family(解析后) / font-size / text-indent / line-height / font-weight。 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];
const BROWSER = CANDIDATES.find(p => fs.existsSync(p));
const appPath = path.join(OUT, '_probe-pv.html');
fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), appPath);
const PORT = 9931;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-pv-'));
const fileUrl = 'file:///' + appPath.replace(/\\/g, '/');

const browser = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--disable-breakpad', '--disable-crash-reporter',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, fileUrl
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wsUrl() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch (e) {}
    await sleep(250);
  }
  throw new Error('调试端口未就绪');
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0; const waiting = new Map(); const exceptions = [];
    ws.addEventListener('open', () => resolve({
      exceptions,
      send(m, p) {
        return new Promise((res, rej) => {
          const mid = ++id; waiting.set(mid, { res, rej });
          ws.send(JSON.stringify({ id: mid, method: m, params: p || {} }));
        });
      },
      close() { try { ws.close(); } catch (e) {} }
    }));
    ws.addEventListener('error', () => reject(new Error('WS 错误')));
    ws.addEventListener('message', ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.text);
      if (m.id && waiting.has(m.id)) {
        const w = waiting.get(m.id); waiting.delete(m.id);
        if (m.error) w.rej(new Error(JSON.stringify(m.error))); else w.res(m.result);
      }
    });
  });
}

(async () => {
  const cdp = await connect(await wsUrl());
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1600);

  async function ev(expr, aw) {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: !!aw, userGesture: true });
    if (r.exceptionDetails) throw new Error('页面异常: ' +
      ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result.value;
  }

  // 填入示例文本
  await ev(`document.getElementById('btnSample').click(); true`);
  await sleep(700);

  const dump = await ev(`JSON.stringify((() => {
    const firstDoc = document.querySelector('#pages .doc');
    const out = { paragraphs: [], docFont: firstDoc ? getComputedStyle(firstDoc).fontFamily : '(no doc)' };
    const els = document.querySelectorAll('#pages .doc > *');
    els.forEach((el, i) => {
      if (i > 9) return;
      const cs = getComputedStyle(el);
      out.paragraphs.push({
        tag: el.tagName, cls: el.className,
        text: el.textContent.slice(0, 22),
        inlineFontFamily: el.style.fontFamily || '(未设)',
        computedFontFamily: cs.fontFamily,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        textIndent: cs.textIndent,
        lineHeight: cs.lineHeight,
        textAlign: cs.textAlign
      });
    });
    return out;
  })())`);

  const d = JSON.parse(dump);
  console.log('#pvDoc 计算 fontFamily: ' + d.docFont);
  console.log('');
  console.log('=== 预览段落实际渲染 ===');
  for (const p of d.paragraphs) {
    console.log(`[${p.tag}.${p.cls || '-'}] ${p.text}`);
    console.log(`    内联 font-family : ${p.inlineFontFamily}`);
    console.log(`    计算 font-family : ${p.computedFontFamily}`);
    console.log(`    font-size        : ${p.fontSize}   font-weight: ${p.fontWeight}`);
    console.log(`    text-indent      : ${p.textIndent}   line-height: ${p.lineHeight}   align: ${p.textAlign}`);
    console.log('');
  }

  // 测字体是否真的装在本机。
  // 注意：不能用 canvas 宽度差 —— CJK 字形宽度恒为 1em，所有中文字体量出来都是 320.0，
  // 无法区分。改用 document.fonts.check()（浏览器真正的字体匹配 API）。
  const fontProbe = await ev(`JSON.stringify((() => {
    const names = ['方正小标宋简体','方正小标宋_GBK','仿宋_GB2312','仿宋','FangSong','黑体','SimHei','楷体_GB2312','楷体','KaiTi','宋体','SimSun','微软雅黑','Times New Roman'];
    return names.map(n => {
      let ok = false;
      try { ok = document.fonts.check('16px "' + n + '"'); } catch (e) { ok = false; }
      return { family: n, available: ok };
    });
  })())`);

  console.log('=== 本机字体可用性探测（document.fonts.check） ===');
  for (const f of JSON.parse(fontProbe)) {
    console.log(`  ${f.available ? '有' : '无'}  ${f.family}`);
  }

  console.log('\n未捕获异常: ' + JSON.stringify(cdp.exceptions));
  cdp.close(); browser.kill();
})().catch(e => { console.error('异常:', e.message); try { browser.kill(); } catch (x) {} process.exitCode = 1; });
