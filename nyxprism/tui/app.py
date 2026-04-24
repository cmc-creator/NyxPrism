"""NyxPrism TUI — easy-button terminal interface.

Launch with:
    nyxprism-ui
    python -m nyxprism.tui.app
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Callable

from textual import work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Grid, ScrollableContainer, Vertical
from textual.screen import ModalScreen, Screen
from textual.widgets import Button, Footer, Header, Input, Label, RichLog, Select, Static

# ─────────────────────────────────────────────────────────────────────────────
#  Command catalogue
# ─────────────────────────────────────────────────────────────────────────────

COMMANDS: dict[str, dict] = {
    "ai-split": {
        "label": "🤖  AI Split",
        "desc": "Detect document boundaries & split batch scans into named files",
        "category": "ai",
        "fields": [
            {"id": "source",     "label": "PDF File",
             "type": "input",  "ph": "/path/to/batch.pdf"},
            {"id": "output_dir", "label": "Output Folder  (leave blank for auto)",
             "type": "input",  "ph": ""},
            {"id": "batch_dir",  "label": "Batch Folder  (optional — process ALL PDFs in folder, ignores PDF File above)",
             "type": "input",  "ph": ""},
            {"id": "strategy",   "label": "Strategy",
             "type": "select",
             "opts": [("Auto – LLM when key available  (recommended)", "auto"),
                      ("Heuristic – fully offline, instant",           "heuristic"),
                      ("LLM – requires OPENAI_API_KEY env var",        "llm")],
             "default": "auto"},
        ],
    },
    "ai-summarize": {
        "label": "📝  AI Summarize",
        "desc": "Get a concise summary of any PDF document",
        "category": "ai",
        "fields": [
            {"id": "source",   "label": "PDF File",
             "type": "input",  "ph": "/path/to/doc.pdf"},
            {"id": "strategy", "label": "Strategy",
             "type": "select",
             "opts": [("Auto  (recommended)", "auto"),
                      ("Heuristic – offline",  "heuristic"),
                      ("LLM – OpenAI",         "llm")],
             "default": "auto"},
            {"id": "output",   "label": "Save to file  (leave blank to display here)",
             "type": "input",  "ph": ""},
        ],
    },
    "ai-classify": {
        "label": "🏷️  AI Classify",
        "desc": "Detect document type: invoice, contract, report, letter…",
        "category": "ai",
        "fields": [
            {"id": "source",   "label": "PDF File",
             "type": "input",  "ph": "/path/to/doc.pdf"},
            {"id": "strategy", "label": "Strategy",
             "type": "select",
             "opts": [("Auto  (recommended)", "auto"),
                      ("Heuristic – offline",  "heuristic"),
                      ("LLM – OpenAI",         "llm")],
             "default": "auto"},
        ],
    },
    "ai-extract": {
        "label": "🔍  AI Extract Info",
        "desc": "Pull dates, amounts, parties & reference numbers as JSON",
        "category": "ai",
        "fields": [
            {"id": "source",   "label": "PDF File",
             "type": "input",  "ph": "/path/to/doc.pdf"},
            {"id": "strategy", "label": "Strategy",
             "type": "select",
             "opts": [("Auto  (recommended)", "auto"),
                      ("Heuristic – offline",  "heuristic"),
                      ("LLM – OpenAI",         "llm")],
             "default": "auto"},
            {"id": "output",   "label": "Save JSON  (leave blank to display here)",
             "type": "input",  "ph": ""},
        ],
    },
    "ai-rename": {
        "label": "✏️  AI Rename",
        "desc": "Give PDFs descriptive names based on their content",
        "category": "ai",
        "fields": [
            {"id": "folder",   "label": "Folder with PDFs",
             "type": "input",  "ph": "/path/to/pdfs/"},
            {"id": "dry_run",  "label": "Mode",
             "type": "select",
             "opts": [("Preview only – don't rename yet  (safe default)", "yes"),
                      ("Apply – rename files now",                         "no")],
             "default": "yes"},
            {"id": "strategy", "label": "Strategy",
             "type": "select",
             "opts": [("Auto  (recommended)", "auto"),
                      ("Heuristic – offline",  "heuristic"),
                      ("LLM – OpenAI",         "llm")],
             "default": "auto"},
        ],
    },
    "split": {
        "label": "✂️  Split PDF",
        "desc": "Split a PDF into parts by pages, ranges, or file size",
        "category": "core",
        "fields": [
            {"id": "source",     "label": "PDF File",
             "type": "input",  "ph": "/path/to/doc.pdf"},
            {"id": "output_dir", "label": "Output Folder  (leave blank for auto)",
             "type": "input",  "ph": ""},
            {"id": "mode",       "label": "Split Mode",
             "type": "select",
             "opts": [("Every N pages",                  "every"),
                      ("Page ranges  e.g. 1-5,6-10",    "ranges"),
                      ("At page numbers  e.g. 5,10,15", "at"),
                      ("Max file size  (bytes)",         "size")],
             "default": "every"},
            {"id": "value", "label": "Value  (N pages / ranges / page numbers / bytes)",
             "type": "input",  "ph": "e.g.  5"},
        ],
    },
    "merge": {
        "label": "🔗  Merge PDFs",
        "desc": "Combine multiple PDFs into one file",
        "category": "core",
        "fields": [
            {"id": "sources", "label": "PDF Files  (comma-separated or one per line)",
             "type": "input",  "ph": "/path/a.pdf, /path/b.pdf"},
            {"id": "output",  "label": "Output File",
             "type": "input",  "ph": "/path/merged.pdf"},
        ],
    },
    "compress": {
        "label": "📦  Compress",
        "desc": "Reduce PDF file size by compressing streams and images",
        "category": "core",
        "fields": [
            {"id": "source",  "label": "PDF File",
             "type": "input",  "ph": "/path/to/big.pdf"},
            {"id": "output",  "label": "Output File  (leave blank for auto)",
             "type": "input",  "ph": ""},
            {"id": "quality", "label": "Image Quality  1–95  (0 = skip image recompression)",
             "type": "input",  "ph": "75"},
        ],
    },
    "watermark": {
        "label": "💧  Watermark",
        "desc": "Stamp text onto every page of a PDF",
        "category": "core",
        "fields": [
            {"id": "source",  "label": "PDF File",
             "type": "input",  "ph": "/path/to/doc.pdf"},
            {"id": "text",    "label": "Watermark Text",
             "type": "input",  "ph": "CONFIDENTIAL"},
            {"id": "output",  "label": "Output File  (leave blank for auto)",
             "type": "input",  "ph": ""},
            {"id": "opacity", "label": "Opacity  (0.0 – 1.0)",
             "type": "input",  "ph": "0.3"},
            {"id": "angle",   "label": "Angle  (degrees)",
             "type": "input",  "ph": "45"},
        ],
    },
    "protect": {
        "label": "🔒  Protect",
        "desc": "Encrypt a PDF with a password",
        "category": "core",
        "fields": [
            {"id": "source",   "label": "PDF File",
             "type": "input",    "ph": "/path/to/doc.pdf"},
            {"id": "password",  "label": "Password",
             "type": "password", "ph": ""},
            {"id": "output",   "label": "Output File  (leave blank for auto)",
             "type": "input",    "ph": ""},
        ],
    },
    "unlock": {
        "label": "🔓  Unlock PDF",
        "desc": "Remove password protection from a PDF",
        "category": "core",
        "fields": [
            {"id": "source",   "label": "PDF File",
             "type": "input",    "ph": "/path/to/locked.pdf"},
            {"id": "password",  "label": "Password",
             "type": "password", "ph": ""},
            {"id": "output",   "label": "Output File  (leave blank for auto)",
             "type": "input",    "ph": ""},
        ],
    },
    "extract-text": {
        "label": "📄  Extract Text",
        "desc": "Copy the selectable text layer from a PDF",
        "category": "convert",
        "fields": [
            {"id": "source", "label": "PDF File",
             "type": "input",  "ph": "/path/to/doc.pdf"},
            {"id": "pages",  "label": "Pages  (e.g. 1,2,5 — leave blank for all)",
             "type": "input",  "ph": ""},
            {"id": "output", "label": "Save to file  (leave blank to display here)",
             "type": "input",  "ph": ""},
        ],
    },
    "ocr": {
        "label": "👁️  OCR Scan",
        "desc": "Extract text from scanned image-only PDFs via Tesseract",
        "category": "convert",
        "fields": [
            {"id": "source", "label": "PDF File",
             "type": "input",  "ph": "/path/to/scan.pdf"},
            {"id": "output", "label": "Save to file  (leave blank to display here)",
             "type": "input",  "ph": ""},
            {"id": "lang",   "label": "Language",
             "type": "select",
             "opts": [("English",           "eng"),
                      ("French",            "fra"),
                      ("German",            "deu"),
                      ("Spanish",           "spa"),
                      ("English + French",  "eng+fra")],
             "default": "eng"},
        ],
    },
    "to-images": {
        "label": "🖼️  PDF → Images",
        "desc": "Render each page as a PNG or JPEG file",
        "category": "convert",
        "fields": [
            {"id": "source",     "label": "PDF File",
             "type": "input",  "ph": "/path/to/doc.pdf"},
            {"id": "output_dir", "label": "Output Folder  (leave blank for auto)",
             "type": "input",  "ph": ""},
            {"id": "dpi",        "label": "DPI  (higher = better quality, larger files)",
             "type": "input",  "ph": "150"},
            {"id": "fmt",        "label": "Format",
             "type": "select",
             "opts": [("PNG  (lossless)", "png"), ("JPEG  (smaller)", "jpeg")],
             "default": "png"},
        ],
    },
    "from-images": {
        "label": "📑  Images → PDF",
        "desc": "Combine image files into a single PDF",
        "category": "convert",
        "fields": [
            {"id": "images", "label": "Image Files  (comma-separated or one per line)",
             "type": "input",  "ph": "/path/page1.png, /path/page2.png"},
            {"id": "output", "label": "Output PDF",
             "type": "input",  "ph": "/path/output.pdf"},
        ],
    },
}

CATEGORY_ORDER = [
    ("ai",      "🤖  AI Tools",  ["ai-split", "ai-summarize", "ai-classify", "ai-extract", "ai-rename"]),
    ("core",    "⚙️  Process",   ["split", "merge", "compress", "watermark", "protect", "unlock"]),
    ("convert", "🔄  Convert",   ["extract-text", "ocr", "to-images", "from-images"]),
]

# ─────────────────────────────────────────────────────────────────────────────
#  CSS
# ─────────────────────────────────────────────────────────────────────────────

APP_CSS = """
App {
    background: #07090f;
}

