"""AI-powered bulk PDF splitter with automatic document naming.

This is the flagship feature of NyxPrism: given a multi-document PDF
(e.g. a scanned batch of invoices, contracts, or letters), it:

1. Extracts text from every page (with optional OCR fallback for scans).
2. Uses AI (or heuristics) to detect document boundaries.
3. Splits the PDF at those boundaries.
4. Names each output file descriptively using AI (or heuristics).

Quick usage example::

    from nyxprism.ai.splitter import bulk_split

    results = bulk_split(
        "batch_scan.pdf",
        output_dir="split_docs",
        strategy="auto",   # uses LLM if OPENAI_API_KEY is set
    )
    for path, label in results:
        print(f"{label:40s} → {path}")
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Literal

from nyxprism.ai.analyzer import detect_boundaries
from nyxprism.ai.namer import suggest_names_bulk
from nyxprism.core.extract import extract_text_by_page
from nyxprism.core.split import split_at_pages


def bulk_split(
    source: str | Path,
    output_dir: str | Path | None = None,
    strategy: Literal["llm", "heuristic", "auto"] = "auto",
    api_key: str | None = None,
    model: str = "gpt-4o-mini",
    ocr_fallback: bool = True,
    ocr_lang: str = "eng",
    ocr_dpi: int = 300,
    name_template: str = "{name}.pdf",
    progress: bool = True,
) -> list[tuple[Path, str]]:
    """Split *source* into individual documents using AI boundary detection.

    Parameters
    ----------
    source:
        Input PDF (typically a batch scan of multiple documents).
    output_dir:
        Directory for output files.  Defaults to a ``<stem>_split/``
        sub-directory beside the source file.
    strategy:
        Boundary / naming strategy: ``"llm"``, ``"heuristic"``, or ``"auto"``.
        *Auto* uses the LLM when an OpenAI API key is available and falls back
        to the heuristic approach otherwise.
    api_key:
        OpenAI API key (overrides ``OPENAI_API_KEY`` env var).
    model:
        OpenAI model to use for boundary detection and naming.
    ocr_fallback:
        When ``True``, pages that yield no selectable text are processed
        through Tesseract OCR before analysis.  Requires ``pytesseract`` and
        ``pypdfium2``.
    ocr_lang:
        Tesseract language code used when *ocr_fallback* is ``True``.
    ocr_dpi:
        Resolution used to render pages for OCR.
    name_template:
        Python format string for output filenames.  Keys: ``name`` (the
        AI-suggested name), ``n`` (1-based document index), ``start``
        (first page), ``end`` (last page).
    progress:
        Print a simple progress log to stdout.

    Returns
    -------
    List of ``(Path, label)`` tuples where *Path* is the output file and
    *label* is the suggested document name.
    """
    source = Path(source)
    if output_dir is None:
        output_dir = source.parent / f"{source.stem}_split"
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # Step 1: Extract text (with optional OCR fallback)
    # ------------------------------------------------------------------
    if progress:
        print(f"[NyxPrism] Extracting text from {source.name} …")

    page_texts = extract_text_by_page(source)

    if ocr_fallback:
        page_texts = _apply_ocr_fallback(
            source, page_texts, lang=ocr_lang, dpi=ocr_dpi, progress=progress
        )

    # ------------------------------------------------------------------
    # Step 2: Detect document boundaries
    # ------------------------------------------------------------------
    if progress:
        print(f"[NyxPrism] Detecting document boundaries (strategy={strategy}) …")

    boundaries = detect_boundaries(
        page_texts,
        strategy=strategy,
        api_key=api_key,
        model=model,
    )

    if progress:
        print(f"[NyxPrism] Found {len(boundaries)} document(s) at pages: {boundaries}")

    # ------------------------------------------------------------------
    # Step 3: Build page ranges
    # ------------------------------------------------------------------
    total_pages = len(page_texts)
    ranges = _boundaries_to_ranges(boundaries, total_pages)

    # ------------------------------------------------------------------
    # Step 4: Suggest names
    # ------------------------------------------------------------------
    if progress:
        print("[NyxPrism] Generating document names …")

    representative_texts = [
        "\n".join(page_texts[start - 1 : min(start + 1, end)])  # first 2 pages
        for start, end in ranges
    ]

    names = suggest_names_bulk(
        representative_texts,
        strategy=strategy,
        api_key=api_key,
        model=model,
    )

    # ------------------------------------------------------------------
    # Step 5: Split and rename
    # ------------------------------------------------------------------
    if progress:
        print("[NyxPrism] Splitting PDF …")

    results: list[tuple[Path, str]] = []
    for n, ((start, end), name) in enumerate(zip(ranges, names), start=1):
        out_filename = name_template.format(
            name=name, n=n, start=start, end=end
        )
        # Ensure unique filenames
        out_path = output_dir / out_filename
        if out_path.exists():
            stem = out_path.stem
            out_path = output_dir / f"{stem}_{n}{out_path.suffix}"

        _write_range(source, start, end, out_path)
        results.append((out_path, name))
        if progress:
            print(f"  [{n}/{len(ranges)}] Pages {start}–{end} → {out_path.name}")

    if progress:
        print(f"[NyxPrism] Done. {len(results)} document(s) written to {output_dir}")

    return results


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _apply_ocr_fallback(
    source: Path,
    page_texts: list[str],
    lang: str,
    dpi: int,
    progress: bool,
) -> list[str]:
    """Replace empty pages in *page_texts* with OCR results."""
    empty_pages = [i + 1 for i, t in enumerate(page_texts) if not t.strip()]
    if not empty_pages:
        return page_texts

    if progress:
        print(f"[NyxPrism] Running OCR on {len(empty_pages)} blank page(s) …")

    try:
        from nyxprism.core.ocr import ocr_page
    except ImportError:
        return page_texts

    updated = list(page_texts)
    for pg in empty_pages:
        try:
            updated[pg - 1] = ocr_page(source, pg, lang=lang, dpi=dpi)
        except Exception:
            pass  # leave blank on failure
    return updated


def _boundaries_to_ranges(boundaries: list[int], total: int) -> list[tuple[int, int]]:
    """Convert boundary list to (start, end) pairs."""
    pts = sorted(set(boundaries))
    pts.append(total + 1)
    return [(pts[i], pts[i + 1] - 1) for i in range(len(pts) - 1)]


def _write_range(source: Path, start: int, end: int, output: Path) -> None:
    """Write pages *start*–*end* (1-based, inclusive) of *source* to *output*."""
    from pypdf import PdfReader, PdfWriter

    reader = PdfReader(str(source))
    writer = PdfWriter()
    for pg in range(start - 1, end):
        writer.add_page(reader.pages[pg])
    with open(output, "wb") as f:
        writer.write(f)
