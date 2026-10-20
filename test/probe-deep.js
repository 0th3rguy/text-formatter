/* probe-deep.js —— 深挖分页：用带各级标题 + 各种段落长度的真实公文结构，
   逐页逐块打印，找出「底部还有空白却提前分页」的确切位置与原因。
   用法: node probe-deep.js [全角标题|短长混排|密集标题] */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const APP = path.join(OUT, '_probe-deep.html');
const BROWSER = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const PORT = 9751 + (process.pid % 50);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const S1 = '坚持统筹推进，注重实效，形成合力，确保各项任务落到实处。';
const S2 = '严格落实责任制，明确专人负责，定期检查通报，对落实不力的严肃问责。';
const S3 = '加强统筹协调，优化资源配置，强化过程管控，切实提升工作质效。';
const S4 = '聚焦主责主业，突出问题导向，健全工作机制，不断完善制度体系。';

function para(n, seed) {
  let s = '';
  for (let i = 0; i < n; i++) s += [S1, S2, S3, S4][(seed + i) % 4];
  return s;
}

const CASES = {
  /* 各级标题密集出现，每级标题后都跟不同长度的正文 */
  dense: [
    '关于进一步加强信息化建设工作的通知',
    '各部门、各直属单位：',
    para(3, 0),
    '一、总体要求',
    para(2, 1),
    '（一）指导思想',
    para(4, 2),
    '1. 统一规划',
    para(1, 3),
    '（1）第一阶段',
    para(5, 0),
    '（2）第二阶段',
    para(2, 1),
    '2. 分步实施',
    para(3, 2),
    '（二）基本原则',
    para(1, 3),
    '二、重点任务',
    para(4, 0),
    '（一）完善基础设施',
    para(2, 1),
    '（二）强化安全保障',
    para(3, 2),
    '三、工作要求',
    para(2, 3),
    '各单位要高度重视，明确专人负责，确保按期完成。'
  ].join('\n'),

  /* 短段与长段交替，最容易被分页规则误伤 */
  mix: [
    '关于测试的通知',
    para(1, 0),
    '一、短标题后的短段',
    para(1, 1),
    '二、短标题后的超长段',
    para(10, 2),
    '三、又一个短标题',
    para(1, 3),
    '（一）二级短标题',
    para(6, 0),
    '（二）二级短标题',
    para(1, 1),
    '四、结尾标题',
    para(8, 2),
    '（1）四级',
    para(3, 3)
  ].join('\n'),

  /* 全角标题，标题本身就长（可能换行成两行） */
  wide: [
    '关于进一步加强和改进新形势下卷烟物流配送中心信息化建设与运营管理工作的通知',
    '机关各处室、各直属单位、各县（区）分公司：',
    '一、关于当前信息化建设与运营管理工作中存在的突出问题及下一步改进措施的总体说明',
    para(3, 0),
    '（一）关于基础设施层面存在的短板与薄弱环节的具体分析与应对思路',
    para(2, 1),
    '二、重点工作',
    para(4, 2),
    '三、保障措施',
    para(3, 3)
  ].join('\n')
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), APP);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-deep-'));
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

  const which = process.argv[2] || 'dense';
  const text = CASES[which] || CASES.dense;

  await ev('(function(){var s=document.getElementById("src");s.value=' +
    JSON.stringify(text) + ';s.dispatchEvent(new Event("input",{bubbles:true}));return 1;})()');
  await sleep(1600);

  const data = await ev([
    '(function(){',
    '  var host=document.getElementById("pages");',
    '  var saved=host.style.transform; host.style.transform="none";',
    '  var pages=[...host.querySelectorAll(".page")];',
    '  var out=[];',
    '  pages.forEach(function(p,pi){',
    '    var cs=getComputedStyle(p);',
    '    var avail=p.clientHeight-(parseFloat(cs.paddingTop)||0)-(parseFloat(cs.paddingBottom)||0);',
    '    var kids=[...p.querySelector(".doc").children];',
    '    var rows=[]; var top0=null, botLast=null;',
    '    kids.forEach(function(k){',
    '      var r=k.getBoundingClientRect();',
    '      if(top0===null) top0=r.top;',
    '      botLast=r.bottom;',
    '      rows.push({cls:(k.className||"").replace("blk-",""), lv:k.dataset?k.dataset.lv:"",',
    '                 h:Math.round(r.height),',
    '                 txt:(k.textContent||"").slice(0,20)});',
    '    });',
    '    var real=botLast!==null?botLast-top0:0;',
    '    out.push({page:pi+1,avail:Math.round(avail),real:Math.round(real),',
    '              rest:Math.round(avail-real),rows:rows});',
    '  });',
    '  host.style.transform=saved;',
    '  return out;',
    '})()'
  ].join('\n'));

  console.log('用例: ' + which + '   共 ' + data.length + ' 页');
  let badPages = 0;
  for (const p of data) {
    const pct = Math.round(p.real / p.avail * 100);
    const isLast = p.page === data.length;
    const flag = (!isLast && p.rest > 100) ? '  ⚠ 底部还有 ' + p.rest + 'px 却分页了' : '';
    if (!isLast && p.rest > 100) badPages++;
    console.log('');
    console.log('第 ' + p.page + ' 页  可用 ' + p.avail + '  实占 ' + p.real +
      ' (' + pct + '%)  余 ' + p.rest + flag);
    for (const r of p.rows) {
      console.log('    ' + r.cls.padEnd(9) + ' lv=' + (r.lv || '-') +
        ' 高' + String(r.h).padStart(4) + '  「' + r.txt + '」');
    }
  }
  console.log('');
  console.log(badPages === 0 ? '没有「该排满却没排满」的页' : '有 ' + badPages + ' 页提前分页');

  sock.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
