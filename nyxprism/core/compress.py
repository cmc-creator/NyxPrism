"""PDF compression utilities.

Uses pypdf's content-stream compression and optionally downsizes embedded
images to reduce file size.
"""
from __future__ import annotations

import io
from pathlib import Path

from pypdf import PdfReader, PdfWriter


# ---------------------------------------------------------------------------
# Public helpers
# ---------------------------------------------------------------------------

def compress(
    source: str | Path,
    output: str | Path | None = None,
    image_quality: int = 75,
    compress_streams: bool = True,
) -> Path:
    """Compress *source* and write the result to *output*.

    Parameters
    ----------
    source:
        Input PDF path.
    output:
        Output path.  Defaults to ``<stem>_compressed.pdf`` in the same
        directory as *source*.
    image_quality:
        JPEG quality (1-95) used when re-encoding embedded images.
        Set to ``0`` to skip image recompression entirely.
    compress_streams:
        Whether to apply FlateDecode compression to content streams.

    Returns
    -------
    Path to the created file.
    """
    source = Path(source)
    if output is None:
        output = source.parent / f"{source.stem}_compressed.pdf"
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)

    reader = PdfReader(str(source))
    writer = PdfWriter()

    for page in reader.pages:
        writer.add_page(page)

    if compress_streams:
        for page in writer.pages:
            page.compress_content_streams()

    # Re-compress images if Pillow is available and quality requested
    if image_quality > 0:
        _recompress_images(writer, image_quality)

    with open(output, "wb") as f:
        writer.write(f)
    return output


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _recompress_images(writer: PdfWriter, quality: int) -> None:
    """Re-encode embedded images in *writer* using JPEG at *quality*."""
    try:
        from PIL import Image
    except ImportError:
        return  # Pillow not available – skip silently

    for page in writer.pages:
        resources = page.get("/Resources")
        if resources is None:
            continue
        x_objects = resources.get("/XObject")
        if x_objects is None:
            continue

        for name in list(x_objects.keys()):
            obj = x_objects[name]
            if obj is None:
                continue
            # Resolve indirect reference
            if hasattr(obj, "get_object"):
                obj = obj.get_object()
            if obj.get("/Subtype") != "/Image":
                continue

            try:
                data = obj.get_data()
            except Exception:
                continue

            try:
                img = Image.open(io.BytesIO(data)).convert("RGB")
                buf = io.BytesIO()
                img.save(buf, format="JPEG", quality=quality, optimize=True)
                new_data = buf.getvalue()
            except Exception:
                continue

            # Only replace if we actually saved space
            if len(new_data) >= len(data):
                continue

            obj.set_data(new_data)
            obj["/Filter"] = "/DCTDecode"
            obj["/ColorSpace"] = "/DeviceRGB"
