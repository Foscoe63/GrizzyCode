---
name: docx
description: Create, read and edit Word (.docx) documents. Use when the user wants a Word file produced or an existing .docx inspected or changed.
---
# Word documents (.docx)

A .docx is a zip of XML. Prefer these tools, in order:

1. **Reading**: `pandoc file.docx -t markdown` (keeps headings, lists, tables). Fall back to `python3 -c "import docx; ..."`.
2. **Creating**: `python-docx` (`pip install python-docx`) for structured output, or write Markdown and run `pandoc in.md -o out.docx` for quick, well-formed documents.
3. **Editing in place**: load with `docx.Document(path)`, change paragraphs/runs/tables, `save()` to a new filename. Edit runs rather than whole paragraphs to keep formatting.

Checklist before handing back: use real heading styles (not bold text), keep one blank-line-free paragraph per paragraph, set table header rows, and re-open the saved file to confirm it loads. Convert to PDF with `soffice --headless --convert-to pdf file.docx` if a visual check is needed. Never overwrite the user's original; write `name-edited.docx`.
