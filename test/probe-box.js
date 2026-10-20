/* 探针：逐页量预览的版心/边距/空白，确认分页后每页页边距都等于配置值。 */
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

const appPath = path.join(OUT, '_probe-box.html');
fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), appPath);
const PORT = 9957;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-box-'));
const browser = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
  '--allow-file-access-from-files', '--disable-breakpad', '--disable-crash-reporter',
  '--hide-scrollbars',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
  'file:///' + appPath.replace(/\\/g, '/')
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
    ws.addEventListener('open', () => res({
      send(m, p) { return new Promise(r => { const i = ++id; w.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); }); },
      close() { try { ws.close(); } catch (e) {} }
    }));
    ws.addEventListener('error', () => rej(new Error('ws')));
    ws.addEventListener('message', ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id && w.has(m.id)) { const f = w.get(m.id); w.delete(m.id); f(m.result); }
    });
  });
}

/* 页面内的测量函数：作为字符串注入，用 function 声明避免模板字符串嵌套问题 */
const PROBE_FN = [
  'function __probePages() {',
  '  var CM = 96 / 2.54;',
  '  var pages = Array.prototype.slice.call(document.querySelectorAll("#pages > .page"));',
  '  var out = [];',
  '  pages.forEach(function (page, pi) {',
  '    var cs = getComputedStyle(page);',
  '    var doc = page.querySelector(".doc");',
  '    var rect = page.getBoundingClientRect();',
  '    var kids = Array.prototype.slice.call(doc.children);',
  '    var ne = kids.filter(function (k) { return (k.textContent || "").trim(); });',
  '    var fr = ne.length ? ne[0].getBoundingClientRect() : null;',
  '    var lr = ne.length ? ne[ne.length - 1].getBoundingClientRect() : null;',
  '    var availPx = 29.7 * CM - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);',
  '    out.push({',
  '      p: pi + 1,',
  '      pageH: +(rect.height / CM).toFixed(2),',
  '      padT: +(parseFloat(cs.paddingTop) / CM).toFixed(2),',
  '      padB: +(parseFloat(cs.paddingBottom) / CM).toFixed(2),',
  '      padL: +(parseFloat(cs.paddingLeft) / CM).toFixed(2),',
  '      padR: +(parseFloat(cs.paddingRight) / CM).toFixed(2),',
  '      gapTop: fr ? +((fr.top - rect.top) / CM).toFixed(2) : null,',
  '      gapBottom: lr ? +((rect.bottom - lr.bottom) / CM).toFixed(2) : null,',
  '      gapLeft: fr ? +((fr.left - rect.left) / CM).toFixed(2) : null,',
  '      gapRight: fr ? +((rect.right - fr.right) / CM).toFixed(2) : null,',
  '      bodyW: +(((rect.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) / CM)).toFixed(2),',
  '      docH: Math.round(doc.offsetHeight),',
  '      avail: Math.round(availPx),',
  '      overflow: doc.offsetHeight > availPx + 2,',
  '      kids: kids.length,',
  '      blanks: kids.filter(function (k) { return k.className.indexOf("blk-blank") >= 0; }).length',
  '    });',
  '  });',
  '  return JSON.stringify({ count: pages.length, pages: out });',
  '}',
  '__probePages()'
].join('\n');

(async () => {
  const cdp = await connect(await wsUrl());
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1700);
  const ev = async e => {
    const r = await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) {
      console.error('EVAL ERR: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
      return null;
    }
    return r.result.value;
  };

  const show = (label, raw) => {
    if (!raw) { console.log(label + ': (无结果)'); return; }
    const d = JSON.parse(raw);
    console.log('--- ' + label + ' ---  页数: ' + d.count);
    d.pages.forEach(p => console.log(
      '  p' + p.p +
      '  上' + p.gapTop + ' 下' + p.gapBottom + ' 左' + p.gapLeft + ' 右' + p.gapRight + ' cm' +
      '  | 版心宽' + p.bodyW + 'cm' +
      '  | 内容' + p.docH + '/' + p.avail + 'px' +
      '  | 溢出=' + p.overflow + ' 块=' + p.kids + ' 空行=' + p.blanks));
  };

  await ev(`document.getElementById('btnSample').click(); true`);
  await sleep(1200);
  await ev(`(function(){var p=document.getElementById('zoomPct');p.value='100';p.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  await sleep(900);
  show('示例文档', await ev(PROBE_FN));

  await ev([
    '(function(){',
    '  var t=document.getElementById("src"), base=t.value;',
    '  for (var i=1;i<=12;i++){',
    '    base += "\\n\\n（" + (i+1) + "）补充条款第" + i + "项\\n\\n这里是补充的正文内容，用于把文档撑到多页，" +',
    '      "以便观察每一页的页边距是否都等于配置值（上3.7 下3.5 左2.8 右2.6）。";',
    '  }',
    '  t.value=base; t.dispatchEvent(new Event("input",{bubbles:true})); return true',
    '})()'
  ].join('\n'));
  await sleep(2200);
  show('长文档', await ev(PROBE_FN));

  cdp.close(); browser.kill();
  process.exit(0);
})().catch(e => { console.error('异常:', e.message); try { browser.kill(); } catch (x) {} process.exit(1); });
