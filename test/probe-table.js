const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const sandbox = { console, TextEncoder, TextDecoder, CompressionStream, DecompressionStream, Blob, setTimeout, clearTimeout };
sandbox.window = sandbox;
const ctx = vm.createContext(sandbox);
for (const f of ['zip.js', 'defaults.js', 'parser.js', 'docx.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', f), 'utf8'), ctx, { filename: f });
}
const P = sandbox.WFPParser;
const D = sandbox.WFPDefaults;
const cfg = Object.assign({}, D.DEFAULT_CONFIG);

const tblLines = [
  '序号\t任务内容\t责任部门\t完成时限',
  '1\t网络升级改造\t信息中心\t2026年6月',
  '2\t业务系统整合\t业务处\t2026年9月',
  '3\t数据资源目录编制\t综合处\t2026年12月'
];
console.log('=== looksLikeTableRow ===');
tblLines.forEach(l => {
  const t = P.normalizePunctuation(l);
  console.log(JSON.stringify(l), '->', P.looksLikeTableRow(l), '| 归一化后:', JSON.stringify(t), '| 仍像表格行:', P.looksLikeTableRow(t));
});

console.log('\n=== splitTableRow ===');
tblLines.forEach(l => console.log(JSON.stringify(l), '->', JSON.stringify(P.splitTableRow(l))));

const sample = fs.readFileSync(path.join(ROOT, 'test', 'sample.txt'), 'utf8');
console.log('\n=== 原始 sample 中的表格行 ===');
sample.split('\n').forEach((l, i) => {
  if (l.includes('\t')) console.log('  行', i, JSON.stringify(l));
});

console.log('\n=== 归一化后 sample 中的表格行 ===');
const norm = sample.split('\n').map(l => l.trim() ? P.normalizePunctuation(l) : '');
norm.forEach((l, i) => { if (l.includes('\t')) console.log('  行', i, JSON.stringify(l)); });
console.log('\n=== 归一化后是否还有非表格行含制表符 ===');
norm.forEach((l, i) => { if (l.includes('\t') && !P.looksLikeTableRow(l)) console.log('  !! 行', i, JSON.stringify(l)); });

console.log('\n=== 解析出的表格块 ===');
const blocks = P.parseText(sample, cfg);
blocks.filter(b => b.type === 'table').forEach(b => {
  console.log('  行数', b.rows.length);
  b.rows.forEach(r => console.log('   ', JSON.stringify(r)));
});
