"""Tests for nyxprism.core.split"""
from __future__ import annotations

import pytest
from pypdf import PdfReader

from nyxprism.core.split import (
    split_at_pages,
    split_by_range,
    split_by_size,
    split_every_n,
)


class TestSplitByRange:
    def test_single_range(self, simple_pdf, tmp_path):
        out_dir = tmp_path / "out"
        created = split_by_range(simple_pdf, [(1, 3)], output_dir=out_dir)
        assert len(created) == 1
        assert PdfReader(str(created[0])).pages.__len__() == 3

    def test_multiple_ranges(self, simple_pdf, tmp_path):
        out_dir = tmp_path / "out"
        created = split_by_range(simple_pdf, [(1, 2), (3, 5)], output_dir=out_dir)
        assert len(created) == 2
        assert PdfReader(str(created[0])).pages.__len__() == 2
        assert PdfReader(str(created[1])).pages.__len__() == 3

    def test_invalid_range_raises(self, simple_pdf, tmp_path):
        with pytest.raises(ValueError, match="Invalid range"):
            split_by_range(simple_pdf, [(0, 2)], output_dir=tmp_path / "out")

    def test_out_of_bounds_raises(self, simple_pdf, tmp_path):
        with pytest.raises(ValueError, match="Invalid range"):
            split_by_range(simple_pdf, [(1, 99)], output_dir=tmp_path / "out")

    def test_custom_name_template(self, simple_pdf, tmp_path):
        out_dir = tmp_path / "out"
        created = split_by_range(
            simple_pdf,
            [(1, 2), (3, 5)],
            output_dir=out_dir,
            name_template="doc_{n}_{start}to{end}.pdf",
        )
        assert created[0].name == "doc_1_1to2.pdf"
        assert created[1].name == "doc_2_3to5.pdf"


class TestSplitEveryN:
    def test_basic_split(self, simple_pdf, tmp_path):
        out_dir = tmp_path / "out"
        created = split_every_n(simple_pdf, 2, output_dir=out_dir)
        # 5 pages, n=2 → [1-2], [3-4], [5-5]
        assert len(created) == 3
        assert PdfReader(str(created[0])).pages.__len__() == 2
        assert PdfReader(str(created[1])).pages.__len__() == 2
        assert PdfReader(str(created[2])).pages.__len__() == 1

    def test_n_larger_than_total(self, simple_pdf, tmp_path):
        out_dir = tmp_path / "out"
        created = split_every_n(simple_pdf, 10, output_dir=out_dir)
        assert len(created) == 1
        assert PdfReader(str(created[0])).pages.__len__() == 5

    def test_n_zero_raises(self, simple_pdf, tmp_path):
        with pytest.raises(ValueError):
            split_every_n(simple_pdf, 0, output_dir=tmp_path / "out")

    def test_split_every_one(self, simple_pdf, tmp_path):
        out_dir = tmp_path / "out"
        created = split_every_n(simple_pdf, 1, output_dir=out_dir)
        assert len(created) == 5
        for f in created:
            assert PdfReader(str(f)).pages.__len__() == 1


class TestSplitAtPages:
    def test_basic(self, simple_pdf, tmp_path):
        out_dir = tmp_path / "out"
        created = split_at_pages(simple_pdf, [3], output_dir=out_dir)
        # Boundaries [3] → [1-2], [3-5]
        assert len(created) == 2
        assert PdfReader(str(created[0])).pages.__len__() == 2
        assert PdfReader(str(created[1])).pages.__len__() == 3

    def test_multiple_boundaries(self, simple_pdf, tmp_path):
        out_dir = tmp_path / "out"
        created = split_at_pages(simple_pdf, [2, 4], output_dir=out_dir)
        # → [1], [2-3], [4-5]
        assert len(created) == 3
        assert PdfReader(str(created[0])).pages.__len__() == 1
        assert PdfReader(str(created[1])).pages.__len__() == 2
        assert PdfReader(str(created[2])).pages.__len__() == 2

    def test_boundary_at_page_one_ignored(self, simple_pdf, tmp_path):
        out_dir = tmp_path / "out"
        created = split_at_pages(simple_pdf, [1, 3], output_dir=out_dir)
        assert len(created) == 2

    def test_duplicate_boundaries(self, simple_pdf, tmp_path):
        out_dir = tmp_path / "out"
        created = split_at_pages(simple_pdf, [3, 3], output_dir=out_dir)
        assert len(created) == 2


class TestSplitBySize:
    def test_small_max_size(self, simple_pdf, tmp_path):
        out_dir = tmp_path / "out"
        # Very small max forces multiple files
        created = split_by_size(simple_pdf, max_bytes=5_000, output_dir=out_dir)
        # Each file should exist and be non-empty
        assert len(created) >= 1
        for f in created:
            assert f.exists()
            assert f.stat().st_size > 0

    def test_large_max_size(self, simple_pdf, tmp_path):
        out_dir = tmp_path / "out"
        # Large limit → single file
        created = split_by_size(simple_pdf, max_bytes=100_000_000, output_dir=out_dir)
        assert len(created) == 1

    def test_invalid_max_bytes(self, simple_pdf, tmp_path):
        with pytest.raises(ValueError):
            split_by_size(simple_pdf, max_bytes=0, output_dir=tmp_path / "out")
