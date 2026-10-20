/* ============================================================
 * parser.js — 文本解析引擎
 * 职责：Markdown 剥离 → 标点标准化 → 空行处理 → 结构识别
 * 产出统一的段落块数组，交给 docx.js 渲染。
 * ============================================================ */

const RE_MD_HEADING = /^(#{1,6})\s+(.*)$/;
const RE_MD_HR = /^\s*([-*_]\s*){3,}$/;
const RE_MD_FENCE = /^\s*(```|~~~)/;
/* 注意：故意不把 `1.` 当 Markdown 有序列表剥离 —— 中文文档里它几乎总是三级标题，
   剥离会导致三级标题全部消失。只剥离明确的圆点/星号项目符号与 `1)` 形式。 */
const RE_MD_LIST = /^\s*([-*+]|\d+\))\s+/;
const RE_MD_QUOTE = /^\s*>\s?/;
const RE_MD_TABLE_SEP = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;

/* 中文序号标题识别 */
const RE_H_CN_DUN = /^\s*([一二三四五六七八九十百]+)\s*[、.．]\s*(.*)$/;          // 一、
const RE_H_CN_PAREN = /^\s*[（(]\s*([一二三四五六七八九十百]+)\s*[）)]\s*(.*)$/;   // （一）
const RE_H_CN_CIRCLE = /^\s*[（(]\s*(\d{1,2})\s*[）)]\s*(.*)$/;                    // （1）
const RE_H_ARABIC_DOT = /^\s*(\d{1,2})\s*[.．]\s*(.*)$/;                           // 1.
const RE_H_ARABIC_DUN = /^\s*(\d{1,2})\s*[、]\s*(.*)$/;                            // 1、
const RE_H_ARABIC_MULTI = /^\s*(\d{1,2}(?:[.．]\d{1,2}){1,3})\s*[.．、]?\s*(.*)$/;  // 1.1 / 1.1.1
const RE_H_CHAPTER = /^\s*第\s*([一二三四五六七八九十百\d]+)\s*([章节部分篇])\s*(.*)$/;
const RE_H_KEYWORD = /^\s*(附\s*件|附\s*录|表|图)\s*[:：]?\s*(\d+)?\s*[：:、.]?\s*(.*)$/;

/* 主送机关（公文的「称呼」行）：以冒号结尾、通篇无句末标点、通常 ≤ 两行。
   例：各部门、各直属单位： / 各市、县（区）人民政府，市直各单位： / 各处室：
   排除正文小标题式冒号句（如「一是装卸控损，把好运输“源头关”。」不以冒号结尾，
   而「会议要求：」这类句子会因含句末标点或出现在正文中段而不被误判）。 */
const RE_SALUTATION_END = /[：:]$/;
const RE_SALUTATION_BAD = /[。！？!?；;]/;

/* 段落是否已经「说完」：判断相邻物理行应该合并（硬折行）还是各自成段。
   从 Word/WPS 复制出来的文本是「一段一行、段间无空行」，每段以句末标点收尾，
   此时不能把下一行接上来，否则整篇会被并成一段。 */
function paraEnded(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return true;
  // 以句末标点收尾（允许后面跟收尾的引号/括号）
  if (/[。！？；…!?;：]\s*[）”"’』」]*$/.test(t)) return true;
  // 以收尾括号/引号结尾，且句中已有句末标点（如「……（详见附件1）」）
  if (/[）)】」』”"’]\s*$/.test(t) && /[。！？；…!?;]/.test(t)) return true;
  return false;
}

/* 长度悬殊时不合并 —— 但只在「当前累积的很短、下一行很长」时才判定为两段。
   方向很重要：硬折行文本的**最后一行**本来就短（长行之后接短行），
   那种情况必须照常合并；而 Word 粘贴里「具体要求如下」这类短引导句
   后面紧跟一大段，才是真的两段。 */
const PARA_MERGE_LEN_RATIO = 2.5;

/** 当前累积段落很短、下一行很长 → 应各自成段，不合并 */
function lengthMismatch(cur, next) {
  const a = String(cur || '').trim().length;
  const b = String(next || '').trim().length;
  if (!a || !b) return false;
  // 只有「短 → 长」才拦；「长 → 短」是折行段落的正常收尾
  return b / a > PARA_MERGE_LEN_RATIO && a < 24;
}

/* ---------------- 标点与字符标准化 ---------------- */

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;
function hasCJK(s) { return CJK_RE.test(s); }

/** 成对处理引号：偶数位置开引号，奇数位置闭引号 */
function normalizeQuotes(text) {
  let out = '';
  let dqOpen = true, sqOpen = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') { out += dqOpen ? '\u201c' : '\u201d'; dqOpen = !dqOpen; }
    else if (ch === "'") { out += sqOpen ? '\u2018' : '\u2019'; sqOpen = !sqOpen; }
    else out += ch;
  }
  return out;
}

/**
 * 标点标准化：英文标点 → 中文标点（仅在中文字符语境下），并规整常见错误。
 */
function normalizePunctuation(text) {
  let s = text;

  /* 空格完全不在这里处理 —— 全部交给「空格处理」（applySpaceMode）。
     历史上这里做过「全角空格→半角 + 连续空格压缩」，导致
     「不处理」和「合并空格」两档效果一模一样、高亮也永远区分不出全角空格（真实缺陷）。
     标点标准化的职责只到标点为止。 */

  // 省略号
  s = s.replace(/\.{3,}/g, '……').replace(/。{2,}/g, '。');
  // 破折号
  s = s.replace(/_{2,}|-{2,}/g, '——');

  // 括号：紧跟中文字符时转中文括号（只跨越空格，不跨越制表符）
  s = s.replace(/([\u4e00-\u9fff])[ ]*\([ ]*/g, '$1（');
  s = s.replace(/[ ]*\)[ ]*([\u4e00-\u9fff]|$)/g, '）$1');
  // 行首左括号
  s = s.replace(/^\([ ]*/g, '（');
  s = s.replace(/[ ]*\)[ ]*$/g, '）');

  // 逗号 / 分号 / 冒号 / 叹号 / 问号：后接或前接中文
  s = s.replace(/([\u4e00-\u9fff])[ ]*,[ ]*/g, '$1，');
  s = s.replace(/([\u4e00-\u9fff])[ ]*;[ ]*/g, '$1；');
  s = s.replace(/([\u4e00-\u9fff])[ ]*:[ ]*/g, '$1：');
  s = s.replace(/([\u4e00-\u9fff])[ ]*![ ]*/g, '$1！');
  s = s.replace(/([\u4e00-\u9fff])[ ]*\?[ ]*/g, '$1？');
  s = s.replace(/([\u4e00-\u9fff])[ ]*\.[ ]*([ ]|$)/g, '$1。$2');

  // 句号在非 ASCII 数字场景下的点号（1.2 → 保留；仅行尾孤点转换）
  s = s.replace(/([\u4e00-\u9fff])\.$/g, '$1。');

  // 引号
  s = s.replace(/[ ]*"([^"]*)"[ ]*/g, (m, inner) => '“' + inner + '”');
  s = normalizeQuotes(s);

  // 中文之间多余空格（同样不跨越制表符）
  s = s.replace(/([\u4e00-\u9fff])[ ]+([\u4e00-\u9fff])/g, '$1$2');

  // 数字/英文与中文间的空格保留（增强可读性），但压缩多空格
  s = s.replace(/[ ]{2,}/g, ' ').trim();

  return s;
}

/* ---------------- Markdown 剥离 ---------------- */

function stripMarkdownInline(text) {
  let s = text;
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');          // 图片 → alt
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');            // 链接 → 文本
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '$1');
  s = s.replace(/\*\*(.+?)\*\*/g, '$1');
  s = s.replace(/___(.+?)___/g, '$1');
  s = s.replace(/__(.+?)__/g, '$1');
  s = s.replace(/(^|[^*])\*(?!\s)([^*]+?)\*/g, '$1$2');
  s = s.replace(/(^|[^_])_(?!\s)([^_]+?)_/g, '$1$2');
  s = s.replace(/~~(.+?)~~/g, '$1');
  s = s.replace(/`([^`]+)`/g, '$1');
  s = s.replace(/<[^>]{1,80}>/g, '');                       // HTML 标签
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
       .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  return s;
}

/* ---------------- 结构识别 ---------------- */

/**
 * 判断一段独立文本是否像标题，返回 {level:1..4, text, kind} 或 null。
 */
function classifyHeading(text, cfg) {
  const t = text.trim();
  if (!t) return null;

  // Markdown 显式标题
  const md = t.match(RE_MD_HEADING);
  if (md) {
    const lv = Math.min(4, md[1].length);
    return { level: lv, text: md[2].trim(), kind: 'md' };
  }

  // 章节：第一章
  const ch = t.match(RE_H_CHAPTER);
  if (ch) return { level: 1, text: t, kind: 'chapter' };

  // 附件 / 表 / 图（独立成行）
  const kw = t.match(RE_H_KEYWORD);
  if (kw && cfg.enable_attachment_formatting !== false) {
    const word = kw[1].replace(/\s+/g, '');
    if (word === '附件' || word === '附录') return { level: 5, text: t, kind: 'attachment' };
    if (word === '表') return { level: 6, text: t, kind: 'table_caption' };
    if (word === '图') return { level: 7, text: t, kind: 'figure_caption' };
  }

  // 一、
  const cnDun = t.match(RE_H_CN_DUN);
  if (cnDun && cnDun[1].length <= 4) return { level: 1, text: t, kind: 'cn_dun', num: cnDun[1], body: cnDun[2] };

  // （一）
  const cnParen = t.match(RE_H_CN_PAREN);
  if (cnParen) return { level: 2, text: t, kind: 'cn_paren', num: cnParen[1], body: cnParen[2] };

  // （1）
  const cnCircle = t.match(RE_H_CN_CIRCLE);
  if (cnCircle) {
    return { level: 4, text: t, kind: 'cn_circle', num: cnCircle[1], body: cnCircle[2] };
  }

  // 1.1 / 1.1.1（多级）
  const multi = t.match(RE_H_ARABIC_MULTI);
  if (multi && multi[1].includes('.')) {
    const depth = multi[1].split(/[.．]/).filter(Boolean).length;
    const level = Math.min(4, depth + 1);   // 1.1 → 3 级
    return { level, text: t, kind: 'arabic_multi', num: multi[1], body: multi[2] };
  }

  // 1. 或 1、
  const arabicDot = t.match(RE_H_ARABIC_DOT);
  if (arabicDot) {
    return { level: 3, text: t, kind: 'arabic_dot', num: arabicDot[1], body: arabicDot[2] };
  }
  const arabicDun = t.match(RE_H_ARABIC_DUN);
  if (arabicDun) {
    return { level: 3, text: t, kind: 'arabic_dun', num: arabicDun[1], body: arabicDun[2] };
  }

  return null;
}

/**
 * 阿拉伯/圆圈序号后面的内容是否「像标题」而不是一句正文。
 * 「1. 具体措施」→ 标题；「1. 各部门要高度重视，认真抓好落实，确保任务完成。」→ 正文序号条目。
 */
function isHeadingLike(body) {
  const b = (body || '').trim();
  if (!b) return false;
  if (b.length > 30) return false;
  if (/[。；！？!?]/.test(b)) return false;
  if (/[，,].*[，,]/.test(b)) return false;   // 两个以上逗号，像句子
  if (/[：:]$/.test(b)) return false;          // 「1. 说明：」多为引导句
  return true;
}

/**
 * 段内拆分：标题与正文挤在同一段时切开。
 * 「1. 统一规划。避免重复建设，确保系统互联互通。」→ 标题「1. 统一规划」+ 正文「避免重复建设…」
 * 判据：第一个句末标点之前的片段足够短（≤24 字）且其后还有内容。
 * @returns {{heading:string, body:string}|null}
 */
function splitInlineHeading(body) {
  const b = (body || '').trim();
  if (!b) return null;
  const m = b.match(/^(.{1,60}?)([。；！？!?])\s*(.+)$/s);
  if (!m) return null;
  const head = m[1].trim();
  const rest = m[3].trim();
  if (!head || !rest) return null;
  if (head.length > 24) return null;          // 太长，不像标题
  if (rest.length < 2) return null;
  if (/[，,].*[，,]/.test(head)) return null;   // 标题里不应有多个逗号
  return { heading: head, body: rest };
}

/**
 * 把一段文本解析为「标题(+可能的同段正文)」或「正文」，供 parseText 与 docx 回读共用。
 * @returns {{type:string, level?:number, text:string, kind?:string, num?:string|null, bodyText?:string|null}|null}
 *          返回 null 表示不是标题
 */
function resolveHeading(text, cfg) {
  const c = cfg || {};
  const head = classifyHeading(text, c);
  if (!head) return null;

  // 附件 / 表 / 图 题注：不参与段内拆分
  if (head.kind === 'attachment') return { type: 'attachment', text: head.text };
  if (head.kind === 'table_caption') return { type: 'table_caption', text: head.text };
  if (head.kind === 'figure_caption') return { type: 'figure_caption', text: head.text };
  if (head.kind === 'md') {
    return { type: 'heading', level: Math.max(1, Math.min(4, head.level)), text: head.text, kind: 'md' };
  }
  if (head.kind === 'chapter' || head.kind === 'cn_dun' || head.kind === 'cn_paren') {
    return { type: 'heading', level: Math.max(1, Math.min(4, head.level)), text: head.text, kind: head.kind, num: head.num || null };
  }

  // 阿拉伯 / 圆圈序号：可能是标题，也可能是「标题+正文同段」
  if (head.body != null) {
    const sp = c.split_inline_heading !== false ? splitInlineHeading(head.body) : null;
    if (sp) {
      const prefix = head.text.slice(0, head.text.length - head.body.length);
      return {
        type: 'heading', level: Math.max(1, Math.min(4, head.level)),
        text: prefix + sp.heading, kind: head.kind, num: head.num || null,
        bodyText: sp.body
      };
    }
    if (!isHeadingLike(head.body)) return null;   // 整段其实是正文
  }
  return { type: 'heading', level: Math.max(1, Math.min(4, head.level)), text: head.text, kind: head.kind, num: head.num || null };
}

/** 是否为表格行（含制表符，或多个连续空格分隔的多列，或 markdown 管道） */
function looksLikeTableRow(line) {
  if (line.includes('\t') && line.split('\t').filter(s => s.trim()).length >= 2) return true;
  if (/^\s*\|.*\|\s*$/.test(line)) return true;
  return false;
}

function splitTableRow(line) {
  let s = line.trim();
  if (/^\|/.test(s)) {
    s = s.replace(/^\|/, '').replace(/\|$/, '');
    return s.split('|').map(x => x.trim());
  }
  if (s.includes('\t')) return s.split('\t').map(x => x.trim());
  return s.split(/\s{2,}/).map(x => x.trim());
}

/* ---------------- 主流程 ---------------- */

/**
 * 解析纯文本 → 块数组
 * @param {string} raw
 * @param {object} cfg
 * @returns {Array<{type:string, text?:string, level?:number, rows?:string[][], kind?:string}>}
 */
function parseText(raw, cfg = {}) {
  const opts = {
    strip_markdown: cfg.strip_markdown !== false,
    normalize_punctuation: cfg.normalize_punctuation !== false,
    blank_line_mode: cfg.blank_line_mode || 'keep_all',
    detect_title: cfg.detect_title !== false,
    detect_headings: cfg.detect_headings !== false,
    detect_tables: cfg.detect_tables !== false,
    detect_attachments: cfg.enable_attachment_formatting !== false,
    split_inline_heading: cfg.split_inline_heading !== false,
    ...cfg
  };

  /* 统一换行：除了 \r\n / \r，还要处理从 Word、WPS、记事本等应用粘贴时
     可能出现的其他「软换行」分隔符。否则整段会被当成一行（真实缺陷）。 */
  let text = String(raw)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2028\u2029\u0085\v\f]/g, '\n')
    .replace(/\u00a0/g, ' ');

  // markdown 剥离（逐行，代码围栏内的内容保留原样）
  if (opts.strip_markdown) {
    const lines = text.split('\n');
    const out = [];
    let inFence = false;
    for (const line of lines) {
      if (RE_MD_FENCE.test(line)) { inFence = !inFence; continue; }
      if (inFence) { out.push(line); continue; }
      if (RE_MD_HR.test(line)) { out.push(''); continue; }
      let s = line;
      s = s.replace(RE_MD_QUOTE, '');
      s = s.replace(RE_MD_LIST, '');
      s = stripMarkdownInline(s);
      out.push(s);
    }
    text = out.join('\n');
  }

  // 空格处理（放在空行处理之前，否则「只有空格的行」不会被当成空行）
  if (opts.space_mode && opts.space_mode !== 'off') {
    text = applySpaceMode(text.split('\n'), opts.space_mode).join('\n');
  }

  // 空行模式
  let rawLines = text.split('\n');
  rawLines = applyBlankLineMode(rawLines, opts.blank_line_mode, opts);
  text = rawLines.join('\n');

  // 标点标准化
  if (opts.normalize_punctuation) {
    /* 注意：不传 opts —— 空格由「空格处理」单独负责，
       标点标准化不再碰空格（否则两档空格模式效果会一模一样）。 */
    text = text.split('\n').map(l => l.trim() ? normalizePunctuation(l) : '').join('\n');
  }

  // 切块
  const lines = text.split('\n');
  const blocks = [];
  let i = 0;
  let firstContentSeen = false;
  let titleDone = false;
  let subtitleDone = false;
  /* 主送机关：仅允许出现在主标题（及可能的副标题）之后的第一处内容位置。
     salutationPending = 已见到主标题、尚未见到主送机关；一旦遇到不匹配的内容段落即关闭，
     避免正文中段形如「xxx：」的行被误判。 */
  let salutationDone = false;
  let salutationPending = false;
  const headingStack = [];

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // 空行
    if (!trimmed) {
      let n = 1;
      while (i + n < lines.length && !lines[i + n].trim()) n++;
      blocks.push({ type: 'blank', count: n });
      i += n;
      continue;
    }

    // 表格块
    if (opts.detect_tables && looksLikeTableRow(line)) {
      const rows = [];
      let j = i;
      while (j < lines.length && lines[j].trim() && looksLikeTableRow(lines[j])) {
        if (!RE_MD_TABLE_SEP.test(lines[j])) rows.push(splitTableRow(lines[j]));
        j++;
      }
      if (rows.length >= 1) {
        blocks.push({ type: 'table', rows });
        i = j;
        continue;
      }
    }

    // 标题（含「标题+正文同段」的段内拆分）
    const resolved = opts.detect_headings ? resolveHeading(trimmed, opts) : null;

    if (resolved && (resolved.type === 'attachment' || resolved.type === 'table_caption' || resolved.type === 'figure_caption')) {
      blocks.push({ type: resolved.type, text: resolved.text });
      firstContentSeen = true;
      salutationPending = false;
      i++;
      continue;
    }

    if (resolved) {
      const lv = Math.max(1, Math.min(4, resolved.level));
      blocks.push({
        type: 'heading', level: lv, text: resolved.text,
        kind: resolved.kind, num: resolved.num || null, body: null
      });
      headingStack[lv] = (headingStack[lv] || 0) + 1;
      for (let k = lv + 1; k <= 4; k++) headingStack[k] = 0;
      // 同段正文拆出来单独成段
      if (resolved.bodyText) blocks.push({ type: 'body', text: resolved.bodyText });
      firstContentSeen = true;
      salutationPending = false;
      i++;
      continue;
    }

    // 主标题：第一个内容段落
    if (opts.detect_title && !titleDone && !firstContentSeen) {
      const isShort = trimmed.length <= 60;
      if (isShort) {
        blocks.push({ type: 'title', text: trimmed, markdown: /^#\s/.test(line) });
        titleDone = true;
        firstContentSeen = true;
        salutationPending = true;
        i++;
        continue;
      }
    }

    // 副标题：紧跟主标题（允许中间隔空行）、无句末标点、较短
    if (opts.detect_title && titleDone && !subtitleDone) {
      let lastBlock = blocks[blocks.length - 1];
      if (lastBlock && lastBlock.type === 'blank') lastBlock = blocks[blocks.length - 2];
      if (lastBlock && lastBlock.type === 'title') {
        const noEnd = !/[。！？；!?;：:]$/.test(trimmed);
        if (trimmed.length <= 40 && noEnd && hasCJK(trimmed)) {
          blocks.push({ type: 'subtitle', text: trimmed });
          subtitleDone = true;
          firstContentSeen = true;
          i++;
          continue;
        }
        subtitleDone = true;
      }
    }

    // 主送机关：主标题/副标题之后的「xxx：」行（公文的称呼，顶格、仿宋三号）
    if (opts.detect_title && titleDone && !salutationDone && salutationPending) {
      if (trimmed.length <= 60 && RE_SALUTATION_END.test(trimmed) &&
          hasCJK(trimmed) && !RE_SALUTATION_BAD.test(trimmed)) {
        blocks.push({ type: 'salutation', text: trimmed });
        salutationDone = true;
        firstContentSeen = true;
        i++;
        continue;
      }
      salutationPending = false;
    }

    /* 普通段落（可能多行合并为一段）。
       合并只针对「硬折行」文本：一个逻辑段落被切成多个物理行 ——
       此时当前行还没说完（无句末标点），才把下一行接上。
       从 Word/WPS 复制出来的文本是「一段一行、段间无空行」，每段都以
       。！？；： 等收尾，此时不能合并，否则整篇会被并成一段（真实缺陷）。 */
    let para = trimmed;
    let k = i + 1;
    while (k < lines.length && lines[k].trim() && !looksLikeTableRow(lines[k]) &&
           !(opts.detect_headings && resolveHeading(lines[k].trim(), opts)) &&
           !paraEnded(para) &&
           !lengthMismatch(para, lines[k].trim())) {
      para += lines[k].trim();
      k++;
    }
    blocks.push({ type: 'body', text: para });
    subtitleDone = true;
    salutationPending = false;
    firstContentSeen = true;
    i = k;
  }

  return blocks;
}

