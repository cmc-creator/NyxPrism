"""NyxPrism command-line interface.

Usage examples::

    # AI bulk-split a scanned batch PDF
    nyxprism ai-split batch.pdf --output-dir split_docs/

    # Split into individual pages
    nyxprism split batch.pdf --every 1 --output-dir pages/

    # Split by explicit page ranges
    nyxprism split batch.pdf --ranges "1-5,6-10" --output-dir out/

    # Merge multiple PDFs
    nyxprism merge a.pdf b.pdf c.pdf --output merged.pdf

    # Compress a PDF
    nyxprism compress big.pdf --output small.pdf --quality 65

    # Rotate pages
    nyxprism rotate doc.pdf --degrees 90 --pages 1,3,5

    # Add text watermark
    nyxprism watermark doc.pdf --text "CONFIDENTIAL"

    # Password protect
    nyxprism protect doc.pdf --password "s3cret"

    # Extract text
    nyxprism extract-text doc.pdf

    # Convert PDF to images
    nyxprism to-images doc.pdf --dpi 200 --format png

    # Convert images to PDF
    nyxprism from-images page1.png page2.png --output out.pdf

    # OCR a scanned PDF
    nyxprism ocr scan.pdf --lang eng

    # Show version
    nyxprism --version
"""
from __future__ import annotations

import sys
from pathlib import Path

import click

from nyxprism import __version__


@click.group()
@click.version_option(__version__, prog_name="NyxPrism")
def cli() -> None:
    """NyxPrism – Powerful AI-enhanced PDF multi-tool."""


# ---------------------------------------------------------------------------
# ai-split
# ---------------------------------------------------------------------------

@cli.command("ai-split")
@click.argument("source", type=click.Path(exists=True), required=False, default=None)
@click.option("--output-dir", "-o", default=None,
              help="Directory for output files (default: <source>_split/)")
@click.option("--strategy", "-s",
              type=click.Choice(["auto", "llm", "heuristic"]), default="auto",
              show_default=True,
              help="Boundary detection strategy.")
@click.option("--api-key", default=None, envvar="OPENAI_API_KEY",
              help="OpenAI API key (overrides OPENAI_API_KEY env var).")
@click.option("--model", default="gpt-4o-mini", show_default=True,
              help="OpenAI model for boundary detection and naming.")
@click.option("--no-ocr", is_flag=True, default=False,
              help="Disable OCR fallback for scanned/image pages.")
@click.option("--ocr-lang", default="eng", show_default=True,
              help="Tesseract language code for OCR (e.g. eng, fra, deu+eng).")
@click.option("--ocr-dpi", default=300, show_default=True,
              help="DPI used to render pages for OCR.")
@click.option("--quiet", "-q", is_flag=True, default=False,
              help="Suppress progress output.")
@click.option("--batch-dir", "-b", default=None,
              type=click.Path(exists=True, file_okay=False),
              help="Process ALL PDFs in this directory (ignores SOURCE).")
def ai_split(source, output_dir, strategy, api_key, model, no_ocr, ocr_lang, ocr_dpi,
             quiet, batch_dir):
    """Bulk-split SOURCE using AI-detected document boundaries.

    SOURCE must be a multi-document PDF (several concatenated documents).
    Each detected sub-document is written as a separate, descriptively-named
    PDF in OUTPUT_DIR.

    Use --batch-dir to process every PDF in a folder at once:

    \b
        nyxprism ai-split --batch-dir ./inbox/ --output-dir ./split/
    """
    from nyxprism.ai.splitter import bulk_split

    common_kwargs = dict(
        strategy=strategy,
        api_key=api_key,
        model=model,
        ocr_fallback=not no_ocr,
        ocr_lang=ocr_lang,
        ocr_dpi=ocr_dpi,
        progress=not quiet,
    )

    # ------------------------------------------------------------------
    # Batch-directory mode
    # ------------------------------------------------------------------
    if batch_dir:
        pdf_files = sorted(Path(batch_dir).glob("*.pdf"))
        if not pdf_files:
            click.echo(f"No PDF files found in {batch_dir}", err=True)
            sys.exit(1)
        total_docs = 0
        for pdf in pdf_files:
            per_output = (Path(output_dir) / pdf.stem) if output_dir else None
            if not quiet:
                click.echo(f"\n[NyxPrism] Processing {pdf.name} …")
            try:
                results = bulk_split(source=pdf, output_dir=per_output, **common_kwargs)
                total_docs += len(results)
                for path, label in results:
                    click.echo(f"  {label:50s} {path}")
            except Exception as exc:
                click.echo(f"  Error processing {pdf.name}: {exc}", err=True)
        if not quiet:
            click.echo(f"\nBatch complete. {total_docs} document(s) extracted from "
                       f"{len(pdf_files)} file(s).")
        return

    # ------------------------------------------------------------------
    # Single-file mode
    # ------------------------------------------------------------------
    if not source:
        click.echo("Error: provide SOURCE or --batch-dir.", err=True)
        sys.exit(1)
    if not Path(source).is_file():
        click.echo(f"Error: {source!r} is not a file.", err=True)
        sys.exit(1)

    try:
        results = bulk_split(source=source, output_dir=output_dir, **common_kwargs)
        if not quiet:
            click.echo(f"\nSplit into {len(results)} document(s):")
        for path, label in results:
            click.echo(f"  {label:50s} {path}")
    except Exception as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)


