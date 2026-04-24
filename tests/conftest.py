"""Shared test fixtures and helpers."""
from __future__ import annotations

import io
from pathlib import Path

import pytest
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_pdf(tmp_path: Path, name: str, num_pages: int = 3, texts: list[str] | None = None) -> Path:
    """Create a simple multi-page PDF using ReportLab.

    Parameters
    ----------
    tmp_path:
        Directory to write the file.
    name:
        Filename (without extension or with .pdf).
    num_pages:
        Number of pages to generate.
    texts:
        Optional list of strings, one per page.  Defaults to "Page N".

    Returns
    -------
    Path to the created PDF.
    """
    if not name.endswith(".pdf"):
        name += ".pdf"
    dest = tmp_path / name
    width, height = letter

    buf = io.BytesIO()
    c = canvas.Canvas(str(dest), pagesize=letter)
    for i in range(num_pages):
        text = texts[i] if texts and i < len(texts) else f"Page {i + 1}"
        c.setFont("Helvetica", 24)
        c.drawString(72, height / 2, text)
        c.showPage()
    c.save()
    return dest


def make_batch_pdf(tmp_path: Path, name: str, doc_texts: list[list[str]]) -> Path:
    """Create a single PDF that contains multiple logical documents.

    *doc_texts* is a list of documents; each document is a list of page texts.
    """
    all_texts: list[str] = []
    for doc in doc_texts:
        all_texts.extend(doc)
    return make_pdf(tmp_path, name, num_pages=len(all_texts), texts=all_texts)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def simple_pdf(tmp_path):
    """A 5-page PDF for general-purpose tests."""
    return make_pdf(tmp_path, "simple.pdf", num_pages=5)


@pytest.fixture()
def batch_pdf(tmp_path):
    """A 6-page PDF simulating 3 two-page documents (invoice, contract, letter)."""
    doc_texts = [
        [
            "INVOICE\nDate: 2024-01-15\nInvoice #: 12345\nAmount: $500",
            "Line items\nItem A: $300\nItem B: $200",
        ],
        [
            "CONTRACT\nAgreement between Party A and Party B\nDate: 2024-02-01",
            "Terms and conditions\nClause 1: ...\nClause 2: ...",
        ],
        [
            "Dear John,\nThank you for your inquiry regarding our services.",
            "We look forward to hearing from you.\nSincerely,\nJane Doe",
        ],
    ]
    return make_batch_pdf(tmp_path, "batch.pdf", doc_texts)