/* ---------------- 空格处理 ---------------- */

/** 按模式处理空格。返回处理后的行数组（逐行处理，不动换行）。
    off        不处理
    collapse   把连续空格（含全角空格）压成 1 个半角空格
    remove_all 删除所有空格（含全角空格）
    注意：制表符是表格列分隔符，任何模式都绝不能动它。
    行首行尾空格不在这里处理 —— 解析时每行本来就会 trim。 */
function applySpaceMode(lines, mode) {
  if (!mode || mode === 'off') return lines;
  return lines.map(line => {
    if (!line.trim()) return '';
    /* 先按制表符切分，逐段处理再拼回，保证表格不会塌 */
    return line.split('\t').map(seg => {
      if (mode === 'remove_all') return seg.replace(/[\u3000 \u00a0]/g, '');
      if (mode === 'collapse') return seg.replace(/[\u3000 \u00a0]+/g, ' ');
      return seg;
    }).join('\t');
  });
}

/** 统计文本里的空格数量（用于提示「发现 N 个空格」） */
function countSpaces(text) {
  const m = String(text).match(/[\u3000 \u00a0]/g);
  return m ? m.length : 0;
}

/** 段落间空行模式处理
    heading_gap：中文笔杆子最常用的版式 —— 每个标题段后面留一个空行，
                 正文段落之间不留空行。判定靠 resolveHeading，因此
                 「一、」「（一）」「1.」等各级标题都能正确认出来。 */