Header {
    background: #0d1117;
    color: #a78bfa;
}

Footer {
    background: #0d1117;
    color: #5a6a80;
}

#home-scroll {
    background: #07090f;
    padding: 1 2;
}

.cat-label {
    background: #111827;
    border: tall #2d3f57;
    color: #a78bfa;
    text-style: bold;
    text-align: center;
    padding: 0 1;
    margin: 1 0 0 0;
    height: 3;
}

.btn-grid {
    grid-size: 2;
    grid-gutter: 0 1;
    margin-bottom: 0;
    height: auto;
}

.cmd-btn {
    background: #0d1117;
    border: tall #2d3f57;
    color: #c4cdd8;
    width: 1fr;
    height: 3;
    margin-bottom: 1;
}

.cmd-btn:hover {
    background: #1a2235;
    color: #a78bfa;
    border: tall #7c3aed;
}

.ai-btn {
    background: #120a2e;
    border: tall #3b1f6b;
    color: #c4b5fd;
}

.ai-btn:hover {
    background: #1f1040;
    border: tall #7c3aed;
    color: #a78bfa;
}

/* ── Modal ── */

ModalScreen {
    align: center middle;
    background: rgba(7, 9, 15, 0.88);
}

#modal-outer {
    background: #111827;
    border: tall #7c3aed;
    width: 76;
    height: auto;
    padding: 1 2 1 2;
}

