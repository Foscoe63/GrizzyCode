---
name: pptx
description: Build or edit PowerPoint (.pptx) presentations. Use when the user asks for slides or a deck as a file.
---
# PowerPoint decks (.pptx)

Use `python-pptx` (`pip install python-pptx`).

1. Start from `Presentation()` (or the user's template so theme and layouts carry over). Pick layouts by name: `prs.slide_layouts`.
2. One idea per slide: a short title, at most ~5 bullets, or one chart/image. Put detail in `slide.notes_slide.notes_text_frame.text`.
3. Charts: `slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, x, y, cx, cy, chart_data)` keeps them editable. Images: `add_picture` with explicit width to keep aspect ratio.
4. Save to a new filename, then render to check layout: `soffice --headless --convert-to pdf deck.pptx` and `pdftoppm -r 80 -png deck.pdf s`; look for overflowing text.

Keep fonts and sizes consistent (titles 32–40 pt, body 18–24 pt) and avoid walls of text.