# ---------------------------------------------------------------------------
# split
# ---------------------------------------------------------------------------

@cli.command("split")
@click.argument("source", type=click.Path(exists=True, dir_okay=False))
@click.option("--output-dir", "-o", default=None,
              help="Directory for output files.")
@click.option("--every", "-n", type=int, default=None,
              help="Split into chunks of N pages.")
@click.option("--ranges", "-r", default=None,
              help='Comma-separated page ranges, e.g. "1-5,6-10,11-20".')
@click.option("--at-pages", "-p", default=None,
              help='Comma-separated page numbers where new sections begin, e.g. "5,10,15".')
@click.option("--max-size", "-m", type=int, default=None,
              help="Split so each output file is at most N bytes.")
def split(source, output_dir, every, ranges, at_pages, max_size):
    """Split a PDF file.

    Exactly one splitting strategy must be specified:
    --every, --ranges, --at-pages, or --max-size.
    """
    from nyxprism.core.split import (
        split_at_pages,
        split_by_range,
        split_by_size,
        split_every_n,
    )

    modes = [every, ranges, at_pages, max_size]
    if sum(m is not None for m in modes) != 1:
        click.echo("Error: specify exactly one of --every, --ranges, --at-pages, --max-size", err=True)
        sys.exit(1)

    try:
        if every is not None:
            created = split_every_n(source, every, output_dir=output_dir)
        elif ranges is not None:
            parsed = _parse_ranges(ranges)
            created = split_by_range(source, parsed, output_dir=output_dir)
        elif at_pages is not None:
            boundaries = [int(p.strip()) for p in at_pages.split(",") if p.strip()]
            created = split_at_pages(source, boundaries, output_dir=output_dir)
        else:  # max_size
            created = split_by_size(source, max_size, output_dir=output_dir)

        click.echo(f"Created {len(created)} file(s):")
        for p in created:
            click.echo(f"  {p}")
    except Exception as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)


def _parse_ranges(ranges_str: str) -> list[tuple[int, int]]:
    result: list[tuple[int, int]] = []
    for part in ranges_str.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            start_s, end_s = part.split("-", 1)
            result.append((int(start_s.strip()), int(end_s.strip())))
        else:
            n = int(part)
            result.append((n, n))
    return result


# ---------------------------------------------------------------------------
# merge
# ---------------------------------------------------------------------------

@cli.command("merge")
@click.argument("sources", nargs=-1, required=True,
                type=click.Path(exists=True, dir_okay=False))
@click.option("--output", "-o", required=True,
              help="Output PDF path.")
@click.option("--bookmarks/--no-bookmarks", default=False,
              help="Add a top-level bookmark for each source file.")
def merge(sources, output, bookmarks):
    """Merge multiple PDF files into one."""
    from nyxprism.core.merge import merge as _merge
    from nyxprism.core.merge import merge_bookmarked

    try:
        if bookmarks:
            path = merge_bookmarked(list(sources), output)
        else:
            path = _merge(list(sources), output)
        click.echo(f"Merged into: {path}")
    except Exception as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)


