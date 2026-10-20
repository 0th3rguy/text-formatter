/* ============================================================
 * defaults.js — 配置模型：默认值、预设方案、常量
 * 参照 Word Formatter Pro 全量配置面 + 8 项增强
 * ============================================================ */

/** 中文字号 → pt */
const FONT_SIZE_MAP = {
  '初号': 42, '小初': 36, '一号': 26, '小一': 24, '二号': 22, '小二': 18,
  '三号': 16, '小三': 15, '四号': 14, '小四': 12, '五号': 10.5, '小五': 9,
  '六号': 7.5, '小六': 6.5, '七号': 5.5, '八号': 5
};

/** 预设字体（党政机关公文常用字体系列，兼容 GB2312 与通用名） */
const PRESET_FONT_OPTIONS = [
  '方正小标宋简体', '方正小标宋_GBK',
  '黑体', '方正黑体', '方正黑体_GBK', '思源黑体',
  '楷体', '楷体_GB2312', '方正楷体', '方正楷体_GBK',
  '仿宋', '仿宋_GB2312', '方正仿宋', '方正仿宋_GBK',
  '宋体', '新宋体', '华文中宋', '华文宋体',
  '微软雅黑', '等线', '思源宋体',
  'Times New Roman', 'Arial', 'Calibri', 'Cambria', 'Georgia', 'Verdana', 'Consolas'
];

const BLANK_LINE_MODE_OPTIONS = [
  { value: 'keep_all', label: '不改动任何空行' },
  { value: 'heading_gap', label: '★ 只在标题后留空行（正文间空行删除）' },
  { value: 'delete_single', label: '删除单个空行' },
  { value: 'keep_single', label: '保留单个空行（多个空行压缩为 1 个）' },
  { value: 'delete_all', label: '删除所有空行' }
];

/* 空格处理：从网页 / PDF / 扫描件粘来的文本常夹着全角空格、
   连续多个空格，肉眼几乎看不出来，但会挤歪排版。
   注意：行首行尾的空格在解析阶段本来就会被去掉（每行都做 trim），
   所以这里只处理「行内」的空格，才是有实际区别的两档。 */
const SPACE_MODE_OPTIONS = [
  { value: 'off', label: '不处理' },
  { value: 'collapse', label: '连续空格压成 1 个' },
  { value: 'remove_all', label: '删除所有空格（中文排版）' }
];

const LINE_SPACING_RULE_OPTIONS = [
  { value: 'single', label: '单倍行距' },
  { value: 'onehalf', label: '1.5 倍行距' },
  { value: 'double', label: '2 倍行距' },
  { value: 'multiple', label: '多倍行距（自定义）' },
  { value: 'fixed', label: '固定值（磅）' },
  { value: 'atLeast', label: '最小值（磅）' }
];

/* 行距值的单位：倍 / 磅。
   fixed、atLeast 两种规则本身就只吃磅值，选「倍」时会自动换算成磅。 */
const LINE_SPACING_UNIT_OPTIONS = [
  { value: 'pt', label: '磅（pt）' },
  { value: 'mult', label: '倍（× 字号）' }
];

/* 缩进单位：字符 / 厘米 / 磅。
   中文公文习惯按「字符」算（首行缩进 2 字符），排版习惯按厘米/磅。 */
const INDENT_UNIT_OPTIONS = [
  { value: 'chars', label: '字符' },
  { value: 'cm', label: '厘米（cm）' },
  { value: 'pt', label: '磅（pt）' }
];

/* 下拉框在左栏 400px 的网格里只有约 92px 可用宽度，
   标签必须短 —— 曾经写成「阿拉伯数字 1 2 3」，比可用宽度宽 4px 被截断。 */
const PAGE_NUMBER_FORMAT_OPTIONS = [
  { value: 'arabic', label: '阿拉伯数字' },
  { value: 'chinese', label: '中文数字' },
  { value: 'roman', label: '罗马数字' },
  { value: 'none', label: '不显示页码' }
];

const PAGE_NUMBER_POSITION_OPTIONS = [
  { value: 'footer_center', label: '页脚居中' },
  { value: 'footer_right', label: '页脚右对齐' },
  { value: 'footer_outer', label: '页脚外侧' },
  { value: 'header_center', label: '页眉居中' },
  { value: 'header_right', label: '页眉右对齐' }
];

