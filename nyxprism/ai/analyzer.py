"""AI-powered document boundary detection.

Identifies where logical documents begin within a multi-document PDF so that
the file can be split into individual named documents.

Two strategies are supported:

1. **LLM** (``strategy="llm"``) – sends page text to an OpenAI-compatible API
   and asks the model to identify document boundaries.  Requires an
   ``OPENAI_API_KEY`` environment variable (or explicit ``api_key`` argument).

2. **Heuristic** (``strategy="heuristic"``) – uses rule-based signals such as
   very short pages, cover-page patterns, and large formatting changes to
   guess split points without any external API call.  Works without an API key
   but is less accurate.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Literal


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def detect_boundaries(
    page_texts: list[str],
    strategy: Literal["llm", "heuristic", "auto"] = "auto",
    api_key: str | None = None,
    model: str = "gpt-4o-mini",
    max_chars_per_page: int = 1500,
) -> list[int]:
    """Return a list of 1-based page numbers where new documents begin.

    The returned list always includes ``1`` as the first element and never
    includes a value greater than ``len(page_texts)``.

    Parameters
    ----------
    page_texts:
        List of text strings extracted from each page (index 0 = page 1).
    strategy:
        ``"llm"``        – use OpenAI API (requires key).
        ``"heuristic"``  – use rule-based detection (no API needed).
        ``"auto"``       – try LLM first; fall back to heuristic on failure.
    api_key:
        OpenAI API key.  Overrides ``OPENAI_API_KEY`` environment variable.
    model:
        OpenAI model to use.
    max_chars_per_page:
        Maximum characters sent per page to the LLM (to stay within token
        limits).

    Returns
    -------
    Sorted list of 1-based page numbers (always starts with 1).
    """
    if strategy == "heuristic":
        return _heuristic_boundaries(page_texts)
    if strategy == "llm":
        return _llm_boundaries(page_texts, api_key=api_key, model=model,
                                max_chars=max_chars_per_page)
    # "auto"
    key = api_key or os.environ.get("OPENAI_API_KEY", "")
    if key:
        try:
            return _llm_boundaries(page_texts, api_key=api_key, model=model,
                                   max_chars=max_chars_per_page)
        except Exception:
            pass
    return _heuristic_boundaries(page_texts)


# ---------------------------------------------------------------------------
# LLM strategy
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = """You are a document segmentation assistant.
You will receive text snippets from the pages of a multi-document PDF.
Your task is to identify where new, independent documents begin.

Rules:
- Reply with ONLY a JSON array of integers (1-based page numbers).
- The array MUST include 1 (the first page always starts a document).
- Do NOT include any explanation or markdown.
- Example reply: [1, 5, 12, 20]
"""


def _llm_boundaries(
    page_texts: list[str],
    api_key: str | None,
    model: str,
    max_chars: int,
) -> list[int]:
    from openai import OpenAI

    effective_key = api_key or os.environ.get("OPENAI_API_KEY")
    if not effective_key:
        raise EnvironmentError(
            "OPENAI_API_KEY environment variable is not set.  "
            "Set it or use strategy='heuristic'."
        )

    client = OpenAI(api_key=effective_key)

    # Build a compact representation of the document for the model
    lines: list[str] = []
    for i, text in enumerate(page_texts, start=1):
        snippet = text.strip()[:max_chars].replace("\n", " ")
        lines.append(f"[Page {i}]: {snippet}")
    content = "\n".join(lines)

    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": content},
        ],
        temperature=0,
        max_tokens=512,
    )

    raw = response.choices[0].message.content.strip()
    # Strip markdown code fences if present
    raw = re.sub(r"^```[a-z]*\n?", "", raw).rstrip("```").strip()
    boundaries = json.loads(raw)
    return _normalise_boundaries(boundaries, len(page_texts))


# ---------------------------------------------------------------------------
# Heuristic strategy
# ---------------------------------------------------------------------------

# Patterns that typically appear at the start of a new document
_COVER_PATTERNS = [
    re.compile(r"^\s*(invoice|contract|agreement|report|letter|memo|proposal|"
               r"statement|order|receipt|certificate|policy|form|appendix|"
               r"exhibit|attachment|resume|curriculum vitae|cv)\b", re.IGNORECASE),
    re.compile(r"^\s*dear\b", re.IGNORECASE),
    re.compile(r"^\s*(to|from|date|subject|re):\s", re.IGNORECASE),
    re.compile(r"^\s*page\s+1\b", re.IGNORECASE),
    re.compile(r"^\s*[A-Z][A-Z\s]{5,}\s*$"),  # ALL-CAPS TITLE LINE
]


def _heuristic_boundaries(page_texts: list[str]) -> list[int]:
    """Identify document boundaries using rule-based heuristics."""
    if not page_texts:
        return [1]

    boundaries = {1}
    avg_len = sum(len(t) for t in page_texts) / max(len(page_texts), 1)

    for i, text in enumerate(page_texts[1:], start=2):  # i is 1-based page number
        stripped = text.strip()

        # Very short page followed by a page with substantial content → boundary
        prev_stripped = page_texts[i - 2].strip()
        if len(prev_stripped) < max(100, avg_len * 0.2) and len(stripped) > 200:
            boundaries.add(i)
            continue

        # Blank page → next page starts new document
        if not prev_stripped and stripped:
            boundaries.add(i)
            continue

        # Cover-page pattern in first 5 lines
        first_lines = "\n".join(stripped.splitlines()[:5])
        for pat in _COVER_PATTERNS:
            if pat.search(first_lines):
                boundaries.add(i)
                break

        # Large drop in page length (≥ 70 %) from an unusually long page
        if avg_len > 0 and len(prev_stripped) > avg_len * 1.5 and len(stripped) < avg_len * 0.3:
            boundaries.add(i)

    return sorted(boundaries)


# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------

def _normalise_boundaries(raw: list, total_pages: int) -> list[int]:
    clean = sorted(set(int(b) for b in raw if 1 <= int(b) <= total_pages))
    if not clean or clean[0] != 1:
        clean = [1] + clean
    return clean