# ---------------------------------------------------------------------------
# compress
# ---------------------------------------------------------------------------

@cli.command("compress")
@click.argument("source", type=click.Path(exists=True, dir_okay=False))
@click.option("--output", "-o", default=None, help="Output path.")
@click.option("--quality", "-q", type=int, default=75, show_default=True,
              help="JPEG re-encoding quality (1-95). 0 skips image recompression.")
def compress(source, output, quality):
    """Compress a PDF file."""
    from nyxprism.core.compress import compress as _compress

    try:
        out = _compress(source, output=output, image_quality=quality)
        original = Path(source).stat().st_size
        compressed = out.stat().st_size
        ratio = compressed / original * 100
        click.echo(f"Compressed: {out}")
        click.echo(f"Size: {original:,} → {compressed:,} bytes ({ratio:.1f}%)")
    except Exception as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)


# ---------------------------------------------------------------------------
# rotate
# ---------------------------------------------------------------------------

@cli.command("rotate")
@click.argument("source", type=click.Path(exists=True, dir_okay=False))
@click.option("--output", "-o", default=None, help="Output path.")
@click.option("--degrees", "-d", type=int, default=90, show_default=True,
              help="Clockwise rotation (90, 180, or 270).")
@click.option("--pages", "-p", default=None,
              help="Comma-separated 1-based page numbers to rotate (default: all).")
def rotate(source, output, degrees, pages):
    """Rotate pages in a PDF."""
    from nyxprism.core.pages import rotate_pages

    page_list = None
    if pages:
        page_list = [int(p.strip()) for p in pages.split(",") if p.strip()]
    try:
        out = rotate_pages(source, output=output, degrees=degrees, page_numbers=page_list)
        click.echo(f"Rotated: {out}")
    except Exception as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)


# ---------------------------------------------------------------------------
# reorder
# ---------------------------------------------------------------------------

@cli.command("reorder")
@click.argument("source", type=click.Path(exists=True, dir_okay=False))
@click.argument("order")  # e.g. "3,1,2,4"
@click.option("--output", "-o", default=None, help="Output path.")
def reorder(source, order, output):
    """Reorder pages in a PDF.

    ORDER is a comma-separated list of 1-based page numbers in the desired
    output order (pages may be repeated or omitted).

    Example: nyxprism reorder doc.pdf "3,1,2,4"
    """
    from nyxprism.core.pages import reorder_pages

    order_list = [int(p.strip()) for p in order.split(",") if p.strip()]
    try:
        out = reorder_pages(source, order_list, output=output)
        click.echo(f"Reordered: {out}")
    except Exception as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)


# ---------------------------------------------------------------------------
# delete-pages
# ---------------------------------------------------------------------------

@cli.command("delete-pages")
@click.argument("source", type=click.Path(exists=True, dir_okay=False))
@click.argument("pages")  # e.g. "2,4,7"
@click.option("--output", "-o", default=None, help="Output path.")
def delete_pages(source, pages, output):
    """Delete specific pages from a PDF.

    PAGES is a comma-separated list of 1-based page numbers to remove.
    """
    from nyxprism.core.pages import delete_pages as _delete_pages

    page_list = [int(p.strip()) for p in pages.split(",") if p.strip()]
    try:
        out = _delete_pages(source, page_list, output=output)
        click.echo(f"Pages deleted: {out}")
    except Exception as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)


# ---------------------------------------------------------------------------
# watermark
# ---------------------------------------------------------------------------

@cli.command("watermark")
@click.argument("source", type=click.Path(exists=True, dir_okay=False))
@click.option("--text", "-t", default=None, help="Watermark text.")
@click.option("--image", "-i", default=None, type=click.Path(exists=True),
              help="Watermark image path.")
@click.option("--output", "-o", default=None, help="Output path.")
@click.option("--opacity", default=0.3, show_default=True,
              help="Opacity (0.0–1.0).")
@click.option("--angle", default=45.0, show_default=True,
              help="Rotation angle for text watermark.")