const NUMBER_STYLE_OPTIONS = [
  { value: 'cn_dun', label: '一、二、三、（顿号）' },
  { value: 'cn_paren', label: '（一）（二）（三）' },
  { value: 'cn_circle', label: '（1）（2）（3）' },
  { value: 'arabic_dot', label: '1. 2. 3.' },
  { value: 'arabic_dun', label: '1、2、3、' },
  { value: 'arabic_multi', label: '1.1、1.1.1（多级）' },
  { value: 'chapter', label: '第一章 / 第一节' }
];

const BLANK_LINE_MODE_DELETE_SINGLE = 'delete_single';
const BLANK_LINE_MODE_KEEP_SINGLE = 'keep_single';

/** 纸张尺寸（mm）。A4 为默认；出版面与预览都按这里的数值算。 */
const PAPER_SIZES = [
  { value: 'A4',     label: 'A4（210×297mm）',   w: 210, h: 297 },
  { value: 'A3',     label: 'A3（297×420mm）',   w: 297, h: 420 },
  { value: 'B5',     label: 'B5（176×250mm）',   w: 176, h: 250 },
  { value: '16K',    label: '16 开（184×260mm）', w: 184, h: 260 },
  { value: 'Letter', label: 'Letter（216×279mm）', w: 216, h: 279 }
];
const PAPER_MAP = {};
for (const p of PAPER_SIZES) PAPER_MAP[p.value] = p;

/** 各段「行距规则」的可选值；inherit = 跟随正文行距 */
const ROLE_LINE_SPACING_RULE_OPTIONS = [
  { value: 'inherit',  label: '跟随正文' },
  { value: 'single',   label: '单倍' },
  { value: 'onehalf',  label: '1.5 倍' },
  { value: 'double',   label: '2 倍' },
  { value: 'multiple', label: '多倍' },
  { value: 'fixed',    label: '固定值' },
  { value: 'atLeast',  label: '最小值' }
];

