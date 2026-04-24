"""Tests for the AI boundary detection and naming modules."""
from __future__ import annotations

import pytest

from nyxprism.ai.analyzer import detect_boundaries, _heuristic_boundaries
from nyxprism.ai.namer import suggest_name, suggest_names_bulk, _sanitise, _deduplicate


# ---------------------------------------------------------------------------
# Analyzer – heuristic strategy
# ---------------------------------------------------------------------------

class TestHeuristicBoundaries:
    def test_single_document(self):
        texts = ["page one content with lots of text " * 20] * 5
        boundaries = _heuristic_boundaries(texts)
        assert boundaries[0] == 1

    def test_blank_page_signals_boundary(self):
        texts = [
            "lots of text here " * 30,
            "",  # blank page 2
            "INVOICE\nNew document starts here " * 20,
            "continuation of invoice",
        ]
        boundaries = _heuristic_boundaries(texts)
        assert 3 in boundaries  # page 3 starts a new doc after blank

    def test_invoice_keyword(self):
        texts = [
            "Regular report content " * 20,
            "Regular report page 2 " * 20,
            "INVOICE\nDate: 2024-01-15\nAmount: $1000 " * 5,
            "Invoice line items",
        ]
        boundaries = _heuristic_boundaries(texts)
        assert 3 in boundaries

    def test_cover_pattern_dear(self):
        texts = [
            "report content " * 30,
            "Dear John,\nThank you for your letter " * 5,
        ]
        boundaries = _heuristic_boundaries(texts)
        assert 2 in boundaries

    def test_always_starts_with_1(self):
        texts = ["foo"] * 3
        boundaries = detect_boundaries(texts, strategy="heuristic")
        assert boundaries[0] == 1

    def test_empty_input(self):
        boundaries = _heuristic_boundaries([])
        assert boundaries == [1]

    def test_detect_boundaries_heuristic_strategy(self):
        texts = ["doc one " * 50] * 3 + ["INVOICE\n" * 10] * 2
        result = detect_boundaries(texts, strategy="heuristic")
        assert isinstance(result, list)
        assert result[0] == 1


class TestDetectBoundariesFallback:
    def test_auto_falls_back_to_heuristic_without_key(self, monkeypatch):
        """auto strategy with no API key must use heuristic without error."""
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        texts = ["content " * 50] * 4
        result = detect_boundaries(texts, strategy="auto", api_key=None)
        assert isinstance(result, list)
        assert result[0] == 1


# ---------------------------------------------------------------------------
# Namer – heuristic strategy
# ---------------------------------------------------------------------------

class TestSuggestName:
    def test_invoice_detected(self):
        text = "INVOICE\nDate: 2024-01-15\nInvoice #: 12345\nAmount: $500"
        name = suggest_name(text, strategy="heuristic")
        assert "invoice" in name.lower()

    def test_contract_detected(self):
        text = "CONTRACT\nAgreement between Party A and Party B"
        name = suggest_name(text, strategy="heuristic")
        assert "contract" in name.lower()

    def test_letter_detected(self):
        text = "Dear John,\nThank you for your inquiry."
        name = suggest_name(text, strategy="heuristic")
        assert name  # Non-empty

    def test_date_in_name(self):
        text = "REPORT\nDate: 2024-03-15\nQuarterly summary"
        name = suggest_name(text, strategy="heuristic")
        assert "2024" in name or "03" in name or "15" in name or "report" in name.lower()

    def test_fallback_to_first_line(self):
        name = suggest_name("My Custom Document Title\nsome other content", strategy="heuristic")
        assert name  # should not be empty

    def test_auto_without_key(self, monkeypatch):
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        name = suggest_name("INVOICE\nDate: 2024-01-15", strategy="auto", api_key=None)
        assert name


class TestSuggestNamesBulk:
    def test_returns_same_count(self):
        texts = ["invoice text"] * 3
        names = suggest_names_bulk(texts, strategy="heuristic")
        assert len(names) == 3

    def test_deduplication(self):
        texts = ["invoice text"] * 3
        names = suggest_names_bulk(texts, strategy="heuristic")
        assert len(set(names)) == len(names)  # all unique

    def test_empty_list(self):
        names = suggest_names_bulk([], strategy="heuristic")
        assert names == []


# ---------------------------------------------------------------------------
# Utility functions
# ---------------------------------------------------------------------------

class TestSanitise:
    def test_spaces_to_underscores(self):
        assert "_" not in _sanitise("hello world").replace("_", "")  # only underscores
        assert _sanitise("hello world") == "hello_world"

    def test_special_chars_removed(self):
        result = _sanitise("Invoice #123 (2024/01/15)")
        assert "#" not in result
        assert "(" not in result
        assert "/" not in result

    def test_max_length(self):
        long_name = "a" * 200
        assert len(_sanitise(long_name)) <= 80

    def test_empty_string(self):
        assert _sanitise("") == ""


class TestDeduplicate:
    def test_no_duplicates(self):
        names = ["a", "b", "c"]
        assert _deduplicate(names) == ["a", "b", "c"]

    def test_simple_duplicates(self):
        names = ["a", "a", "a"]
        result = _deduplicate(names)
        assert len(set(result)) == 3
        assert result[0] == "a"

    def test_mixed(self):
        names = ["a", "b", "a", "c", "b"]
        result = _deduplicate(names)
        assert len(set(result)) == 5