function applyBlankLineMode(lines, mode, opts) {
  if (mode === 'keep_all') return lines;
  if (mode === 'heading_gap') return blankAfterHeading(lines, opts || {});
  const out = [];
  let blankRun = 0;
  for (const line of lines) {
    if (!line.trim()) { blankRun++; continue; }
    if (blankRun > 0) {
      if (mode === 'delete_single' && blankRun === 1) {
        // 丢弃
      } else if (mode === 'keep_single') {
        out.push('');
      } else if (mode === 'delete_all') {
        // 丢弃
      } else {
        for (let n = 0; n < blankRun; n++) out.push('');
      }
    }
    blankRun = 0;
    out.push(line);
  }
  if (blankRun > 0 && mode !== 'delete_all' && mode !== 'delete_single' && mode !== 'keep_single') {
    for (let n = 0; n < blankRun; n++) out.push('');
  }
  return out;
}

/** 「只在标题后留空行」：删掉所有空行，再在每个标题段之后补一个。
    主标题、副标题、各级标题算标题；图表题注与附件标记**不补空行**
    （它们必须紧贴自己的表格/图片，中间插空行会把题注和图表拆开）。
    例外：标题紧跟标题时不插空行（如「一、总体要求」下面直接是「（一）指导思想」，
    真实公文这两行是连着的，标题之间不该出现空行）。 */
