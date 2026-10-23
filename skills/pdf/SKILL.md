---
name: pdf
description: Read, extract, merge, split and generate PDF files. Use when the task involves a .pdf as input or output.
---
# PDF files

- **Extract text**: `pdftotext -layout file.pdf -` (poppler). For scanned pages run OCR first (`ocrmypdf in.pdf out.pdf`).
- **Metadata / page count**: `pdfinfo file.pdf`. **Images**: `pdfimages -list file.pdf`, `pdftoppm -r 150 -png file.pdf page` to render pages for visual inspection.
- **Merge / split / rotate**: `pypdf` (`pip install pypdf`): `PdfWriter().append(...)`, `writer.add_page(reader.pages[i])`, `page.rotate(90)`; or `qpdf --empty --pages a.pdf b.pdf -- out.pdf`.
- **Create**: write HTML or Markdown and convert (`pandoc in.md -o out.pdf`, or print HTML with Chrome `--headless --print-to-pdf`). Use `reportlab` only for programmatic layouts.
- **Fill forms**: inspect fields with `pypdf` (`reader.get_fields()`), update with `writer.update_page_form_field_values`.

Long PDFs: read page ranges (`pdftotext -f 3 -l 5`) instead of the whole file, and quote page numbers when citing.
