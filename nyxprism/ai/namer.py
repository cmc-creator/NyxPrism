"""AI-powered document naming.

Given the first page (or summary) of a document, proposes a clean, descriptive
filename.

Two strategies:
* ``"llm"``       – uses an OpenAI-compatible API.
* ``"heuristic"`` – extracts keywords and dates from the text without an API.
* ``"auto"``      – tries LLM first, falls back to heuristic.
"""
from __future__ import annotations

import os
import re
import unicodedata
from typing import Literal


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def suggest_name(
    text: str,
    strategy: Literal["llm", "heuristic", "auto"] = "auto",
    api_key: str | None = None,
    model: str = "gpt-4o-mini",
    max_chars: int = 2000,
) -> str:
    """Suggest a descriptive filename (without extension) for a document.

    Parameters
    ----------
    text:
        Representative text from the document (e.g. first page).
    strategy:
        Naming strategy.  See module docstring.
    api_key:
        OpenAI API key.  Falls back to ``OPENAI_API_KEY`` env var.
    model:
        OpenAI model name.
    max_chars:
        Maximum characters of *text* sent to the LLM.

    Returns
    -------
    A filesystem-safe filename stem (no extension, no path separators).
    """
    if strategy == "heuristic":
        return _heuristic_name(text)
    if strategy == "llm":
        return _llm_name(text, api_key=api_key, model=model, max_chars=max_chars)
    # "auto"
    key = api_key or os.environ.get("OPENAI_API_KEY", "")
    if key:
        try:
            return _llm_name(text, api_key=api_key, model=model, max_chars=max_chars)
        except Exception:
            pass
    return _heuristic_name(text)


def suggest_names_bulk(
    texts: list[str],
    strategy: Literal["llm", "heuristic", "auto"] = "auto",
    api_key: str | None = None,
    model: str = "gpt-4o-mini",
    max_chars: int = 2000,
) -> list[str]:
    """Suggest filenames for multiple documents, deduplicating conflicts.

    Parameters
    ----------
    texts:
        List of representative texts, one per document.
    strategy, api_key, model, max_chars:
        Forwarded to :func:`suggest_name`.

    Returns
    -------
    List of unique filesystem-safe filename stems, one per document.
    """
    raw_names = [
        suggest_name(t, strategy=strategy, api_key=api_key, model=model,
                     max_chars=max_chars)
        for t in texts
    ]
    return _deduplicate(raw_names)


# ---------------------------------------------------------------------------
# LLM strategy
# ---------------------------------------------------------------------------

_NAME_SYSTEM = (
    "You are a file-naming assistant. "
    "Given the text of a document, output ONLY a short, descriptive filename "
    "stem (no extension, no path separators, use underscores instead of spaces, "
    "max 60 characters, no special characters except hyphens and underscores). "
    "Do NOT include any explanation."
)


def _llm_name(text: str, api_key: str | None, model: str, max_chars: int) -> str:
    from openai import OpenAI

    effective_key = api_key or os.environ.get("OPENAI_API_KEY")
    if not effective_key:
        raise EnvironmentError("OPENAI_API_KEY is not set.")

    client = OpenAI(api_key=effective_key)
    snippet = text.strip()[:max_chars]

    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": _NAME_SYSTEM},
            {"role": "user", "content": snippet},
        ],
        temperature=0,
        max_tokens=64,
    )
    raw = response.choices[0].message.content.strip()
    return _sanitise(raw)


# ---------------------------------------------------------------------------
# Heuristic strategy
# ---------------------------------------------------------------------------

# Patterns to extract date components
_DATE_PATTERNS = [
    re.compile(r"\b(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})\b"),  # 2023-01-15
    re.compile(r"\b(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})\b"),  # 15.01.2023
    re.compile(
        r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*"
        r"[\s,.]+(\d{1,2})[\s,]+(\d{4})\b",
        re.IGNORECASE,
    ),
]

# Common document type keywords (ordered by specificity)
_DOC_KEYWORDS = [
    "invoice", "contract", "agreement", "report", "letter", "memo",
    "proposal", "statement", "order", "receipt", "certificate", "policy",
    "form", "appendix", "exhibit", "attachment", "resume", "cv",
    "minutes", "agenda", "specification", "manual", "guide", "plan",
    "budget", "forecast", "analysis", "review", "summary", "notice",
]


def _heuristic_name(text: str) -> str:
    """Build a descriptive name from keywords and dates in *text*."""
    lines = [l.strip() for l in text.strip().splitlines() if l.strip()]
    candidate_parts: list[str] = []

    # 1. Document type keyword
    doc_type = _extract_doc_type(text)
    if doc_type:
        candidate_parts.append(doc_type)

    # 2. Prominent noun/title from the first few lines
    title = _extract_title(lines[:10])
    if title and title.lower() not in (doc_type or "").lower():
        candidate_parts.append(title)

    # 3. Date
    date_str = _extract_date(text)
    if date_str:
        candidate_parts.append(date_str)

    if not candidate_parts:
        # Last resort: first non-empty line, truncated
        candidate_parts.append(lines[0][:50] if lines else "document")

    raw = "_".join(candidate_parts)
    return _sanitise(raw) or "document"


def _extract_doc_type(text: str) -> str:
    lower = text.lower()
    for kw in _DOC_KEYWORDS:
        if re.search(r"\b" + kw + r"\b", lower):
            return kw
    return ""


def _extract_title(lines: list[str]) -> str:
    """Return the most title-like line (short, often ALL-CAPS or Title Case)."""
    for line in lines:
        if not line:
            continue
        # Skip lines that look like metadata (key: value)
        if re.match(r"^[\w\s]+:\s+\S", line):
            continue
        word_count = len(line.split())
        if 1 <= word_count <= 8:
            return line[:60]
    return ""


def _extract_date(text: str) -> str:
    for pat in _DATE_PATTERNS:
        m = pat.search(text)
        if m:
            return m.group(0).replace("/", "-").replace(".", "-").replace(" ", "-")
    return ""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _sanitise(name: str) -> str:
    """Make *name* safe for use as a filename stem."""
    # Normalise unicode
    name = unicodedata.normalize("NFKD", name)
    name = name.encode("ascii", "ignore").decode("ascii")
    # Replace spaces and common separators with underscores
    name = re.sub(r"[\s\-]+", "_", name)
    # Remove everything that is not alphanumeric or _ or -
    name = re.sub(r"[^\w\-]", "", name)
    # Collapse multiple underscores
    name = re.sub(r"_+", "_", name).strip("_")
    return name[:80]


def _deduplicate(names: list[str]) -> list[str]:
    """Ensure all names are unique by appending ``_N`` suffixes."""
    seen: dict[str, int] = {}
    result: list[str] = []
    for name in names:
        if name not in seen:
            seen[name] = 0
            result.append(name)
        else:
            seen[name] += 1
            result.append(f"{name}_{seen[name]}")
    return result
