"""OCR (Optical Character Recognition) support via pytesseract.

Useful for scanned PDFs that contain no selectable text.
"""
from __future__ import annotations

import io
from pathlib import Path


def ocr_pdf(
    source: str | Path,
    output_text: str | Path | None = None,
    lang: str = "eng",
    dpi: int = 300,
    page_numbers: list[int] | None = None,
) -> str:
    """Run OCR on *source* and return (and optionally save) the extracted text.

    Each page of the PDF is rendered to an image and then processed with
    Tesseract.

    Parameters
    ----------
    source:
        Input PDF path.
    output_text:
        If provided, the extracted text is also saved to this path.
    lang:
        Tesseract language code(s), e.g. ``"eng"`` or ``"eng+fra"``.
    dpi:
        Rendering resolution used to rasterize PDF pages.
    page_numbers:
        1-based list of pages to OCR.  ``None`` processes all pages.

    Returns
    -------
    Full OCR text of the document.
    """
    try:
        import pytesseract
    except ImportError as exc:
        raise ImportError(
            "pytesseract is required for OCR. "
            "Install it with: pip install pytesseract"
        ) from exc

    try:
        import pypdfium2 as pdfium
    except ImportError as exc:
        raise ImportError(
            "pypdfium2 is required for OCR. "
            "Install it with: pip install pypdfium2"
        ) from exc

    from PIL import Image

    source = Path(source)
    pdf = pdfium.PdfDocument(str(source))
    scale = dpi / 72.0
    parts: list[str] = []

    for i, page in enumerate(pdf):
        page_num = i + 1
        if page_numbers is not None and page_num not in page_numbers:
            continue
        bitmap = page.render(scale=scale, rotation=0)
        pil_img = bitmap.to_pil()
        text = pytesseract.image_to_string(pil_img, lang=lang)
        parts.append(f"--- Page {page_num} ---\n{text}")

    full_text = "\n\n".join(parts)

    if output_text is not None:
        output_text = Path(output_text)
        output_text.parent.mkdir(parents=True, exist_ok=True)
        output_text.write_text(full_text, encoding="utf-8")

    return full_text


def ocr_page(
    source: str | Path,
    page_number: int,
    lang: str = "eng",
    dpi: int = 300,
) -> str:
    """OCR a single page (1-based) and return the text."""
    return ocr_pdf(source, lang=lang, dpi=dpi, page_numbers=[page_number])
