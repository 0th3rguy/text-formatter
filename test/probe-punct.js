/* probe-punct.js —— 验证标点正则覆盖（中文引号/破折号/省略号/间隔号） */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const s = {};
s.window = s; s.globalThis = s; s.console = console;
s.TextEncoder = TextEncoder; s.TextDecoder = TextDecoder;
s.CompressionStream = CompressionStream; s.DecompressionStream = DecompressionStream;
s.Blob = Blob; s.setTimeout = setTimeout; s.clearTimeout = clearTimeout;
s.btoa = btoa; s.atob = atob;
vm.createContext(s);
for (const f of ['zip.js', 'defaults.js', 'parser.js', 'docx.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', f), 'utf8'), s);
}

const RE_CJK = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;
const RE_SPACE = /[\u3000\u00a0 ]/;
const RE_PUNCT = new RegExp(
  '[\\u2000-\\u206f' +
  '\\u3001-\\u303f' +
  '\\uff01-\\uff60' +
  '\\uffe0-\\uffe6' +
  '\\u00a1-\\u00bf' +
  '\\u00d7\\u00f7' +
  '!-\\/:-@\\[-`{-~' +
  ']');

const cases = [
  ['\u2018', '左单引号'],
  ['\u2019', '右单引号'],
  ['\u201c', '左双引号'],
  ['\u201d', '右双引号'],
  ['\u2014', '破折号'],
  ['\u2026', '省略号'],
  ['\u00b7', '间隔号'],
  ['\u3001', '顿号'],
  ['\uff0c', '全角逗号'],
  ['\u3002', '句号'],
  [',', '半角逗号'],
  ['.', '半角句点'],
  ['\uff08', '全角左括号'],
  ['\uffe5', '全角人民币']
];

let bad = 0;
for (const [ch, name] of cases) {
  const isP = RE_PUNCT.test(ch);
  const isC = RE_CJK.test(ch);
  const isS = RE_SPACE.test(ch);
  const ok = isP && !isC && !isS;
  if (!ok) bad++;
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + '  ' + name + '  ' + JSON.stringify(ch) +
    '  punct=' + isP + ' cjk=' + isC + ' space=' + isS);
}

console.log('');
console.log('正则覆盖：' + (cases.length - bad) + '/' + cases.length + (bad ? ' 有问题' : ' 全部正确'));

/* 端到端核对：字符数 = 中文 + 标点 + 字母 + 数字 + 空格 */
const text = '卷烟物流配送中心\u201c四个强化\u201d夯实运营管理根基\n' +
  '为降低破损损耗，近日中心聚焦运输、交接、处置各环节，推动\u2014\u2014管控转变\u2026\u2026成效明显。';
const cfg = Object.assign({}, s.WFPDefaults.DEFAULT_CONFIG);
const blocks = s.WFPParser.parseText(text, cfg);
const all = [];
for (const b of blocks) {
  if (b.type === 'blank') continue;
  if (b.type === 'table') { for (const r of b.rows) for (const c of r) all.push(c); continue; }
  if (b.type === 'image') continue;
  all.push(b.text);
}
const joined = all.join('');
let cjk = 0, punct = 0, space = 0, digit = 0, other = 0;
for (const ch of joined) {
  if (RE_SPACE.test(ch)) space++;
  else if (RE_CJK.test(ch)) cjk++;
  else if (/[0-9]/.test(ch)) digit++;
  else if (RE_PUNCT.test(ch)) punct++;
  else other++;
}
console.log('');
console.log('文本长度 chars = ' + joined.length);
console.log('  中文 ' + cjk + ' + 标点 ' + punct + ' + 空格 ' + space +
  ' + 数字 ' + digit + ' + 字母 ' + other + ' = ' + (cjk + punct + space + digit + other));
console.log(cjk + punct + space + digit + other === joined.length
  ? '  分项之和与字符数一致 ✓' : '  分项之和对不上 ✗');
process.exit(bad === 0 ? 0 : 1);
