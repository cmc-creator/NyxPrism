"""Text and image extraction from PDF documents."""
from __future__ import annotations

import io
from pathlib import Path
from typing import Iterator


# ---------------------------------------------------------------------------
# Text extraction
# ---------------------------------------------------------------------------

def extract_text(
    source: str | Path,
    page_numbers: list[int] | None = None,
) -> str:
    """Extract all text from *source* (optionally from specific pages).

    Parameters
    ----------
    source:
        Input PDF path.
    page_numbers:
        1-based list of pages to extract.  ``None`` extracts all pages.

    Returns
    -------
    Concatenated text with page separators.
    """
    import pdfplumber

    source = Path(source)
    parts: list[str] = []
    with pdfplumber.open(str(source)) as pdf:
        for i, page in enumerate(pdf.pages, start=1):
            if page_numbers is not None and i not in page_numbers:
                continue
            text = page.extract_text() or ""
            parts.append(f"--- Page {i} ---\n{text}")
    return "\n\n".join(parts)


def extract_text_by_page(
    source: str | Path,
) -> list[str]:
    """Return a list of text strings, one per page.

    Parameters
    ----------
    source:
        Input PDF path.

    Returns
    -------
    List of strings (one per page; may be empty for scanned/image pages).
    """
    import pdfplumber

    source = Path(source)
    texts: list[str] = []
    with pdfplumber.open(str(source)) as pdf:
        for page in pdf.pages:
            texts.append(page.extract_text() or "")
    return texts


def iter_page_text(source: str | Path) -> Iterator[tuple[int, str]]:
    """Yield ``(page_number, text)`` pairs (1-based)."""
    import pdfplumber

    with pdfplumber.open(str(source)) as pdf:
        for i, page in enumerate(pdf.pages, start=1):
            yield i, (page.extract_text() or "")


# ---------------------------------------------------------------------------
# Image extraction
# ---------------------------------------------------------------------------

def extract_images(
    source: str | Path,
    output_dir: str | Path | None = None,
    fmt: str = "png",
) -> list[Path]:
    """Extract all embedded images from *source*.

    Parameters
    ----------
    source:
        Input PDF path.
    output_dir:
        Directory for output images.  Defaults to ``<stem>_images/`` beside
        the source file.
    fmt:
        Output image format (``"png"``, ``"jpeg"``).

    Returns
    -------
    List of paths to the extracted images.
    """
    from PIL import Image
    from pypdf import PdfReader

    source = Path(source)
    if output_dir is None:
        output_dir = source.parent / f"{source.stem}_images"
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    reader = PdfReader(str(source))
    created: list[Path] = []
    img_index = 0

    for page_num, page in enumerate(reader.pages, start=1):
        resources = page.get("/Resources")
        if not resources:
            continue
        x_objects = resources.get("/XObject")
        if not x_objects:
            continue
        for name in x_objects:
            obj = x_objects[name]
            if hasattr(obj, "get_object"):
                obj = obj.get_object()
            if obj.get("/Subtype") != "/Image":
                continue
            try:
                data = obj.get_data()
                img = Image.open(io.BytesIO(data))
                out_path = output_dir / f"page{page_num}_img{img_index}.{fmt}"
                img.save(str(out_path))
                created.append(out_path)
                img_index += 1
            except Exception:
                continue

    return created


# ---------------------------------------------------------------------------
# PDF → image (render each page)
# ---------------------------------------------------------------------------

def pdf_to_images(
    source: str | Path,
    output_dir: str | Path | None = None,
    dpi: int = 150,
    fmt: str = "png",
) -> list[Path]:
    """Render each page of *source* as a raster image.

    Requires ``pypdfium2`` (installed automatically with pypdf extras or
    separately).

    Parameters
    ----------
    source:
        Input PDF path.
    output_dir:
        Directory for output images.  Defaults to ``<stem>_pages/``.
    dpi:
        Resolution in dots per inch.
    fmt:
        Output format (``"png"`` or ``"jpeg"``).

    Returns
    -------
    List of paths to rendered images.
    """
    source = Path(source)
    if output_dir is None:
        output_dir = source.parent / f"{source.stem}_pages"
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        import pypdfium2 as pdfium
    except ImportError as exc:
        raise ImportError(
            "pypdfium2 is required for pdf_to_images. "
            "Install it with: pip install pypdfium2"
        ) from exc

    pdf = pdfium.PdfDocument(str(source))
    created: list[Path] = []
    scale = dpi / 72.0

    for i, page in enumerate(pdf):
        bitmap = page.render(scale=scale, rotation=0)
        pil_image = bitmap.to_pil()
        out_path = output_dir / f"page_{i + 1:04d}.{fmt}"
        pil_image.save(str(out_path))
        created.append(out_path)

    return created


# ---------------------------------------------------------------------------
# Images → PDF
# ---------------------------------------------------------------------------

def images_to_pdf(
    images: list[str | Path],
    output: str | Path,
) -> Path:
    """Combine *images* into a single PDF.

    Each image becomes one page; the page size matches the image dimensions.

    Parameters
    ----------
    images:
        Ordered list of image paths.
    output:
        Destination PDF path.

    Returns
    -------
    Path to the created PDF.
    """
    try:
        from reportlab.lib.pagesizes import letter
        from reportlab.pdfgen import canvas as rl_canvas
    except ImportError as exc:
        raise ImportError(
            "reportlab is required for images_to_pdf. "
            "Install it with: pip install reportlab"
        ) from exc

    from PIL import Image

    if not images:
        raise ValueError("images must not be empty")
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)

    c = rl_canvas.Canvas(str(output))
    for img_path in images:
        img = Image.open(str(img_path))
        img_w, img_h = img.size
        c.setPageSize((img_w, img_h))
        c.drawImage(str(img_path), 0, 0, width=img_w, height=img_h)
        c.showPage()
    c.save()
    return output
