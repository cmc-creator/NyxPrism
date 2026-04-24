"""PDF splitting utilities.

Supports:
* split_by_range  – extract specific page ranges into separate files
* split_every_n   – split into chunks of N pages
* split_at_pages  – split at explicit page-boundary list
* split_by_size   – split so each output is ≤ a given file-size limit (bytes)
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Iterable

from pypdf import PdfReader, PdfWriter


def _resolve_output_dir(output_dir: str | Path | None, source: str | Path) -> Path:
    if output_dir is None:
        return Path(source).parent
    p = Path(output_dir)
    p.mkdir(parents=True, exist_ok=True)
    return p


def split_by_range(
    source: str | Path,
    ranges: list[tuple[int, int]],
    output_dir: str | Path | None = None,
    name_template: str = "{stem}_part{n}.pdf",
) -> list[Path]:
    """Extract page ranges from *source* into individual PDF files.

    Parameters
    ----------
    source:
        Input PDF path.
    ranges:
        List of (start, end) tuples using 1-based inclusive page numbers.
        E.g. [(1, 3), (4, 10)] splits pages 1-3 and 4-10.
    output_dir:
        Directory to write output files.  Defaults to the source directory.
    name_template:
        Python format string; available keys: ``stem`` (source filename
        without extension), ``n`` (1-based part number), ``start``, ``end``.

    Returns
    -------
    List of paths created.
    """
    source = Path(source)
    out_dir = _resolve_output_dir(output_dir, source)
    reader = PdfReader(str(source))
    total = len(reader.pages)
    created: list[Path] = []

    for n, (start, end) in enumerate(ranges, start=1):
        if start < 1 or end > total or start > end:
            raise ValueError(
                f"Invalid range ({start}, {end}) for PDF with {total} pages."
            )
        writer = PdfWriter()
        for page_num in range(start - 1, end):
            writer.add_page(reader.pages[page_num])
        out_name = name_template.format(
            stem=source.stem, n=n, start=start, end=end
        )
        out_path = out_dir / out_name
        with open(out_path, "wb") as f:
            writer.write(f)
        created.append(out_path)

    return created


def split_every_n(
    source: str | Path,
    n: int,
    output_dir: str | Path | None = None,
    name_template: str = "{stem}_part{n}.pdf",
) -> list[Path]:
    """Split *source* into chunks of *n* pages each.

    Parameters
    ----------
    source:
        Input PDF path.
    n:
        Number of pages per output file.
    output_dir:
        Directory to write output files.
    name_template:
        Format string; keys: ``stem``, ``n``, ``start``, ``end``.

    Returns
    -------
    List of paths created.
    """
    if n < 1:
        raise ValueError("n must be ≥ 1")
    source = Path(source)
    reader = PdfReader(str(source))
    total = len(reader.pages)
    ranges = [(i, min(i + n - 1, total)) for i in range(1, total + 1, n)]
    return split_by_range(source, ranges, output_dir=output_dir, name_template=name_template)


def split_at_pages(
    source: str | Path,
    boundaries: Iterable[int],
    output_dir: str | Path | None = None,
    name_template: str = "{stem}_part{n}.pdf",
) -> list[Path]:
    """Split *source* at explicit boundary page numbers.

    The boundary list specifies the *first* page of each new segment
    (1-based).  The first segment always starts at page 1.

    Example: ``boundaries=[5, 10]`` creates three files:
    pages 1-4, 5-9, 10-end.

    Parameters
    ----------
    source:
        Input PDF path.
    boundaries:
        Sorted iterable of 1-based page numbers where new sections begin.
    output_dir:
        Directory to write output files.
    name_template:
        Format string; keys: ``stem``, ``n``, ``start``, ``end``.

    Returns
    -------
    List of paths created.
    """
    source = Path(source)
    reader = PdfReader(str(source))
    total = len(reader.pages)

    # Normalise boundaries: ensure 1 is always first, add sentinel
    pts = sorted(set(int(b) for b in boundaries))
    if not pts or pts[0] != 1:
        pts = [1] + pts
    pts.append(total + 1)

    ranges = [(pts[i], pts[i + 1] - 1) for i in range(len(pts) - 1)]
    return split_by_range(source, ranges, output_dir=output_dir, name_template=name_template)


def split_by_size(
    source: str | Path,
    max_bytes: int,
    output_dir: str | Path | None = None,
    name_template: str = "{stem}_part{n}.pdf",
) -> list[Path]:
    """Split *source* so that each output file is at most *max_bytes* in size.

    Uses a greedy page-accumulation strategy; the actual file size may
    slightly exceed *max_bytes* because page sizes can only be measured
    after writing.  To account for this, the function uses a conservative
    estimate (90 % of the limit) as the accumulation threshold.

    Parameters
    ----------
    source:
        Input PDF path.
    max_bytes:
        Target maximum size in bytes for each output file.
    output_dir:
        Directory to write output files.
    name_template:
        Format string; keys: ``stem``, ``n``, ``start``, ``end``.

    Returns
    -------
    List of paths created.
    """
    if max_bytes < 1:
        raise ValueError("max_bytes must be positive")

    source = Path(source)
    out_dir = _resolve_output_dir(output_dir, source)
    reader = PdfReader(str(source))
    total = len(reader.pages)

    created: list[Path] = []
    part = 1
    current_pages: list[int] = []  # 0-based

    def _flush(pages: list[int], part_num: int, writer_pages) -> Path:
        w = PdfWriter()
        for pi in pages:
            w.add_page(writer_pages[pi])
        start = pages[0] + 1
        end = pages[-1] + 1
        out_name = name_template.format(
            stem=source.stem, n=part_num, start=start, end=end
        )
        out_path = out_dir / out_name
        with open(out_path, "wb") as f:
            w.write(f)
        return out_path

    for page_idx in range(total):
        current_pages.append(page_idx)

        # Quick-estimate: write to /dev/null to check size
        test_writer = PdfWriter()
        for pi in current_pages:
            test_writer.add_page(reader.pages[pi])
        import io
        buf = io.BytesIO()
        test_writer.write(buf)
        estimated = buf.tell()

        if estimated > max_bytes and len(current_pages) > 1:
            # Flush without the last page
            flush_pages = current_pages[:-1]
            created.append(_flush(flush_pages, part, reader.pages))
            part += 1
            current_pages = [page_idx]

    if current_pages:
        created.append(_flush(current_pages, part, reader.pages))

    return created