function blankAfterHeading(lines, opts) {
  /* 先把有内容的行收拢，后续判断「下一处内容是不是标题」就方便了 */
  const content = lines.filter(ln => ln.trim());
  if (!content.length) return [];

  let firstContentSeen = false;
  const isHeadingLine = (ln) => {
    const t = String(ln || '').trim();
    if (!t) return false;
    /* 第一处内容按「主标题」处理（与 parseText 的判定一致：
       第一个内容段落且不太长）。公文主标题下面通常空一行再接主送机关。 */
    if (!firstContentSeen && opts.detect_title !== false && t.length <= 60) {
      firstContentSeen = true;
      return true;
    }
    firstContentSeen = true;
    if (opts.detect_headings === false) return false;
    const r = resolveHeading(t, opts);
    if (!r) return false;
    /* 题注（表 / 图）和附件标记不补空行 —— 它们要贴着自己的图表 */
    if (r.type === 'table_caption' || r.type === 'figure_caption' ||
        r.type === 'attachment') return false;
    return true;
  };

  /* 一次性算出每行是否为标题（顺序判定，firstContentSeen 才能正确推进） */
  const flags = content.map(isHeadingLine);

  /* 副标题行：紧跟主标题、较短、无句末标点、含中文（与 parseText 的副标题判定一致）。
     它不算「标题」但必须和主标题连在一起 —— 否则主标题与副标题之间会凭空多一个空行。 */
  const isSubtitleLine = (i) => {
    if (i !== 1 || !flags[0]) return false;      // 只可能是主标题正下面那一行
    const t = String(content[i] || '').trim();
    if (!t || t.length > 40) return false;
    if (/[。！？；!?;：:]$/.test(t)) return false;
    return hasCJK(t);
  };

  const out = [];
  for (let i = 0; i < content.length; i++) {
    out.push(content[i]);
    if (!flags[i]) continue;
    if (isSubtitleLine(i + 1)) continue;         // 下一行是副标题 → 不插空行
    const next = content[i + 1];
    if (!next) continue;
    const nextIsHeading = flags[i + 1];
    /* 下一行是表格数据行 → 标题是这张表的题注，不能插空行 */
    const nextIsTableRow = opts.detect_tables !== false && looksLikeTableRow(next);
    if (!nextIsHeading && !nextIsTableRow) out.push('');
  }
  // 去掉末尾多余空行
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}

