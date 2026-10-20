/* 直接测解析器：Word 复制出来的形态（每段一行、段间无空行、正文行无编号），
   看正文行会不会被合并成一段。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');
const sandbox = {
  TextEncoder, TextDecoder, CompressionStream, DecompressionStream, Blob,
  setTimeout, clearTimeout, console,
  btoa: s => Buffer.from(s, 'binary').toString('base64'),
  atob: s => Buffer.from(s, 'base64').toString('binary')
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['zip.js', 'defaults.js', 'parser.js']) {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), sandbox, { filename: f });
}
const P = sandbox.WFPParser;
const D = sandbox.WFPDefaults;

const cases = {
  'A. Word 复制：每段一行，正文无编号（用户场景）': [
    '卷烟物流配送中心“四个强化”夯实运营管理根基',
    '近日，卷烟物流配送中心聚焦运行管控、制度流程、成本压降、精益提升四项重点精准发力，推动整体运行平稳有序、提质增效。',
    '强化全域管控，下好协同联动“一盘棋”。针对区域物流业务模式，中心搭建一体化联动管控模式。',
    '强化制度执行，立好规范运营“一把尺”。对照业务模式，全面梳理干线交接作业流程。',
    '强化成本管控，算好节约降耗“一笔账”。聚焦车辆运维、燃油消耗等可控支出实施精细化管理。',
    '强化精益赋能，打好提质增效“一套拳”。聚焦配送效率、服务品质推进流程再造。'
  ].join('\n'),

  'B. 段间有空行的常规粘贴': [
    '关于进一步加强信息化建设工作的通知',
    '',
    '各部门、各直属单位：',
    '',
    '为深入贯彻落实上级决策部署，现将有关事项通知如下。',
    '',
    '一、总体要求',
    '',
    '坚持以需求为导向，统筹推进协调发展。'
  ].join('\n'),

  'C. 硬折行文本（一行一个物理行，逻辑段落跨多行）': [
    '这是第一段的内容，它被硬折行切成了好几个物理行，',
    '每一行都不长，也没有句末标点，',
    '最后在这里结束。',
    '这是第二段，同样被折行拆开，',
    '最终也以句号结尾。'
  ].join('\n'),

  'D. Word 用 \\r\\n 换行': [
    '测试标题',
    '第一段正文内容，完整的一句话。',
    '第二段正文内容，另一句完整的话。'
  ].join('\r\n'),

  'E. 含 U+2029 段落分隔符（部分应用粘贴时如此）': [
    '测试标题',
    '第一段正文，有句号。',
    '第二段正文，也有句号。'
  ].join('\u2029')
};

for (const [name, text] of Object.entries(cases)) {
  const cfg = D.mergeConfig(D.DEFAULT_CONFIG, {});
  const blocks = P.parseText(text, Object.assign({
    detect_title: true, detect_headings: true, detect_tables: true,
    detect_attachments: true, strip_markdown: true, normalize_punctuation: true,
    blank_line_mode: 'keep_all', split_inline_heading: true
  }, {}));
  const stats = P.summarizeBlocks(blocks);
  const nonBlank = blocks.filter(b => b.type !== 'blank');
  console.log('\n=== ' + name + ' ===');
  console.log('  输入行数(非空): ' + text.split(/\r\n|\r|\n|\u2028|\u2029|\v/).filter(x => x.trim()).length +
              '   解析出非空块: ' + nonBlank.length + '   ' + JSON.stringify(stats));
  nonBlank.forEach((b, i) => {
    const t = (b.text || (b.rows ? b.rows.map(r => r.join('|')).join(' / ') : '')).slice(0, 60);
    console.log('    [' + i + '] ' + b.type + (b.level ? '(L' + b.level + ')' : '') + '  ' + t);
  });
}
