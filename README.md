# NyxPrism

**Powerful AI-enhanced PDF multi-tool** — split, merge, compress, convert, OCR, watermark, protect, and AI bulk-split with auto-rename.

NyxPrism is a Python library and CLI that covers everything you'd expect from a professional PDF suite (Adobe Acrobat, ABBYY FineReader, WPS PDF) — and adds AI-powered batch document splitting and automatic naming on top.

---

## Features

| Category | Capabilities |
|---|---|
| **AI Bulk Split** | Auto-detect document boundaries in a multi-document PDF; auto-rename each output file descriptively using LLM or heuristics |
| **Split** | By page range, every N pages, at explicit boundaries, by file-size limit |
| **Merge** | Concatenate PDFs, add bookmarks per file, interleave (double-sided scan) |
| **Compress** | FlateDecode stream compression + image JPEG re-encoding |
| **Pages** | Rotate, reorder, delete individual pages |
| **Extract** | Text extraction (selectable PDFs), embedded image extraction, PDF → images |
| **Convert** | Images → PDF, PDF → raster images (PNG/JPEG) |
| **OCR** | Tesseract-based OCR for scanned/image PDFs with automatic page fallback |
| **Watermark** | Text and image watermarks with configurable opacity and rotation |
| **Protect** | Password-protect (encrypt) and unlock PDFs |

---

## Installation

```bash
pip install nyxprism
```

**Optional OCR support** (requires [Tesseract](https://github.com/tesseract-ocr/tesseract) installed on your system):

```bash
sudo apt install tesseract-ocr          # Debian/Ubuntu
brew install tesseract                   # macOS
```

**Optional AI split** (requires an OpenAI API key):

```bash
export OPENAI_API_KEY="sk-..."
```

Without an API key the tool automatically falls back to the built-in heuristic engine — no key required.

---

## Quick start

### AI bulk split (flagship feature)

```bash
# Split a scanned batch PDF into individual named documents
nyxprism ai-split batch_scan.pdf --output-dir split_docs/

# With explicit LLM strategy
nyxprism ai-split batch_scan.pdf --strategy llm --model gpt-4o --output-dir split_docs/

# Force heuristic (no API key needed)
nyxprism ai-split batch_scan.pdf --strategy heuristic --output-dir split_docs/
```

Output example:
```
[NyxPrism] Extracting text from batch_scan.pdf …
[NyxPrism] Detecting document boundaries (strategy=auto) …
[NyxPrism] Found 4 document(s) at pages: [1, 6, 11, 18]
[NyxPrism] Generating document names …
[NyxPrism] Splitting PDF …
  [1/4] Pages 1–5   → invoice_2024-01-15.pdf
  [2/4] Pages 6–10  → contract_service_agreement.pdf
  [3/4] Pages 11–17 → quarterly_report_Q1_2024.pdf
  [4/4] Pages 18–22 → Dear_Alice_letter.pdf
[NyxPrism] Done. 4 document(s) written to split_docs/
```

### Split

```bash
# Split every 5 pages
nyxprism split doc.pdf --every 5 --output-dir pages/

# Split at explicit page ranges
nyxprism split doc.pdf --ranges "1-5,6-10,11-20"

# Split at page boundaries
nyxprism split doc.pdf --at-pages "5,10,15"

# Split so each file is ≤ 2 MB
nyxprism split doc.pdf --max-size 2097152
```

### Merge

```bash
nyxprism merge a.pdf b.pdf c.pdf --output merged.pdf

# With bookmarks
nyxprism merge a.pdf b.pdf --output merged.pdf --bookmarks

# Interleave odd/even pages (double-sided scan)
nyxprism interleave odd_pages.pdf even_pages.pdf --output complete.pdf
```

### Compress

```bash
nyxprism compress big.pdf --output small.pdf --quality 65
```

### Rotate / reorder / delete pages

```bash
nyxprism rotate doc.pdf --degrees 90 --pages 1,3,5
nyxprism reorder doc.pdf "3,1,2,4"
nyxprism delete-pages doc.pdf "2,4"
```

### Watermark

```bash
nyxprism watermark doc.pdf --text "CONFIDENTIAL" --opacity 0.3 --angle 45
nyxprism watermark doc.pdf --image logo.png --opacity 0.2
```

### Password protection

```bash
nyxprism protect doc.pdf --password "s3cret"
nyxprism unlock protected.pdf --password "s3cret"
```

### Text extraction & OCR

```bash
nyxprism extract-text doc.pdf
nyxprism extract-text doc.pdf --pages 1,2,5 --output text.txt

# OCR for scanned PDFs
nyxprism ocr scan.pdf --lang eng --output ocr_text.txt
nyxprism ocr scan.pdf --lang deu+eng --dpi 400
```

### PDF ↔ images

```bash
# PDF → images
nyxprism to-images doc.pdf --dpi 200 --format png --output-dir pages/

# Images → PDF
nyxprism from-images page1.png page2.png page3.png --output combined.pdf
```

---

## Python API

```python
from nyxprism.ai.splitter import bulk_split

# AI bulk split — works without an API key (heuristic mode)
results = bulk_split(
    "batch_scan.pdf",
    output_dir="split_docs/",
    strategy="auto",          # "llm" | "heuristic" | "auto"
    ocr_fallback=True,        # OCR pages with no selectable text
)
for path, label in results:
    print(f"{label:40s} → {path}")
```

```python
from nyxprism.core.split import split_every_n, split_by_range, split_at_pages
from nyxprism.core.merge import merge, merge_bookmarked, interleave
from nyxprism.core.compress import compress
from nyxprism.core.pages import rotate_pages, reorder_pages, delete_pages
from nyxprism.core.extract import extract_text, pdf_to_images, images_to_pdf
from nyxprism.core.protect import protect, unlock
from nyxprism.core.watermark import add_text_watermark, add_image_watermark
from nyxprism.core.ocr import ocr_pdf
```

---

## AI strategies explained

| Strategy | Requires API key | Accuracy | Speed |
|---|---|---|---|
| `llm` | ✅ Yes | ⭐⭐⭐⭐⭐ | Moderate (API call) |
| `heuristic` | ❌ No | ⭐⭐⭐ | ⚡ Instant |
| `auto` | Optional | Best available | Best available |

The `auto` strategy automatically selects LLM when `OPENAI_API_KEY` is set and falls back to heuristics otherwise.

---

## Architecture

```
nyxprism/
├── core/
│   ├── split.py       # PDF splitting (range, size, boundaries)
│   ├── merge.py       # PDF merging and interleaving
│   ├── compress.py    # Compression
│   ├── pages.py       # Rotate, reorder, delete pages
│   ├── extract.py     # Text/image extraction, PDF↔images
│   ├── protect.py     # Password protection / unlock
│   ├── watermark.py   # Text and image watermarks
│   └── ocr.py         # Tesseract OCR wrapper
├── ai/
│   ├── analyzer.py    # Document boundary detection (LLM + heuristic)
│   ├── namer.py       # AI-powered auto-naming (LLM + heuristic)
│   └── splitter.py    # Bulk split pipeline (orchestrates everything)
└── cli/
    └── main.py        # Click-based CLI
```

---

## License

MIT