#modal-title {
    text-style: bold;
    color: #a78bfa;
    text-align: center;
    height: 2;
}

#modal-desc {
    color: #5a6a80;
    text-align: center;
    height: 2;
    margin-bottom: 1;
}

#modal-form {
    height: auto;
    overflow-y: auto;
    max-height: 24;
}

.field-label {
    color: #7a8da6;
    margin-top: 1;
    height: 1;
}

Input {
    background: #0d1117;
    border: tall #2d3f57;
    color: #e8edf5;
    height: 3;
}

Input:focus {
    border: tall #7c3aed;
}

Select {
    background: #0d1117;
    border: tall #2d3f57;
    color: #e8edf5;
}

#run-btn {
    background: #7c3aed;
    color: #ffffff;
    text-style: bold;
    width: 100%;
    margin-top: 1;
    height: 3;
}

#run-btn:hover {
    background: #6d28d9;
}

#run-btn:disabled {
    background: #2d1b54;
    color: #4a3a6e;
}

#output-log {
    background: #040810;
    border: tall #1f2d42;
    height: 14;
    margin-top: 1;
}

#close-btn {
    background: #1a2235;
    color: #7a8da6;
    margin-top: 1;
    width: 100%;
    height: 3;
}

#close-btn:hover {
    background: #2d3f57;
    color: #c4cdd8;
}
"""


# ─────────────────────────────────────────────────────────────────────────────
#  Command modal
# ─────────────────────────────────────────────────────────────────────────────

class CommandModal(ModalScreen):
    """Interactive form + output panel for a single NyxPrism command."""

    BINDINGS = [Binding("escape", "dismiss", "Close")]

    def __init__(self, cmd_id: str) -> None:
        super().__init__()
        self.cmd_id = cmd_id
        self.cfg = COMMANDS[cmd_id]

    def compose(self) -> ComposeResult:
        cfg = self.cfg
        with Vertical(id="modal-outer"):
            yield Static(cfg["label"], id="modal-title")
            yield Static(cfg["desc"], id="modal-desc")
            with ScrollableContainer(id="modal-form"):
                for field in cfg["fields"]:
                    yield Label(field["label"], classes="field-label")
                    fid = f"f-{field['id']}"
                    if field["type"] == "select":
                        opts = field["opts"]
                        default = field.get("default", opts[0][1])
                        yield Select(
                            [(lbl, val) for lbl, val in opts],
                            value=default,
                            id=fid,
                        )
                    elif field["type"] == "password":
                        yield Input(placeholder=field.get("ph", ""),
                                    password=True, id=fid)
                    else:
                        yield Input(placeholder=field.get("ph", ""), id=fid)
            yield Button("▶   Run", id="run-btn", variant="primary")
            yield RichLog(id="output-log", highlight=True, markup=True, wrap=True)
            yield Button("✕   Close", id="close-btn")

    # ── event handlers ──────────────────────────────────────────────────────

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "run-btn":
            self._execute()
        elif event.button.id == "close-btn":
            self.dismiss()

    # ── helpers ─────────────────────────────────────────────────────────────

    def _get_values(self) -> dict[str, str]:
        vals: dict[str, str] = {}
        for field in self.cfg["fields"]:
            fid = f"f-{field['id']}"
            if field["type"] == "select":
                widget = self.query_one(f"#{fid}", Select)
                v = widget.value
                vals[field["id"]] = (
                    field.get("default", "") if v is Select.BLANK else str(v)
                )
            else:
                vals[field["id"]] = self.query_one(f"#{fid}", Input).value.strip()
        return vals

    def _execute(self) -> None:
        vals = self._get_values()
        log_widget = self.query_one("#output-log", RichLog)
        run_btn = self.query_one("#run-btn", Button)
        log_widget.clear()
        run_btn.disabled = True

        # Build thread-safe log/done callables on the main thread
        def log(msg: str) -> None:
            self.call_from_thread(log_widget.write, msg)

        def done() -> None:
            self.call_from_thread(self._enable_run)

        self._run_command(vals, log, done)

    def _enable_run(self) -> None:
        self.query_one("#run-btn", Button).disabled = False

    # ── background worker ───────────────────────────────────────────────────

    @work(thread=True)
    def _run_command(
        self,
        vals: dict[str, str],
        log: Callable[[str], None],
        done: Callable[[], None],
    ) -> None:
        try:
            method_name = f"_{self.cmd_id.replace('-', '_')}"
            getattr(self, method_name)(vals, log)
        except Exception as exc:  # noqa: BLE001
            log(f"[bold red]Error:[/bold red] {exc}")
        finally:
            done()

    # ── command runners ─────────────────────────────────────────────────────

    def _ai_split(self, v: dict, log: Callable) -> None:
        from nyxprism.ai.splitter import bulk_split

        source = v.get("source", "").strip()
        batch_dir = v.get("batch_dir", "").strip()
        output_dir = v.get("output_dir", "").strip() or None
        strategy = v.get("strategy", "auto")

        if not source and not batch_dir:
            log("[yellow]⚠  Enter a PDF file path or a batch folder path.[/yellow]")
            return

        kwargs = dict(strategy=strategy, ocr_fallback=True, progress=False)

        if batch_dir:
            pdfs = sorted(Path(batch_dir).glob("*.pdf"))
            if not pdfs:
                log(f"[yellow]No PDFs found in:[/yellow] {batch_dir}")
                return
            log(f"[cyan]Found {len(pdfs)} PDF(s). Processing batch…[/cyan]\n")
            total = 0
            for pdf in pdfs:
                log(f"[cyan bold]{pdf.name}[/cyan bold]")
                per_out = (Path(output_dir) / pdf.stem) if output_dir else None
                results = bulk_split(source=pdf, output_dir=per_out, **kwargs)
                for path, label in results:
                    log(f"  [green]✔[/green] {label}  →  [dim]{path}[/dim]")
                total += len(results)
            log(f"\n[green bold]✅ Done — {total} doc(s) from {len(pdfs)} file(s).[/green bold]")
        else:
            if not Path(source).is_file():
                log(f"[red]File not found:[/red] {source}")
                return
            log(f"[cyan]Processing:[/cyan] [bold]{Path(source).name}[/bold]…")
            results = bulk_split(source=source, output_dir=output_dir, **kwargs)
            for path, label in results:
                log(f"  [green]✔[/green] {label}  →  [dim]{path}[/dim]")
            log(f"\n[green bold]✅ Split into {len(results)} document(s).[/green bold]")

    def _ai_summarize(self, v: dict, log: Callable) -> None:
        from nyxprism.ai.summarizer import summarize_text
        from nyxprism.core.extract import extract_text

        source = v.get("source", "").strip()
        if not source or not Path(source).is_file():
            log("[red]File not found.[/red]")
            return
        log("[cyan]Extracting text…[/cyan]")
        text = extract_text(source)
        log("[cyan]Summarizing…[/cyan]\n")
        summary = summarize_text(text, strategy=v.get("strategy", "auto"))
        output = v.get("output", "").strip()
        if output:
            Path(output).write_text(summary, encoding="utf-8")
            log(f"[green bold]✅ Summary saved to:[/green bold] {output}")
        else:
            log(summary)
            log("\n[green bold]✅ Done.[/green bold]")

    def _ai_classify(self, v: dict, log: Callable) -> None:
        from nyxprism.ai.summarizer import classify_document
        from nyxprism.core.extract import extract_text

        source = v.get("source", "").strip()
        if not source or not Path(source).is_file():
            log("[red]File not found.[/red]")
            return
        log("[cyan]Extracting text…[/cyan]")
        text = extract_text(source)
        log("[cyan]Classifying…[/cyan]")
        doc_type = classify_document(text, strategy=v.get("strategy", "auto"))
        log(f"\n[green bold]✅ Document type:[/green bold]  [bold white]{doc_type}[/bold white]")

    def _ai_extract(self, v: dict, log: Callable) -> None:
        from nyxprism.ai.summarizer import extract_key_info
        from nyxprism.core.extract import extract_text

        source = v.get("source", "").strip()
        if not source or not Path(source).is_file():
            log("[red]File not found.[/red]")
            return
        log("[cyan]Extracting text…[/cyan]")
        text = extract_text(source)
        log("[cyan]Analyzing…[/cyan]\n")
        info = extract_key_info(text, strategy=v.get("strategy", "auto"))
        json_str = json.dumps(info, indent=2, ensure_ascii=False)
        output = v.get("output", "").strip()
        if output:
            Path(output).write_text(json_str, encoding="utf-8")
            log(f"[green bold]✅ JSON saved to:[/green bold] {output}")
        else:
            log(json_str)
            log("\n[green bold]✅ Done.[/green bold]")

    def _ai_rename(self, v: dict, log: Callable) -> None:
        from nyxprism.ai.namer import suggest_filename
        from nyxprism.core.extract import extract_text

        folder = v.get("folder", "").strip()
        dry_run = v.get("dry_run", "yes") == "yes"
        strategy = v.get("strategy", "auto")

        if not folder or not Path(folder).is_dir():
            log("[red]Folder not found.[/red]")
            return
        pdfs = sorted(Path(folder).glob("*.pdf"))
        if not pdfs:
            log("[yellow]No PDFs found in that folder.[/yellow]")
            return

        action = "[yellow]Preview[/yellow]" if dry_run else "[green]Renaming[/green]"
        log(f"{action} {len(pdfs)} PDF(s)…\n")
        for pdf in pdfs:
            try:
                text = extract_text(str(pdf))[:2000]
                new_name = suggest_filename(text, strategy=strategy)
                if dry_run:
                    log(f"  [dim]{pdf.name}[/dim]  →  [bold]{new_name}[/bold]")
                else:
                    pdf.rename(pdf.parent / new_name)
                    log(f"  [green]✔[/green]  {pdf.name}  →  [bold]{new_name}[/bold]")
            except Exception as exc:  # noqa: BLE001
                log(f"  [yellow]⚠  {pdf.name}:[/yellow] {exc}")

        if dry_run:
            log("\n[dim italic]Dry run — no files changed. Switch Mode to 'Apply' to rename.[/dim italic]")
        log("\n[green bold]✅ Done.[/green bold]")

    def _split(self, v: dict, log: Callable) -> None:
        from nyxprism.core.split import (
            split_at_pages, split_by_range, split_by_size, split_every_n,
        )

        source = v.get("source", "").strip()
        if not source or not Path(source).is_file():
            log("[red]File not found.[/red]")
            return
        mode = v.get("mode", "every")
        value = v.get("value", "").strip()
        out_dir = v.get("output_dir", "").strip() or None

        log(f"[cyan]Splitting:[/cyan] [bold]{Path(source).name}[/bold]…")
        if mode == "every":
            n = int(value) if value else 1
            created = split_every_n(source, n, output_dir=out_dir)
        elif mode == "ranges":
            ranges: list[tuple[int, int]] = []
            for part in value.split(","):
                part = part.strip()
                if "-" in part:
                    a, b = part.split("-", 1)
                    ranges.append((int(a.strip()), int(b.strip())))
                elif part:
                    ranges.append((int(part), int(part)))
            created = split_by_range(source, ranges, output_dir=out_dir)
        elif mode == "at":
            pages = [int(p.strip()) for p in value.split(",") if p.strip()]
            created = split_at_pages(source, pages, output_dir=out_dir)
        else:
            created = split_by_size(source, int(value), output_dir=out_dir)

        for p in created:
            log(f"  [green]✔[/green] [dim]{p}[/dim]")
        log(f"\n[green bold]✅ Created {len(created)} file(s).[/green bold]")

    def _merge(self, v: dict, log: Callable) -> None:
        from nyxprism.core.merge import merge as _merge

        sources_raw = v.get("sources", "").strip()
        output = v.get("output", "").strip()
        if not sources_raw or not output:
            log("[yellow]⚠  Enter source files and an output path.[/yellow]")
            return
        sources = [s.strip() for s in sources_raw.replace("\n", ",").split(",") if s.strip()]
        missing = [s for s in sources if not Path(s).is_file()]
        if missing:
            for m in missing:
                log(f"[red]File not found:[/red] {m}")
            return
        log(f"[cyan]Merging {len(sources)} file(s)…[/cyan]")
        out = _merge(sources, output)
        log(f"\n[green bold]✅ Merged into:[/green bold] {out}")

    def _compress(self, v: dict, log: Callable) -> None:
        from nyxprism.core.compress import compress as _compress

        source = v.get("source", "").strip()
        if not source or not Path(source).is_file():
            log("[red]File not found.[/red]")
            return
        output = v.get("output", "").strip() or None
        quality = int(v.get("quality", "75") or "75")
        log(f"[cyan]Compressing:[/cyan] [bold]{Path(source).name}[/bold]…")
        out = _compress(source, output=output, image_quality=quality)
        orig = Path(source).stat().st_size
        comp = out.stat().st_size
        ratio = comp / orig * 100
        log(f"\n[green bold]✅ Done:[/green bold] {out}")
        log(f"   [cyan]{orig:,}[/cyan] → [green]{comp:,}[/green] bytes  ({ratio:.1f}%)")

    def _watermark(self, v: dict, log: Callable) -> None:
        from nyxprism.core.watermark import add_text_watermark

        source = v.get("source", "").strip()
        if not source or not Path(source).is_file():
            log("[red]File not found.[/red]")
            return
        text = v.get("text", "").strip()
        if not text:
            log("[yellow]⚠  Enter watermark text.[/yellow]")
            return
        output = v.get("output", "").strip() or None
        opacity = float(v.get("opacity", "0.3") or "0.3")
        angle = float(v.get("angle", "45") or "45")
        log(f"[cyan]Watermarking:[/cyan] [bold]{Path(source).name}[/bold]…")
        out = add_text_watermark(source, text, output=output, opacity=opacity, angle=angle)
        log(f"\n[green bold]✅ Watermarked:[/green bold] {out}")

    def _protect(self, v: dict, log: Callable) -> None:
        from nyxprism.core.protect import protect as _protect

        source = v.get("source", "").strip()
        if not source or not Path(source).is_file():
            log("[red]File not found.[/red]")
            return
        password = v.get("password", "").strip()
        if not password:
            log("[yellow]⚠  Enter a password.[/yellow]")
            return
        output = v.get("output", "").strip() or None
        log(f"[cyan]Encrypting:[/cyan] [bold]{Path(source).name}[/bold]…")
        out = _protect(source, user_password=password, output=output)
        log(f"\n[green bold]✅ Protected:[/green bold] {out}")

    def _unlock(self, v: dict, log: Callable) -> None:
        from nyxprism.core.protect import unlock as _unlock

        source = v.get("source", "").strip()
        if not source or not Path(source).is_file():
            log("[red]File not found.[/red]")
            return
        password = v.get("password", "").strip()
        output = v.get("output", "").strip() or None
        log(f"[cyan]Unlocking:[/cyan] [bold]{Path(source).name}[/bold]…")
        out = _unlock(source, password=password, output=output)
        log(f"\n[green bold]✅ Unlocked:[/green bold] {out}")

    def _extract_text(self, v: dict, log: Callable) -> None:
        from nyxprism.core.extract import extract_text

        source = v.get("source", "").strip()
        if not source or not Path(source).is_file():
            log("[red]File not found.[/red]")
            return
        pages_str = v.get("pages", "").strip()
        page_list = [int(p.strip()) for p in pages_str.split(",") if p.strip()] or None
        log(f"[cyan]Extracting text from:[/cyan] [bold]{Path(source).name}[/bold]…\n")
        text = extract_text(source, page_numbers=page_list)
        output = v.get("output", "").strip()
        if output:
            Path(output).write_text(text, encoding="utf-8")
            log(f"[green bold]✅ Saved to:[/green bold] {output}")
        else:
            preview = text[:2000]
            if len(text) > 2000:
                preview += "\n[dim]… (truncated — use 'Save to file' for the full text)[/dim]"
            log(preview)
            log("\n[green bold]✅ Done.[/green bold]")

    def _ocr(self, v: dict, log: Callable) -> None:
        from nyxprism.core.ocr import ocr_pdf

        source = v.get("source", "").strip()
        if not source or not Path(source).is_file():
            log("[red]File not found.[/red]")
            return
        lang = v.get("lang", "eng")
        output = v.get("output", "").strip() or None
        log(f"[cyan]Running OCR on:[/cyan] [bold]{Path(source).name}[/bold]…")
        log("[dim italic](this may take a moment for large documents)[/dim italic]\n")
        text = ocr_pdf(source, output_text=output, lang=lang)
        if output:
            log(f"[green bold]✅ OCR text saved to:[/green bold] {output}")
        else:
            preview = (text or "")[:2000]
            if text and len(text) > 2000:
                preview += "\n[dim]… (truncated — use 'Save to file' for the full text)[/dim]"
            log(preview)
            log("\n[green bold]✅ Done.[/green bold]")

    def _to_images(self, v: dict, log: Callable) -> None:
        from nyxprism.core.extract import pdf_to_images

        source = v.get("source", "").strip()
        if not source or not Path(source).is_file():
            log("[red]File not found.[/red]")
            return
        out_dir = v.get("output_dir", "").strip() or None
        dpi = int(v.get("dpi", "150") or "150")
        fmt = v.get("fmt", "png") or "png"
        log(f"[cyan]Rendering:[/cyan] [bold]{Path(source).name}[/bold] at {dpi} DPI as {fmt.upper()}…")
        created = pdf_to_images(source, output_dir=out_dir, dpi=dpi, fmt=fmt)
        for p in created:
            log(f"  [green]✔[/green] [dim]{p}[/dim]")
        log(f"\n[green bold]✅ Created {len(created)} image(s).[/green bold]")

    def _from_images(self, v: dict, log: Callable) -> None:
        from nyxprism.core.extract import images_to_pdf

        images_raw = v.get("images", "").strip()
        output = v.get("output", "").strip()
        if not images_raw or not output:
            log("[yellow]⚠  Enter image files and an output path.[/yellow]")
            return
        images = [i.strip() for i in images_raw.replace("\n", ",").split(",") if i.strip()]
        log(f"[cyan]Combining {len(images)} image(s) into PDF…[/cyan]")
        out = images_to_pdf(images, output)
        log(f"\n[green bold]✅ Created:[/green bold] {out}")


# ─────────────────────────────────────────────────────────────────────────────
#  Home screen
# ─────────────────────────────────────────────────────────────────────────────

class HomeScreen(Screen):
    BINDINGS = [
        Binding("q", "quit", "Quit"),
        Binding("ctrl+c", "quit", "Quit"),
    ]

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        with ScrollableContainer(id="home-scroll"):
            for _cat_id, cat_label, cmd_ids in CATEGORY_ORDER:
                yield Static(cat_label, classes="cat-label")
                with Grid(classes="btn-grid"):
                    for cmd_id in cmd_ids:
                        cfg = COMMANDS[cmd_id]
                        is_ai = cfg["category"] == "ai"
                        classes = "cmd-btn ai-btn" if is_ai else "cmd-btn"
                        yield Button(cfg["label"], id=f"btn-{cmd_id}", classes=classes)
        yield Footer()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        btn_id = event.button.id or ""
        if btn_id.startswith("btn-"):
            cmd_id = btn_id[4:]
            if cmd_id in COMMANDS:
                self.app.push_screen(CommandModal(cmd_id))

    def action_quit(self) -> None:
        self.app.exit()


# ─────────────────────────────────────────────────────────────────────────────
#  Application
# ─────────────────────────────────────────────────────────────────────────────

class NyxPrismTUI(App):
    TITLE = "NyxPrism™  ·  by NyxCollective LLC"
    SUB_TITLE = "AI-Enhanced PDF Multi-Tool  |  q to quit  |  Esc to close dialog"
    CSS = APP_CSS
    BINDINGS = [Binding("q", "quit", "Quit")]

    def on_mount(self) -> None:
        self.push_screen(HomeScreen())


# ─────────────────────────────────────────────────────────────────────────────
#  Entry point
# ─────────────────────────────────────────────────────────────────────────────

def launch() -> None:
    """Launch the NyxPrism TUI. Entry point for `nyxprism-ui`."""
    app = NyxPrismTUI()
    app.run()


if __name__ == "__main__":
    launch()
