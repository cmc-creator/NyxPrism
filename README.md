# NyxPrism

<p align="center">
  <a href="https://cmc-creator.github.io/NyxPrism/"><strong>🌐 Website / App Page</strong></a> ·
  <a href="https://pypi.org/project/nyxprism/">PyPI</a> ·
  <a href="https://github.com/cmc-creator/NyxPrism/issues">Issues</a>
</p>

<p align="center">
  <a href="https://cmc-creator.github.io/NyxPrism/">
    <img src="https://img.shields.io/badge/App%20Page-NyxPrism-7c3aed?style=for-the-badge&logo=github" alt="App Page" />
  </a>
  <a href="https://pypi.org/project/nyxprism/">
    <img src="https://img.shields.io/pypi/v/nyxprism?style=for-the-badge&color=7c3aed" alt="PyPI" />
  </a>
  <a href="https://pypi.org/project/nyxprism/">
    <img src="https://img.shields.io/pypi/pyversions/nyxprism?style=for-the-badge" alt="Python" />
  </a>
  <img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="MIT" />
</p>

**Powerful AI-enhanced PDF multi-tool** — split, merge, compress, convert, OCR, watermark, protect, and AI bulk-split with auto-rename, summarize, classify, and structured data extraction.

NyxPrism is a Python library and CLI covering everything you would expect from a professional PDF suite — plus an AI layer that automates the tedious parts: detecting document boundaries in batch scans, renaming files descriptively, summarizing content, and pulling out key data.

---

## Features

| Category | Capabilities |
|---|---|
| **AI Bulk Split** | Auto-detect document boundaries; auto-rename each output descriptively (LLM or heuristics) |
| **AI Rename** | Batch-rename one or many PDFs with AI-suggested names; ``--dry-run`` preview |
| **AI Summarize** | Generate concise summaries of any PDF (specific pages or whole document) |
| **AI Classify** | Detect document type: invoice, contract, report, letter, resume, and more |
| **AI Key Info** | Extract dates, amounts, parties, reference numbers as structured JSON |
| **Split** | By page range, every N pages, at explicit boundaries, by file-size limit |
| **Merge** | Concatenate PDFs, add bookmarks per file, interleave (double-sided scan) |
| **Compress** | FlateDecode stream compression + image JPEG re-encoding |
| **Pages** | Rotate, reorder, delete individual pages |
| **Extract** | Text extraction, embedded image extraction, PDF to images |
| **Convert** | Images to PDF, PDF to raster images (PNG/JPEG) |
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

**Optional AI features** (requires an OpenAI API key):

```bash
export OPENAI_API_KEY="sk-..."
```

Without an API key every AI command automatically falls back to the built-in heuristic engine — no key required.

---

## Quick Start

### AI bulk split (flagship feature)

```bash
# Split a scanned batch PDF into individual named documents
nyxprism ai-split batch_scan.pdf --output-dir split_docs/

# Process an entire folder of PDFs at once
nyxprism ai-split --batch-dir ./inbox/ --output-dir ./split/

# Force LLM strategy (best accuracy, requires API key)
nyxprism ai-split batch_scan.pdf --strategy llm --model gpt-4o --output-dir split_docs/

# Force heuristic (no API key needed)
nyxprism ai-split batch_scan.pdf --strategy heuristic --output-dir split_docs/
```

Output example:
```
[NyxPrism] Extracting text from batch_scan.pdf ...
[NyxPrism] Detecting document boundaries (strategy=auto) ...
[NyxPrism] Found 4 document(s) at pages: [1, 6, 11, 18]
[NyxPrism] Generating document names ...
[NyxPrism] Splitting PDF ...
  [1/4] Pages 1-5   -> invoice_2024-01-15.pdf
  [2/4] Pages 6-10  -> contract_service_agreement.pdf
  [3/4] Pages 11-17 -> quarterly_report_Q1_2024.pdf
  [4/4] Pages 18-22 -> letter_Dear_Alice.pdf
[NyxPrism] Done. 4 document(s) written to split_docs/
```

### AI rename

```bash
# Preview AI-suggested names (no files changed)
nyxprism ai-rename *.pdf --dry-run

# Rename for real
nyxprism ai-rename scan001.pdf scan002.pdf scan003.pdf

# Add a year prefix to every name
nyxprism ai-rename *.pdf --prefix "2024_"
```

### AI summarize

```bash
nyxprism ai-summarize report.pdf
nyxprism ai-summarize report.pdf --pages 1,2,3 --output summary.txt
nyxprism ai-summarize report.pdf --strategy heuristic --sentences 3
```

### AI classify

```bash
nyxprism ai-classify invoice.pdf
# -> Document type: invoice
```

### AI extract key info

```bash
nyxprism ai-extract-info contract.pdf
# -> {
#     "document_type": "contract",
#     "date": "2024-03-15",
#     "parties": "Acme Corp, Widget Ltd",
#     "subject": "Software Development Services Agreement",
#     "reference_number": "CTR-2024-0042",
#     "amount": "$45,000",
#     "summary": "..."
#   }
```

### Split

```bash
nyxprism split doc.pdf --every 5 --output-dir pages/
nyxprism split doc.pdf --ranges "1-5,6-10,11-20"
nyxprism split doc.pdf --at-pages "5,10,15"
nyxprism split doc.pdf --max-size 2097152
```

### Merge

```bash
nyxprism merge a.pdf b.pdf c.pdf --output merged.pdf
nyxprism merge a.pdf b.pdf --output merged.pdf --bookmarks
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
nyxprism ocr scan.pdf --lang eng --output ocr_text.txt
nyxprism ocr scan.pdf --lang deu+eng --dpi 400
```

### PDF to / from images

```bash
nyxprism to-images doc.pdf --dpi 200 --format png --output-dir pages/
nyxprism from-images page1.png page2.png page3.png --output combined.pdf
```

---

## Python API

```python
from nyxprism.ai.splitter import bulk_split
from nyxprism.ai.summarizer import summarize_text, classify_document, extract_key_info
from nyxprism.ai.namer import suggest_names_bulk
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

## AI Strategies

| Strategy | Requires API key | Accuracy | Speed |
|---|---|---|---|
| `llm` | Yes | 5/5 | Moderate (API call) |
| `heuristic` | No | 3/5 | Instant |
| `auto` (default) | Optional | Best available | Best available |

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
│   ├── extract.py     # Text/image extraction, PDF<->images
│   ├── protect.py     # Password protection / unlock
│   ├── watermark.py   # Text and image watermarks
│   └── ocr.py         # Tesseract OCR wrapper
├── ai/
│   ├── analyzer.py    # Document boundary detection (LLM + heuristic)
│   ├── namer.py       # AI-powered auto-naming (LLM + heuristic)
│   ├── summarizer.py  # Summarization, classification, key-info extraction
│   └── splitter.py    # Bulk split pipeline (orchestrates everything)
└── cli/
    └── main.py        # Click-based CLI (all commands)
```

---

## License

MIT
