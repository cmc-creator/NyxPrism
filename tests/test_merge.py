"""Tests for nyxprism.core.merge"""
from __future__ import annotations

from pypdf import PdfReader

from nyxprism.core.merge import interleave, merge, merge_bookmarked


class TestMerge:
    def test_basic_merge(self, simple_pdf, tmp_path):
        out = tmp_path / "merged.pdf"
        result = merge([simple_pdf, simple_pdf], out)
        assert result == out
        assert PdfReader(str(result)).pages.__len__() == 10  # 5 + 5

    def test_single_file(self, simple_pdf, tmp_path):
        out = tmp_path / "merged.pdf"
        result = merge([simple_pdf], out)
        assert PdfReader(str(result)).pages.__len__() == 5

    def test_three_files(self, simple_pdf, tmp_path):
        out = tmp_path / "merged.pdf"
        result = merge([simple_pdf, simple_pdf, simple_pdf], out)
        assert PdfReader(str(result)).pages.__len__() == 15

    def test_empty_sources_raises(self, tmp_path):
        import pytest
        with pytest.raises(ValueError, match="sources must not be empty"):
            merge([], tmp_path / "out.pdf")


class TestMergeBookmarked:
    def test_bookmarks_added(self, simple_pdf, tmp_path):
        out = tmp_path / "bookmarked.pdf"
        result = merge_bookmarked([simple_pdf, simple_pdf], out, labels=["A", "B"])
        reader = PdfReader(str(result))
        assert reader.pages.__len__() == 10
        assert len(reader.outline) == 2

    def test_default_labels_use_stem(self, simple_pdf, tmp_path):
        out = tmp_path / "bookmarked.pdf"
        result = merge_bookmarked([simple_pdf, simple_pdf], out)
        reader = PdfReader(str(result))
        # Both bookmarks should use "simple" as the label
        outline = reader.outline
        assert len(outline) == 2


class TestInterleave:
    def test_interleave_basic(self, tmp_path):
        from tests.conftest import make_pdf

        odd = make_pdf(tmp_path, "odd.pdf", num_pages=3)
        even = make_pdf(tmp_path, "even.pdf", num_pages=3)
        out = tmp_path / "interleaved.pdf"
        result = interleave(odd, even, out)
        # 3 odd + 3 even = 6 pages
        assert PdfReader(str(result)).pages.__len__() == 6

    def test_interleave_unequal_pages(self, tmp_path):
        from tests.conftest import make_pdf

        odd = make_pdf(tmp_path, "odd.pdf", num_pages=4)
        even = make_pdf(tmp_path, "even.pdf", num_pages=2)
        out = tmp_path / "interleaved.pdf"
        result = interleave(odd, even, out, reverse_even=False)
        # 4 odd + 2 even = 6 pages
        assert PdfReader(str(result)).pages.__len__() == 6