/** 全部默认配置（39 项原始 + 增强项） */
const DEFAULT_CONFIG = {
  /* —— 页面 —— */
  force_a4: true,
  paper_size: 'A4',
  margin_top: 3.7,
  margin_bottom: 3.5,
  margin_left: 2.8,
  margin_right: 2.6,
  /* 页脚距 = 页码基线到纸张下边缘的距离（GB/T 9704 规定页码距下边缘 1.75cm 左右） */
  footer_distance: 1.75,
  header_distance: 1.5,
  gutter: 0,

  /* —— 字体 —— */
  title_font: '方正小标宋简体',
  subtitle_font: '楷体_GB2312',
  salutation_font: '仿宋_GB2312',
  h1_font: '黑体',
  h2_font: '楷体_GB2312',
  h3_font: '仿宋_GB2312',
  h4_font: '仿宋_GB2312',
  body_font: '仿宋_GB2312',
  page_number_font: '宋体',
  table_font: '仿宋_GB2312',
  table_header_font: '黑体',
  table_caption_font: '黑体',
  figure_caption_font: '黑体',
  attachment_font: '仿宋_GB2312',
  english_font: 'Times New Roman',
  use_custom_english_font: true,

  /* —— 字号（pt）—— */
  title_size: 22,
  subtitle_size: 16,
  salutation_size: 16,
  h1_size: 16,
  h2_size: 16,
  h3_size: 16,
  h4_size: 16,
  body_size: 16,
  page_number_size: 14,
  table_size: 12,
  table_header_size: 12,
  table_caption_size: 16,
  figure_caption_size: 16,
  attachment_size: 16,

  /* —— 行距 / 缩进 —— */
  line_spacing_rule: 'fixed',
  line_spacing_value: 28,
  line_spacing_unit: 'pt',
  title_line_spacing: 1.0,
  subtitle_line_spacing: 1.0,
  /* 各段行距规则（inherit = 跟随正文）。一级/二级标题默认跟随正文，
     需要的话可以从界面里单独改成固定值、倍率等，独立于正文行距。 */
  title_line_rule: 'inherit',
  subtitle_line_rule: 'inherit',
  salutation_line_rule: 'inherit',
  h1_line_rule: 'inherit',
  h2_line_rule: 'inherit',
  h3_line_rule: 'inherit',
  h4_line_rule: 'inherit',
  /* 独立行距的数值与单位（仅当对应 *_line_rule 不是 inherit 时生效） */
  h1_line_value: 28,
  h1_line_unit: 'pt',
  h2_line_value: 28,
  h2_line_unit: 'pt',
  /* 左/右缩进：值 + 单位分开存，单位可取字符（chars）/ 厘米（cm）/ 磅（pt） */
  left_indent_value: 0,
  left_indent_unit: 'cm',
  right_indent_value: 0,
  right_indent_unit: 'cm',
  /* 兼容旧键（.docx 回读与旧方案文件可能还在用），实际渲染以 *_value/_unit 为准 */
  left_indent_cm: 0,
  right_indent_cm: 0,
  first_line_indent_chars: 2,
  /* 各级标题是否缩进、缩进几字符。
     默认与正文一致缩进 2 字符 —— 若只有正文缩进而标题顶格，版面会参差不齐（用户反馈）。
     某些单位习惯一级标题顶格，把对应项改成 0 即可。 */
  h1_indent_chars: 2,
  h2_indent_chars: 2,
  h3_indent_chars: 2,
  h4_indent_chars: 2,
  title_indent_chars: 0,

  /* —— 段间距（磅）—— */
  title_space_before: 0,
  title_space_after: 0,
  heading_space_before: 0,
  heading_space_after: 0,
  body_space_before: 0,
  body_space_after: 0,

  /* —— 对齐 —— */
  title_align: 'center',
  body_align: 'both',

  /* —— 表格 —— */
  enable_table_formatting: true,
  table_row_height_cm: 0.8,
  table_auto_col_width: true,
  table_width_percent: 100,
  table_header_bold: true,
  table_smart_align: true,
  table_unified_borders: true,
  table_border_size_pt: 0.5,
  table_line_spacing: 'single',

  /* —— 其他 —— */
  set_outline: true,
  enable_attachment_formatting: true,
  /* 空行模式默认「删除单个空行」：从网页 / Word 粘来的文本段间几乎总带一个空行，
     而真实公文段与段之间不放空行。这些空行会实打实占掉整行高度
     （实测样例 22 个空行 ≈ 吃掉一整页），是「页面留白太多」的主因。
     需要保留空行的场景（如诗歌、清单）可在「段落间空行」里改回「不改动任何空行」。 */
  blank_line_mode: 'delete_single',
  normalize_punctuation: true,
  strip_markdown: true,

  /* —— 空格处理 ——
     off 不处理 / trim 去首尾 / collapse 去首尾+压缩连续 / remove_all 全删。
     另有 space_highlight 只影响预览显示（把空格标出来），不改文本。 */
  space_mode: 'off',
  space_highlight: false,

  /* —— 标题加粗（空 = 用内置规则：三级、四级加粗）—— */
  title_bold: false,
  h1_bold: false,
  h2_bold: false,
  h3_bold: true,
  h4_bold: true,

  /* —— 增强：自动编号 —— */
  auto_numbering: false,
  number_style: 'cn_dun',
  number_restart_h1: true,

  /* —— 增强：页眉 —— */
  enable_header: false,
  header_text: '',
  header_align: 'center',
  header_font: '宋体',
  header_size: 14,

  /* —— 增强：页码 —— */
  page_number_format: 'arabic',
  page_number_position: 'footer_center',
  page_number_start: 1,
  page_number_prefix: '',
  page_number_suffix: '',

  /* —— 增强：识别开关 —— */
  detect_title: true,
  detect_headings: true,
  detect_tables: true,
  detect_attachments: true,
  detect_outline: true,
  document_title: '',
  document_author: '',
  document_subject: '',

  /* —— 增强：封面 / 元数据 —— */
  add_page_break_before_h1: false
};

