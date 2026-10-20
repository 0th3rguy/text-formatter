"""用 python-docx 独立校验生成的 .docx：结构、字体、字号、行距、页码域、表格、大纲级别。"""
import sys, zipfile, re
from docx import Document
from docx.shared import Pt, Cm
from docx.oxml.ns import qn

path = sys.argv[1] if len(sys.argv) > 1 else r"D:\WorkSpace\text-formatter\test\out\sample-default.docx"
print("文件:", path)

# --- 1. ZIP 层 ---
z = zipfile.ZipFile(path)
bad = z.testzip()
print("ZIP 完整性:", "OK" if bad is None else ("损坏于 " + bad))
print("条目数:", len(z.namelist()))

# --- 2. python-docx 能否打开 ---
doc = Document(path)
print("python-docx 打开: OK")
print("段落数:", len(doc.paragraphs), " 表格数:", len(doc.tables))

# --- 3. 段落细节 ---
def para_info(p):
    fi = p.paragraph_format.first_line_indent
    pf = p.paragraph_format
    r = p.runs[0] if p.runs else None
    ea = None; sz = None; bold = None
    if r is not None:
        rPr = r._element.find(qn('w:rPr'))
        if rPr is not None:
            rf = rPr.find(qn('w:rFonts'))
            if rf is not None:
                ea = rf.get(qn('w:eastAsia'))
            szel = rPr.find(qn('w:sz'))
            if szel is not None:
                sz = int(szel.get(qn('w:val'))) / 2
            bold = rPr.find(qn('w:b')) is not None
    return dict(text=p.text[:28], align=str(pf.alignment), fi=fi, ls=pf.line_spacing,
                lsr=str(pf.line_spacing_rule), font=ea, size=sz, bold=bold)

print("\n--- 段落 (前 26 个非空) ---")
shown = 0
for p in doc.paragraphs:
    if not p.text.strip():
        continue
    i = para_info(p)
    print(f"  字{i['font']} {i['size']}pt b={i['bold']} 缩进={i['fi']} 行距={i['ls']}/{i['lsr']} | {i['text']}")
    shown += 1
    if shown >= 26:
        break

# --- 4. 大纲级别 ---
outlines = []
for p in doc.paragraphs:
    pPr = p._element.find(qn('w:pPr'))
    if pPr is not None:
        ol = pPr.find(qn('w:outlineLvl'))
        if ol is not None:
            outlines.append((int(ol.get(qn('w:val'))) + 1, p.text[:24]))
print("\n--- 大纲级别 (%d 个) ---" % len(outlines))
for lv, t in outlines[:14]:
    print(f"  L{lv} {t}")

# --- 5. 表格 ---
print("\n--- 表格 ---")
for ti, t in enumerate(doc.tables):
    print(f"  表{ti}: {len(t.rows)} 行 x {len(t.columns)} 列")
    for ri, row in enumerate(t.rows[:2]):
        print("    ", [c.text for c in row.cells])

# --- 6. 节 / 页边距 / 页眉页脚 ---
print("\n--- 节 ---")
for si, s in enumerate(doc.sections):
    print(f"  节{si}: 纸 {s.page_width.cm:.2f}x{s.page_height.cm:.2f}cm "
          f"边距 上{s.top_margin.cm:.2f} 下{s.bottom_margin.cm:.2f} 左{s.left_margin.cm:.2f} 右{s.right_margin.cm:.2f} "
          f"页眉距{s.header_distance.cm:.2f} 页脚距{s.footer_distance.cm:.2f}")
    # 页码域
    for name, part in (('页眉', s.header), ('页脚', s.footer)):
        for p in part.paragraphs:
            xml = p._element.xml
            if 'PAGE' in xml or 'NUMPAGES' in xml or p.text.strip():
                has_fld = 'fldChar' in xml or 'instrText' in xml
                print(f"    {name}: text={p.text!r} 域={has_fld} align={p.paragraph_format.alignment}")

# --- 7. settings.xml 里的起始页码 ---
sx = z.read('word/settings.xml').decode('utf-8')
m = re.search(r'w:pgNumType[^/]*', sx)
print("\nsettings pgNumType:", m.group(0) if m else "无")

print("\n校验完成")
