"""Watermarking utilities for PDF files."""
from __future__ import annotations

import io
import tempfile
from pathlib import Path

from pypdf import PdfReader, PdfWriter


def add_text_watermark(
    source: str | Path,
    text: str,
    output: str | Path | None = None,
    opacity: float = 0.3,
    font_size: int = 60,
    color: tuple[float, float, float] = (0.5, 0.5, 0.5),
    angle: float = 45.0,
) -> Path:
    """Stamp each page of *source* with a text watermark.

    Parameters
    ----------
    source:
        Input PDF path.
    text:
        Watermark text (e.g. ``"CONFIDENTIAL"``).
    output:
        Output path.  Defaults to ``<stem>_watermarked.pdf``.
    opacity:
        Transparency of the watermark (0 = invisible, 1 = opaque).
    font_size:
        Font size of the watermark text in points.
    color:
        RGB tuple with values in [0, 1].
    angle:
        Rotation angle of the watermark text in degrees.

    Returns
    -------
    Path to the watermarked PDF.
    """
    try:
        from reportlab.lib.pagesizes import letter
        from reportlab.lib.units import inch
        from reportlab.pdfgen import canvas as rl_canvas
    except ImportError as exc:
        raise ImportError(
            "reportlab is required for watermarking. "
            "Install it with: pip install reportlab"
        ) from exc

    source = Path(source)
    if output is None:
        output = source.parent / f"{source.stem}_watermarked.pdf"
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)

    reader = PdfReader(str(source))
    writer = PdfWriter()

    for page in reader.pages:
        # Determine page dimensions
        media_box = page.mediabox
        width = float(media_box.width)
        height = float(media_box.height)

        # Create watermark PDF in memory
        wm_buf = io.BytesIO()
        c = rl_canvas.Canvas(wm_buf, pagesize=(width, height))
        c.setFillColorRGB(*color, alpha=opacity)
        c.setFont("Helvetica-Bold", font_size)
        c.saveState()
        c.translate(width / 2, height / 2)
        c.rotate(angle)
        c.drawCentredString(0, 0, text)
        c.restoreState()
        c.save()

        wm_buf.seek(0)
        wm_reader = PdfReader(wm_buf)
        wm_page = wm_reader.pages[0]
        page.merge_page(wm_page)
        writer.add_page(page)

    with open(output, "wb") as f:
        writer.write(f)
    return output


def add_image_watermark(
    source: str | Path,
    image_path: str | Path,
    output: str | Path | None = None,
    opacity: float = 0.3,
    scale: float = 0.5,
) -> Path:
    """Stamp each page of *source* with an image watermark.

    Parameters
    ----------
    source:
        Input PDF path.
    image_path:
        Path to the watermark image (PNG recommended).
    output:
        Output path.  Defaults to ``<stem>_watermarked.pdf``.
    opacity:
        Transparency of the watermark (0 = invisible, 1 = opaque).
    scale:
        Scale factor relative to page width.

    Returns
    -------
    Path to the watermarked PDF.
    """
    try:
        from reportlab.pdfgen import canvas as rl_canvas
    except ImportError as exc:
        raise ImportError(
            "reportlab is required for watermarking. "
            "Install it with: pip install reportlab"
        ) from exc

    source = Path(source)
    image_path = Path(image_path)
    if output is None:
        output = source.parent / f"{source.stem}_watermarked.pdf"
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)

    reader = PdfReader(str(source))
    writer = PdfWriter()

    for page in reader.pages:
        media_box = page.mediabox
        width = float(media_box.width)
        height = float(media_box.height)

        wm_buf = io.BytesIO()
        c = rl_canvas.Canvas(wm_buf, pagesize=(width, height))
        c.setFillAlpha(opacity)

        img_width = width * scale
        img_height = height * scale
        x = (width - img_width) / 2
        y = (height - img_height) / 2
        c.drawImage(
            str(image_path),
            x,
            y,
            width=img_width,
            height=img_height,
            mask="auto",
        )
        c.save()

        wm_buf.seek(0)
        wm_reader = PdfReader(wm_buf)
        wm_page = wm_reader.pages[0]
        page.merge_page(wm_page)
        writer.add_page(page)

    with open(output, "wb") as f:
        writer.write(f)
    return output
