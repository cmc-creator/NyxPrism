"""PDF merge utilities.

Supports:
* merge         – concatenate multiple PDFs into one
* interleave    – interleave pages from two PDFs (useful for double-sided scans)
* merge_bookmarked – merge with per-file top-level bookmarks
"""
from __future__ import annotations

from pathlib import Path

from pypdf import PdfReader, PdfWriter


def merge(
    sources: list[str | Path],
    output: str | Path,
) -> Path:
    """Concatenate *sources* into a single PDF at *output*.

    Parameters
    ----------
    sources:
        Ordered list of input PDF paths.
    output:
        Destination file path.

    Returns
    -------
    Path to the created file.
    """
    if not sources:
        raise ValueError("sources must not be empty")
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    writer = PdfWriter()
    for src in sources:
        reader = PdfReader(str(src))
        for page in reader.pages:
            writer.add_page(page)
    with open(output, "wb") as f:
        writer.write(f)
    return output


def merge_bookmarked(
    sources: list[str | Path],
    output: str | Path,
    labels: list[str] | None = None,
) -> Path:
    """Concatenate *sources* and add a top-level bookmark for each file.

    Parameters
    ----------
    sources:
        Ordered list of input PDF paths.
    output:
        Destination file path.
    labels:
        Optional list of bookmark labels, one per source.  Defaults to the
        stem of each source filename.

    Returns
    -------
    Path to the created file.
    """
    if not sources:
        raise ValueError("sources must not be empty")
    if labels is not None and len(labels) != len(sources):
        raise ValueError("labels must have the same length as sources")

    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    writer = PdfWriter()
    page_offset = 0

    for i, src in enumerate(sources):
        reader = PdfReader(str(src))
        label = labels[i] if labels else Path(src).stem
        bookmark_page = page_offset
        for page in reader.pages:
            writer.add_page(page)
        writer.add_outline_item(label, bookmark_page)
        page_offset += len(reader.pages)

    with open(output, "wb") as f:
        writer.write(f)
    return output


def interleave(
    odd_source: str | Path,
    even_source: str | Path,
    output: str | Path,
    reverse_even: bool = True,
) -> Path:
    """Interleave pages from two PDFs (double-sided scan helper).

    Parameters
    ----------
    odd_source:
        PDF containing odd-numbered pages (front sides).
    even_source:
        PDF containing even-numbered pages (back sides).
    output:
        Destination file path.
    reverse_even:
        When ``True`` (default) the even pages are read in reverse order, which
        is typical when you scan the back sides as a stack.

    Returns
    -------
    Path to the created file.
    """
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    odd_reader = PdfReader(str(odd_source))
    even_reader = PdfReader(str(even_source))
    writer = PdfWriter()

    even_pages = list(even_reader.pages)
    if reverse_even:
        even_pages = list(reversed(even_pages))

    for i, odd_page in enumerate(odd_reader.pages):
        writer.add_page(odd_page)
        if i < len(even_pages):
            writer.add_page(even_pages[i])

    with open(output, "wb") as f:
        writer.write(f)
    return output