/* ---------------- 统计信息（用于界面反馈） ---------------- */

function summarizeBlocks(blocks) {
  const s = { title: 0, subtitle: 0, salutation: 0, h1: 0, h2: 0, h3: 0, h4: 0, body: 0, table: 0, caption: 0, blank: 0 };
  for (const b of blocks) {
    if (b.type === 'title') s.title++;
    else if (b.type === 'subtitle') s.subtitle++;
    else if (b.type === 'salutation') s.salutation++;
    else if (b.type === 'heading') s['h' + b.level]++;
    else if (b.type === 'table') s.table++;
    else if (b.type === 'attachment' || b.type === 'table_caption' || b.type === 'figure_caption') s.caption++;
    /* 空行按「行数」累计而不是「块数」：解析器会把连续空行合并成一个 count=N 的块，
       按块计数会让「5 个空行」实际渲染出 15 行空段落，提示与观感对不上。 */
    else if (b.type === 'blank') s.blank += (b.count || 1);
    else s.body++;
  }
  return s;
}

if (typeof window !== 'undefined') {
  window.WFPParser = {
    parseText, classifyHeading, resolveHeading, summarizeBlocks,
    normalizePunctuation, stripMarkdownInline, applyBlankLineMode,
    splitTableRow, looksLikeTableRow, hasCJK,
    applySpaceMode, countSpaces,
    isHeadingLike, splitInlineHeading
  };
}
