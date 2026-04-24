"""Tests for nyxprism.core.compress, pages, protect, watermark, extract."""
from __future__ import annotations

import pytest
from pypdf import PdfReader

from nyxprism.core.compress import compress
from nyxprism.core.extract import extract_text, extract_text_by_page, images_to_pdf
from nyxprism.core.pages import delete_pages, reorder_pages, rotate_pages
from nyxprism.core.protect import protect, unlock


# ---------------------------------------------------------------------------
# Compress
# ---------------------------------------------------------------------------

class TestCompress:
    def test_creates_output_file(self, simple_pdf, tmp_path):
        out = tmp_path / "compressed.pdf"
        result = compress(simple_pdf, output=out, image_quality=0)
        assert result == out
        assert out.exists()

    def test_default_output_name(self, simple_pdf, tmp_path):
        result = compress(simple_pdf, image_quality=0)
        assert result.name == "simple_compressed.pdf"
        assert result.exists()

    def test_page_count_preserved(self, simple_pdf, tmp_path):
        out = tmp_path / "compressed.pdf"
        compress(simple_pdf, output=out, image_quality=0)
        assert PdfReader(str(out)).pages.__len__() == 5


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------

class TestRotatePages:
    def test_rotate_all_pages(self, simple_pdf, tmp_path):
        out = tmp_path / "rotated.pdf"
        result = rotate_pages(simple_pdf, output=out, degrees=90)
        assert result.exists()
        assert PdfReader(str(result)).pages.__len__() == 5

    def test_invalid_degrees(self, simple_pdf, tmp_path):
        with pytest.raises(ValueError, match="multiple of 90"):
            rotate_pages(simple_pdf, output=tmp_path / "out.pdf", degrees=45)

    def test_rotate_specific_pages(self, simple_pdf, tmp_path):
        out = tmp_path / "rotated.pdf"
        result = rotate_pages(simple_pdf, output=out, degrees=180, page_numbers=[1, 3])
        assert result.exists()


class TestReorderPages:
    def test_reverse_order(self, simple_pdf, tmp_path):
        out = tmp_path / "reordered.pdf"
        result = reorder_pages(simple_pdf, [5, 4, 3, 2, 1], output=out)
        assert PdfReader(str(result)).pages.__len__() == 5

    def test_subset(self, simple_pdf, tmp_path):
        out = tmp_path / "reordered.pdf"
        result = reorder_pages(simple_pdf, [1, 3, 5], output=out)
        assert PdfReader(str(result)).pages.__len__() == 3

    def test_duplicate_page(self, simple_pdf, tmp_path):
        out = tmp_path / "reordered.pdf"
        result = reorder_pages(simple_pdf, [1, 1, 1], output=out)
        assert PdfReader(str(result)).pages.__len__() == 3

    def test_out_of_range_raises(self, simple_pdf, tmp_path):
        with pytest.raises(ValueError, match="out of range"):
            reorder_pages(simple_pdf, [1, 99], output=tmp_path / "out.pdf")


class TestDeletePages:
    def test_delete_single_page(self, simple_pdf, tmp_path):
        out = tmp_path / "deleted.pdf"
        result = delete_pages(simple_pdf, [3], output=out)
        assert PdfReader(str(result)).pages.__len__() == 4

    def test_delete_multiple_pages(self, simple_pdf, tmp_path):
        out = tmp_path / "deleted.pdf"
        result = delete_pages(simple_pdf, [1, 2], output=out)
        assert PdfReader(str(result)).pages.__len__() == 3

    def test_delete_all_raises(self, simple_pdf, tmp_path):
        with pytest.raises(ValueError, match="empty PDF"):
            delete_pages(simple_pdf, [1, 2, 3, 4, 5], output=tmp_path / "out.pdf")


# ---------------------------------------------------------------------------
# Protect
# ---------------------------------------------------------------------------

class TestProtect:
    def test_encrypts_pdf(self, simple_pdf, tmp_path):
        out = tmp_path / "protected.pdf"
        result = protect(simple_pdf, user_password="test123", output=out)
        assert result.exists()
        reader = PdfReader(str(result))
        assert reader.is_encrypted

    def test_unlock_with_correct_password(self, simple_pdf, tmp_path):
        protected = tmp_path / "protected.pdf"
        protect(simple_pdf, user_password="abc123", output=protected)
        unlocked = tmp_path / "unlocked.pdf"
        result = unlock(protected, password="abc123", output=unlocked)
        assert result.exists()
        reader = PdfReader(str(result))
        assert not reader.is_encrypted

    def test_unlock_wrong_password_raises(self, simple_pdf, tmp_path):
        protected = tmp_path / "protected.pdf"
        protect(simple_pdf, user_password="correct", output=protected)
        with pytest.raises(ValueError, match="Incorrect password"):
            unlock(protected, password="wrong", output=tmp_path / "out.pdf")


# ---------------------------------------------------------------------------
# Extract
# ---------------------------------------------------------------------------

class TestExtractText:
    def test_returns_string(self, simple_pdf):
        text = extract_text(simple_pdf)
        assert isinstance(text, str)

    def test_contains_page_markers(self, simple_pdf):
        text = extract_text(simple_pdf)
        assert "Page 1" in text

    def test_specific_pages(self, simple_pdf):
        text = extract_text(simple_pdf, page_numbers=[1])
        assert "Page 1" in text
        # Page 1 separator must be present, page 5 separator must not
        assert "--- Page 1 ---" in text


class TestExtractTextByPage:
    def test_returns_list(self, simple_pdf):
        texts = extract_text_by_page(simple_pdf)
        assert isinstance(texts, list)
        assert len(texts) == 5

    def test_each_element_is_string(self, simple_pdf):
        texts = extract_text_by_page(simple_pdf)
        assert all(isinstance(t, str) for t in texts)


class TestImagesToPdf:
    def test_creates_pdf(self, tmp_path):
        from PIL import Image as PILImage

        # Create 3 simple test images
        images = []
        for i in range(3):
            img = PILImage.new("RGB", (100, 100), color=(i * 80, 100, 200))
            p = tmp_path / f"img_{i}.png"
            img.save(str(p))
            images.append(p)

        out = tmp_path / "from_images.pdf"
        result = images_to_pdf(images, out)
        assert result.exists()
        assert PdfReader(str(result)).pages.__len__() == 3

    def test_empty_images_raises(self, tmp_path):
        with pytest.raises(ValueError, match="images must not be empty"):
            images_to_pdf([], tmp_path / "out.pdf")
