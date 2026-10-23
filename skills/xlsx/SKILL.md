---
name: xlsx
description: Create, read and edit spreadsheets (.xlsx, .csv). Use when the deliverable or input is a spreadsheet.
---
# Spreadsheets (.xlsx / .csv)

- **Read/analyse**: `pandas.read_excel(path, sheet_name=None)` returns every sheet; `read_csv` for CSV. Inspect `df.head()`, `df.dtypes`, and null counts before changing anything.
- **Write with formatting and formulas**: `openpyxl`. Write real formulas (`ws["D2"] = "=B2*C2"`) instead of pasted values so the sheet stays live; set header styles, column widths, number formats, `ws.freeze_panes = "A2"`, and `ws.auto_filter.ref = ws.dimensions`.
- **Editing an existing workbook**: `openpyxl.load_workbook(path)` (add `data_only=False` to keep formulas). Saving drops cached values, so recalculate with `soffice --headless --convert-to xlsx --outdir out/ file.xlsx` if values must be visible to non-Excel readers.
- **Charts**: `openpyxl.chart` (BarChart, LineChart) referencing cell ranges.

Never overwrite the original; save as a new file and report the sheet names and row counts you touched.
