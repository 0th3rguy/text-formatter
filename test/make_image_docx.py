# 造一个带图片的 .docx，用于检验「重新排版」链路是否保留图片。
import os
from PIL import Image, ImageDraw
from docx import Document
from docx.shared import Cm, Pt

OUT = r"D:\WorkSpace\text-formatter\test\out"
os.makedirs(OUT, exist_ok=True)

# 1. 造两张不同颜色的 PNG 作为嵌入图片
paths = []
for i, (color, label) in enumerate([((30, 90, 180), "FIG1"), ((200, 60, 60), "FIG2")], start=1):
    im = Image.new("RGB", (480, 270), color)
    d = ImageDraw.Draw(im)
    d.rectangle([10, 10, 469, 259], outline=(255, 255, 255), width=4)
    d.text((30, 120), label, fill=(255, 255, 255))
    p = os.path.join(OUT, "testimg%d.png" % i)
    im.save(p)
    paths.append(p)
    print("已生成图片:", p, os.path.getsize(p), "字节")

# 2. 组装文档：正文 + 图 + 图题 + 表 + 附件
d = Document()
d.add_paragraph("关于加强宣传工作的通知").alignment = 1
d.add_paragraph("各部门：")
d.add_paragraph("为做好宣传工作，现将有关事项通知如下。")
d.add_paragraph("一、总体要求")
d.add_paragraph("坚持正确导向，突出主题主线。")
d.add_paragraph("二、重点任务")
d.add_paragraph("（一）做好主题宣传")
d.add_paragraph("围绕中心工作策划系列报道。")
d.add_picture(paths[0], width=Cm(10))
d.add_paragraph("图1  主题宣传示意图").alignment = 1
d.add_paragraph("同时要注重图文并茂，增强传播效果。")
d.add_picture(paths[1], width=Cm(8))
d.add_paragraph("图2  传播效果示意图").alignment = 1
d.add_paragraph("三、工作要求")
d.add_paragraph("各单位要抓好落实，确保取得实效。")
d.add_paragraph("附件：宣传工作安排表")

p = os.path.join(OUT, "with-images.docx")
d.save(p)
print("已生成:", p, os.path.getsize(p), "字节")

# 3. 打印内嵌媒体清单
import zipfile
z = zipfile.ZipFile(p)
print("内嵌媒体:", [n for n in z.namelist() if n.startswith("word/media/")])