def watermark(source, text, image, output, opacity, angle):
    """Add a text or image watermark to every page of a PDF."""
    from nyxprism.core.watermark import add_image_watermark, add_text_watermark

    if not text and not image:
        click.echo("Error: specify --text or --image", err=True)
        sys.exit(1)
    try:
        if text:
            out = add_text_watermark(source, text, output=output,
                                      opacity=opacity, angle=angle)
        else:
            out = add_image_watermark(source, image, output=output,
                                       opacity=opacity)
        click.echo(f"Watermarked: {out}")
    except Exception as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)


# ---------------------------------------------------------------------------
# protect / unlock
# ---------------------------------------------------------------------------

@cli.command("protect")
@click.argument("source", type=click.Path(exists=True, dir_okay=False))
@click.option("--password", "-p", required=True, help="User password.")
@click.option("--owner-password", default=None,
              help="Owner password (defaults to user password).")
@click.option("--output", "-o", default=None, help="Output path.")
def protect(source, password, owner_password, output):
    """Password-protect a PDF."""
    from nyxprism.core.protect import protect as _protect

    try:
        out = _protect(source, user_password=password,
                       owner_password=owner_password, output=output)
        click.echo(f"Protected: {out}")
    except Exception as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)


@cli.command("unlock")
@click.argument("source", type=click.Path(exists=True, dir_okay=False))
@click.option("--password", "-p", required=True, help="Password to decrypt.")
@click.option("--output", "-o", default=None, help="Output path.")
def unlock(source, password, output):
    """Remove password protection from a PDF."""
    from nyxprism.core.protect import unlock as _unlock

    try:
        out = _unlock(source, password=password, output=output)
        click.echo(f"Unlocked: {out}")
    except Exception as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)


# ---------------------------------------------------------------------------
# extract-text
# ---------------------------------------------------------------------------

@cli.command("extract-text")
@click.argument("source", type=click.Path(exists=True, dir_okay=False))
@click.option("--output", "-o", default=None,
              help="Save text to file (prints to stdout if not specified).")
@click.option("--pages", "-p", default=None,
              help="Comma-separated 1-based page numbers (default: all).")
def extract_text(source, output, pages):
    """Extract text from a PDF."""
    from nyxprism.core.extract import extract_text as _extract_text

    page_list = None
    if pages:
        page_list = [int(p.strip()) for p in pages.split(",") if p.strip()]
    try:
        text = _extract_text(source, page_numbers=page_list)
        if output:
            Path(output).write_text(text, encoding="utf-8")
            click.echo(f"Text saved to: {output}")
        else:
            click.echo(text)
    except Exception as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)


# ---------------------------------------------------------------------------
# to-images
# ---------------------------------------------------------------------------

@cli.command("to-images")
@click.argument("source", type=click.Path(exists=True, dir_okay=False))
@click.option("--output-dir", "-o", default=None,
              help="Directory for output images.")
@click.option("--dpi", default=150, show_default=True, help="Rendering DPI.")
@click.option("--format", "fmt", default="png", show_default=True,
              type=click.Choice(["png", "jpeg"]),
              help="Output image format.")
def to_images(source, output_dir, dpi, fmt):
    """Render each page of a PDF as a raster image."""
    from nyxprism.core.extract import pdf_to_images

    try:
        created = pdf_to_images(source, output_dir=output_dir, dpi=dpi, fmt=fmt)
        click.echo(f"Created {len(created)} image(s):")
        for p in created:
            click.echo(f"  {p}")
    except Exception as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)


# ---------------------------------------------------------------------------
# from-images
# ---------------------------------------------------------------------------

@cli.command("from-images")
@click.argument("images", nargs=-1, required=True,
                type=click.Path(exists=True, dir_okay=False))
@click.option("--output", "-o", required=True, help="Output PDF path.")
def from_images(images, output):
    """Combine images into a single PDF."""
    from nyxprism.core.extract import images_to_pdf

    try:
        out = images_to_pdf(list(images), output)
        click.echo(f"Created: {out}")
    except Exception as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)


# ---------------------------------------------------------------------------
# ocr
# ---------------------------------------------------------------------------

@cli.command("ocr")
@click.argument("source", type=click.Path(exists=True, dir_okay=False))
@click.option("--output", "-o", default=None,
              help="Save OCR text to file (prints to stdout if not specified).")