/** 预设方案 */
const PRESETS = {
  '党政机关公文格式': {
    force_a4: true, margin_top: 3.7, margin_bottom: 3.5, margin_left: 2.8, margin_right: 2.6,
    title_font: '方正小标宋简体', title_size: 22, title_align: 'center',
    h1_font: '黑体', h1_size: 16,
    h2_font: '楷体_GB2312', h2_size: 16,
    h3_font: '仿宋_GB2312', h3_size: 16, h3_bold: true,
    h4_font: '仿宋_GB2312', h4_size: 16, h4_bold: true,
    body_font: '仿宋_GB2312', body_size: 16,
    english_font: 'Times New Roman', use_custom_english_font: true,
    line_spacing_rule: 'fixed', line_spacing_value: 28, line_spacing_unit: 'pt',
    first_line_indent_chars: 2, body_indent_chars: 2,
    page_number_font: '宋体', page_number_size: 14,
    page_number_format: 'arabic', page_number_position: 'footer_center',
    footer_distance: 1.75, set_outline: true
  },
  '通用报告（宋体）': {
    margin_top: 2.54, margin_bottom: 2.54, margin_left: 3.17, margin_right: 3.17,
    title_font: '黑体', title_size: 22, title_align: 'center',
    h1_font: '黑体', h1_size: 16,
    h2_font: '黑体', h2_size: 15,
    h3_font: '宋体', h3_size: 14,
    h4_font: '宋体', h4_size: 12,
    body_font: '宋体', body_size: 12,
    english_font: 'Times New Roman',
    line_spacing_rule: 'onehalf', line_spacing_value: 1.5, line_spacing_unit: 'mult',
    first_line_indent_chars: 2,
    page_number_font: '宋体', page_number_size: 10.5,
    page_number_format: 'arabic', page_number_position: 'footer_center'
  },
  '论文 / 学术': {
    margin_top: 2.5, margin_bottom: 2.5, margin_left: 3.0, margin_right: 2.5,
    title_font: '黑体', title_size: 18, title_align: 'center',
    h1_font: '黑体', h1_size: 15,
    h2_font: '黑体', h2_size: 14,
    h3_font: '楷体_GB2312', h3_size: 12,
    h4_font: '宋体', h4_size: 12,
    body_font: '宋体', body_size: 12,
    english_font: 'Times New Roman',
    line_spacing_rule: 'multiple', line_spacing_value: 1.25, line_spacing_unit: 'mult',
    first_line_indent_chars: 2,
    page_number_font: '宋体', page_number_size: 10.5,
    page_number_format: 'arabic', page_number_position: 'footer_center'
  },
  '简洁 / 无修饰': {
    margin_top: 2.54, margin_bottom: 2.54, margin_left: 2.54, margin_right: 2.54,
    title_font: '黑体', title_size: 18, title_align: 'center',
    h1_font: '黑体', h1_size: 14,
    h2_font: '黑体', h2_size: 12,
    h3_font: '宋体', h3_size: 12,
    h4_font: '宋体', h4_size: 12,
    body_font: '宋体', body_size: 12,
    english_font: 'Calibri', use_custom_english_font: true,
    line_spacing_rule: 'single', line_spacing_value: 1.0, line_spacing_unit: 'mult',
    first_line_indent_chars: 0,
    h1_indent_chars: 0, h2_indent_chars: 0, h3_indent_chars: 0, h4_indent_chars: 0,
    page_number_format: 'none'
  }
};

/** 需要「角色 → 字体/字号」映射的段落类型 */
const ROLE_KEYS = ['title', 'subtitle', 'salutation', 'h1', 'h2', 'h3', 'h4', 'body', 'attachment', 'table_caption', 'figure_caption'];

const ROLE_LABELS = {
  title: '主标题', subtitle: '副标题', salutation: '主送机关', h1: '一级标题', h2: '二级标题',
  h3: '三级标题', h4: '四级标题', body: '正文', attachment: '附件标记',
  table_caption: '表标题', figure_caption: '图标题'
};

/** 合并配置：overrides 覆盖 base */
function mergeConfig(base, overrides) {
  const out = Object.assign({}, base);
  if (overrides) {
    for (const k of Object.keys(overrides)) {
      if (overrides[k] !== undefined && overrides[k] !== null) out[k] = overrides[k];
    }
  }
  return out;
}

if (typeof window !== 'undefined') {
  window.WFPDefaults = {
    FONT_SIZE_MAP, PRESET_FONT_OPTIONS, BLANK_LINE_MODE_OPTIONS,
    SPACE_MODE_OPTIONS,
    LINE_SPACING_RULE_OPTIONS, LINE_SPACING_UNIT_OPTIONS, INDENT_UNIT_OPTIONS,
    ROLE_LINE_SPACING_RULE_OPTIONS, PAPER_SIZES, PAPER_MAP,
    PAGE_NUMBER_FORMAT_OPTIONS,
    PAGE_NUMBER_POSITION_OPTIONS, NUMBER_STYLE_OPTIONS,
    BLANK_LINE_MODE_DELETE_SINGLE, BLANK_LINE_MODE_KEEP_SINGLE,
    DEFAULT_CONFIG, PRESETS, ROLE_KEYS, ROLE_LABELS, mergeConfig
  };
}
