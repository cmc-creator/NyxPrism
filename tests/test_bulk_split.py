"""Integration tests for the AI bulk-split pipeline."""
from __future__ import annotations

import pytest

from nyxprism.ai.splitter import bulk_split


class TestBulkSplit:
    def test_heuristic_split_creates_files(self, batch_pdf, tmp_path):
        out_dir = tmp_path / "split"
        results = bulk_split(
            batch_pdf,
            output_dir=out_dir,
            strategy="heuristic",
            ocr_fallback=False,
            progress=False,
        )
        assert len(results) >= 1
        for path, label in results:
            assert path.exists()
            assert label  # non-empty label

    def test_all_pages_covered(self, batch_pdf, tmp_path):
        """The total page count of all output files must equal the input page count."""
        from pypdf import PdfReader

        out_dir = tmp_path / "split"
        results = bulk_split(
            batch_pdf,
            output_dir=out_dir,
            strategy="heuristic",
            ocr_fallback=False,
            progress=False,
        )
        total_out = sum(PdfReader(str(p)).pages.__len__() for p, _ in results)
        total_in = PdfReader(str(batch_pdf)).pages.__len__()
        assert total_out == total_in

    def test_single_doc_not_over_split(self, simple_pdf, tmp_path):
        """A PDF with no internal document boundaries should produce ≤ total pages files."""
        out_dir = tmp_path / "split"
        results = bulk_split(
            simple_pdf,
            output_dir=out_dir,
            strategy="heuristic",
            ocr_fallback=False,
            progress=False,
        )
        assert len(results) <= 5  # must not produce more files than pages

    def test_output_dir_created(self, batch_pdf, tmp_path):
        out_dir = tmp_path / "deep" / "nested" / "dir"
        results = bulk_split(
            batch_pdf,
            output_dir=out_dir,
            strategy="heuristic",
            ocr_fallback=False,
            progress=False,
        )
        assert out_dir.exists()

    def test_custom_name_template(self, batch_pdf, tmp_path):
        out_dir = tmp_path / "split"
        results = bulk_split(
            batch_pdf,
            output_dir=out_dir,
            strategy="heuristic",
            ocr_fallback=False,
            name_template="doc_{n}_{name}.pdf",
            progress=False,
        )
        for path, _ in results:
            assert path.name.startswith("doc_")

    def test_auto_strategy_without_api_key(self, batch_pdf, tmp_path, monkeypatch):
        """auto without API key should silently use heuristic."""
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        out_dir = tmp_path / "split"
        results = bulk_split(
            batch_pdf,
            output_dir=out_dir,
            strategy="auto",
            api_key=None,
            ocr_fallback=False,
            progress=False,
        )
        assert len(results) >= 1