@click.option("--lang", default="eng", show_default=True,
              help="Tesseract language code (e.g. eng, fra, deu+eng).")
@click.option("--dpi", default=300, show_default=True,
              help="Rendering DPI.")
@click.option("--pages", "-p", default=None,
              help="Comma-separated 1-based page numbers (default: all).")
def ocr(source, output, lang, dpi, pages):
    """OCR a scanned PDF and extract text."""
    from nyxprism.core.ocr import ocr_pdf

    page_list = None
    if pages:
        page_list = [int(p.strip()) for p in pages.split(",") if p.strip()]
    try:
        text = ocr_pdf(source, output_text=output, lang=lang, dpi=dpi,
                       page_numbers=page_list)
        if not output:
            click.echo(text)
        else:
            click.echo(f"OCR text saved to: {output}")
    except Exception as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)


# ---------------------------------------------------------------------------
# interleave
# ---------------------------------------------------------------------------

@cli.command("interleave")
@click.argument("odd_source", type=click.Path(exists=True, dir_okay=False))
@click.argument("even_source", type=click.Path(exists=True, dir_okay=False))
@click.option("--output", "-o", required=True, help="Output PDF path.")
@click.option("--no-reverse", is_flag=True, default=False,
              help="Do not reverse even pages (use when back sides are scanned in order).")
def interleave(odd_source, even_source, output, no_reverse):
    """Interleave two PDFs (odd/even pages from a double-sided scan)."""
    from nyxprism.core.merge import interleave as _interleave

    try:
        out = _interleave(odd_source, even_source, output,
                          reverse_even=not no_reverse)
        click.echo(f"Interleaved: {out}")
    except Exception as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)


# ---------------------------------------------------------------------------
# ai-summarize
# ---------------------------------------------------------------------------

@cli.command("ai-summarize")
@click.argument("source", type=click.Path(exists=True, dir_okay=False))
@click.option("--output", "-o", default=None,
              help="Save summary to file (prints to stdout if not specified).")
@click.option("--strategy", "-s",
              type=click.Choice(["auto", "llm", "heuristic"]), default="auto",
              show_default=True)
@click.option("--api-key", default=None, envvar="OPENAI_API_KEY")
@click.option("--model", default="gpt-4o-mini", show_default=True)
@click.option("--pages", "-p", default=None,
              help="Comma-separated 1-based page numbers to summarise (default: all).")
@click.option("--sentences", type=int, default=5, show_default=True,
              help="Target sentences for heuristic summary.")
def ai_summarize(source, output, strategy, api_key, model, pages, sentences):
    """Summarize a PDF using AI or extractive heuristics.

    Works without an API key (heuristic mode). Set OPENAI_API_KEY for
    higher-quality LLM summaries.
    """
    from nyxprism.ai.summarizer import summarize_text
    from nyxprism.core.extract import extract_text as _extract_text

    page_list = None
    if pages:
        page_list = [int(p.strip()) for p in pages.split(",") if p.strip()]
    try:
        text = _extract_text(source, page_numbers=page_list)
        summary = summarize_text(
            text,
            strategy=strategy,
            api_key=api_key,
            model=model,
            sentences=sentences,
        )
        if output:
            Path(output).write_text(summary, encoding="utf-8")
            click.echo(f"Summary saved to: {output}")
        else:
            click.echo(summary)
    except Exception as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)


# ---------------------------------------------------------------------------
# ai-classify
# ---------------------------------------------------------------------------

@cli.command("ai-classify")
@click.argument("source", type=click.Path(exists=True, dir_okay=False))
@click.option("--strategy", "-s",
              type=click.Choice(["auto", "llm", "heuristic"]), default="auto",
              show_default=True)
@click.option("--api-key", default=None, envvar="OPENAI_API_KEY")
@click.option("--model", default="gpt-4o-mini", show_default=True)
def ai_classify(source, strategy, api_key, model):
    """Classify the document type of a PDF (invoice, contract, report, etc.).

    Works without an API key (heuristic mode). Set OPENAI_API_KEY for
    higher-accuracy LLM classification.
    """
    from nyxprism.ai.summarizer import classify_document
    from nyxprism.core.extract import extract_text as _extract_text

    try:
        text = _extract_text(source)
        label = classify_document(
            text,
            strategy=strategy,
            api_key=api_key,
            model=model,
        )
        click.echo(f"Document type: {label}")
    except Exception as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)


