"""PDF page manipulation: rotate, reorder, delete, crop."""
from __future__ import annotations

from pathlib import Path

from pypdf import PdfReader, PdfWriter


def rotate_pages(
    source: str | Path,
    output: str | Path | None = None,
    degrees: int = 90,
    page_numbers: list[int] | None = None,
) -> Path:
    """Rotate pages in *source* by *degrees* (must be a multiple of 90).

    Parameters
    ----------
    source:
        Input PDF path.
    output:
        Output path.  Defaults to overwriting *source*.
    degrees:
        Clockwise rotation in degrees.  Must be 90, 180, or 270.
    page_numbers:
        1-based list of pages to rotate.  ``None`` rotates all pages.

    Returns
    -------
    Path to the created file.
    """
    if degrees % 90 != 0:
        raise ValueError("degrees must be a multiple of 90")
    source = Path(source)
    if output is None:
        output = source.parent / f"{source.stem}_rotated.pdf"
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)

    reader = PdfReader(str(source))
    writer = PdfWriter()
    target_pages = set(page_numbers) if page_numbers else None

    for i, page in enumerate(reader.pages, start=1):
        if target_pages is None or i in target_pages:
            page.rotate(degrees)
        writer.add_page(page)

    with open(output, "wb") as f:
        writer.write(f)
    return output


def reorder_pages(
    source: str | Path,
    order: list[int],
    output: str | Path | None = None,
) -> Path:
    """Produce a new PDF with pages in *order*.

    Parameters
    ----------
    source:
        Input PDF path.
    order:
        1-based list of page numbers in the desired output order.
        Pages may be repeated or omitted.
    output:
        Output path.  Defaults to ``<stem>_reordered.pdf``.

    Returns
    -------
    Path to the created file.
    """
    source = Path(source)
    if output is None:
        output = source.parent / f"{source.stem}_reordered.pdf"
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)

    reader = PdfReader(str(source))
    total = len(reader.pages)
    writer = PdfWriter()

    for p in order:
        if p < 1 or p > total:
            raise ValueError(f"Page number {p} out of range (1–{total})")
        writer.add_page(reader.pages[p - 1])

    with open(output, "wb") as f:
        writer.write(f)
    return output


def delete_pages(
    source: str | Path,
    page_numbers: list[int],
    output: str | Path | None = None,
) -> Path:
    """Return a copy of *source* with the specified pages removed.

    Parameters
    ----------
    source:
        Input PDF path.
    page_numbers:
        1-based list of page numbers to delete.
    output:
        Output path.  Defaults to ``<stem>_deleted.pdf``.

    Returns
    -------
    Path to the created file.
    """
    source = Path(source)
    if output is None:
        output = source.parent / f"{source.stem}_deleted.pdf"
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)

    reader = PdfReader(str(source))
    total = len(reader.pages)
    remove = set(page_numbers)
    writer = PdfWriter()

    for i, page in enumerate(reader.pages, start=1):
        if i not in remove:
            writer.add_page(page)

    if len(writer.pages) == 0:
        raise ValueError("Deleting the requested pages would produce an empty PDF.")

    with open(output, "wb") as f:
        writer.write(f)
    return output