# ---------------------------------------------------------------------------
# ai-extract-info
# ---------------------------------------------------------------------------

@cli.command("ai-extract-info")
@click.argument("source", type=click.Path(exists=True, dir_okay=False))
@click.option("--output", "-o", default=None,
              help="Save JSON output to file (prints to stdout if not specified).")
@click.option("--strategy", "-s",
              type=click.Choice(["auto", "llm", "heuristic"]), default="auto",
              show_default=True)
@click.option("--api-key", default=None, envvar="OPENAI_API_KEY")
@click.option("--model", default="gpt-4o-mini", show_default=True)
def ai_extract_info(source, output, strategy, api_key, model):
    """Extract structured key information from a PDF (dates, amounts, parties, etc.).

    Outputs a JSON object with fields: document_type, date, parties,
    subject, reference_number, amount, summary.
    """
    import json
    from nyxprism.ai.summarizer import extract_key_info
    from nyxprism.core.extract import extract_text as _extract_text

    try:
        text = _extract_text(source)
        info = extract_key_info(
            text,
            strategy=strategy,
            api_key=api_key,
            model=model,
        )
        json_str = json.dumps(info, indent=2, ensure_ascii=False)
        if output:
            Path(output).write_text(json_str, encoding="utf-8")
            click.echo(f"Info saved to: {output}")
        else:
            click.echo(json_str)
    except Exception as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)


# ---------------------------------------------------------------------------
# ai-rename
# ---------------------------------------------------------------------------

@cli.command("ai-rename")
@click.argument("sources", nargs=-1, required=True,
                type=click.Path(exists=True, dir_okay=False))
@click.option("--strategy", "-s",
              type=click.Choice(["auto", "llm", "heuristic"]), default="auto",
              show_default=True)
@click.option("--api-key", default=None, envvar="OPENAI_API_KEY")
@click.option("--model", default="gpt-4o-mini", show_default=True)
@click.option("--dry-run", is_flag=True, default=False,
              help="Preview new names without renaming files.")
@click.option("--prefix", default="", help="Optional prefix added to every new name.")
def ai_rename(sources, strategy, api_key, model, dry_run, prefix):
    """Rename one or more PDF files using AI-suggested descriptive names.

    Analyses each file's content and proposes a clean, descriptive filename.
    Use --dry-run to preview names before committing.

    Examples:

    \b
        nyxprism ai-rename scan001.pdf scan002.pdf
        nyxprism ai-rename *.pdf --strategy heuristic --dry-run
        nyxprism ai-rename invoice.pdf --prefix "2024_"
    """
    from nyxprism.ai.namer import suggest_names_bulk
    from nyxprism.core.extract import extract_text as _extract_text

    source_paths = [Path(s) for s in sources]
    texts: list[str] = []
    for sp in source_paths:
        try:
            texts.append(_extract_text(sp))
        except Exception:
            texts.append("")

    names = suggest_names_bulk(
        texts,
        strategy=strategy,
        api_key=api_key,
        model=model,
    )

    renamed = 0
    for sp, name in zip(source_paths, names):
        new_stem = f"{prefix}{name}" if prefix else name
        new_path = sp.parent / f"{new_stem}.pdf"

        # Avoid overwriting a different file
        if new_path.exists() and new_path != sp:
            base = new_path.stem
            suffix = 1
            while new_path.exists() and new_path != sp:
                new_path = sp.parent / f"{base}_{suffix}.pdf"
                suffix += 1

        action = "→" if not dry_run else "(dry-run) →"
        click.echo(f"  {sp.name:50s} {action} {new_path.name}")

        if not dry_run and new_path != sp:
            sp.rename(new_path)
            renamed += 1

    if not dry_run:
        click.echo(f"\nRenamed {renamed} of {len(source_paths)} file(s).")
    else:
        click.echo(f"\n{len(source_paths)} file(s) previewed (--dry-run, no changes made).")


if __name__ == "__main__":
    cli()
