"""AI-powered PDF summarization and document classification.

Two strategies are supported for each operation:

1. **LLM** (``strategy="llm"``) – calls an OpenAI-compatible API.  Requires
   ``OPENAI_API_KEY`` to be set.
2. **Heuristic** (``strategy="heuristic"``) – rule-based, no API key needed.
3. **Auto** (``strategy="auto"``) – tries LLM; falls back to heuristic.
"""
from __future__ import annotations

import os
import re
from typing import Literal

# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def summarize_text(
    text: str,
    strategy: Literal["llm", "heuristic", "auto"] = "auto",
    api_key: str | None = None,
    model: str = "gpt-4o-mini",
    max_chars: int = 8000,
    sentences: int = 5,
) -> str:
    """Summarize the given text extracted from a PDF.

    Parameters
    ----------
    text:
        Full (or partial) text content of the document.
    strategy:
        ``"llm"``, ``"heuristic"``, or ``"auto"``.
    api_key:
        OpenAI API key (overrides ``OPENAI_API_KEY`` env var).
    model:
        OpenAI model to use for summarization.
    max_chars:
        Maximum characters of *text* sent to the LLM.
    sentences:
        Target sentence count for the heuristic extractive summary.

    Returns
    -------
    A summary string.
    """
    if strategy == "heuristic":
        return _heuristic_summary(text, sentences=sentences)
    if strategy == "llm":
        return _llm_summary(text, api_key=api_key, model=model,
                            max_chars=max_chars)
    # "auto"
    key = api_key or os.environ.get("OPENAI_API_KEY", "")
    if key:
        try:
            return _llm_summary(text, api_key=api_key, model=model,
                                max_chars=max_chars)
        except Exception:
            pass
    return _heuristic_summary(text, sentences=sentences)


def classify_document(
    text: str,
    strategy: Literal["llm", "heuristic", "auto"] = "auto",
    api_key: str | None = None,
    model: str = "gpt-4o-mini",
    max_chars: int = 3000,
) -> str:
    """Classify the document type of *text*.

    Parameters
    ----------
    text:
        Representative text from the document.
    strategy:
        ``"llm"``, ``"heuristic"``, or ``"auto"``.
    api_key:
        OpenAI API key.
    model:
        OpenAI model name.
    max_chars:
        Maximum characters sent to the LLM.

    Returns
    -------
    A short document-type label such as ``"invoice"``, ``"contract"``,
    ``"report"``, ``"letter"``, etc.
    """
    if strategy == "heuristic":
        return _heuristic_classify(text)
    if strategy == "llm":
        return _llm_classify(text, api_key=api_key, model=model,
                             max_chars=max_chars)
    # "auto"
    key = api_key or os.environ.get("OPENAI_API_KEY", "")
    if key:
        try:
            return _llm_classify(text, api_key=api_key, model=model,
                                 max_chars=max_chars)
        except Exception:
            pass
    return _heuristic_classify(text)


def extract_key_info(
    text: str,
    strategy: Literal["llm", "heuristic", "auto"] = "auto",
    api_key: str | None = None,
    model: str = "gpt-4o-mini",
    max_chars: int = 6000,
) -> dict[str, str]:
    """Extract structured key information from a document.

    Attempts to pull out fields like date, parties involved, amounts,
    reference numbers, subject, and document type.

    Parameters
    ----------
    text:
        Text content of the document.
    strategy:
        ``"llm"``, ``"heuristic"``, or ``"auto"``.
    api_key, model, max_chars:
        Passed to the LLM backend.

    Returns
    -------
    A ``dict`` of field → value strings (values may be ``"unknown"``).
    """
    if strategy == "heuristic":
        return _heuristic_key_info(text)
    if strategy == "llm":
        return _llm_key_info(text, api_key=api_key, model=model,
                             max_chars=max_chars)
    # "auto"
    key = api_key or os.environ.get("OPENAI_API_KEY", "")
    if key:
        try:
            return _llm_key_info(text, api_key=api_key, model=model,
                                 max_chars=max_chars)
        except Exception:
            pass
    return _heuristic_key_info(text)


# ---------------------------------------------------------------------------
# LLM helpers
# ---------------------------------------------------------------------------

_SUMMARY_SYSTEM = (
    "You are a document summarization assistant. "
    "Summarize the provided document text in a concise, informative paragraph. "
    "Focus on the key information, purpose, and important details. "
    "Keep the summary to 3-5 sentences unless the document is very complex. "
    "Do NOT include any preamble like 'This document is about...' — just the summary."
)

_CLASSIFY_SYSTEM = (
    "You are a document classification assistant. "
    "Classify the document into exactly ONE of these types: "
    "invoice, contract, agreement, report, letter, memo, proposal, statement, "
    "order, receipt, certificate, policy, form, resume, manual, specification, "
    "minutes, agenda, budget, notice, email, or 'other'. "
    "Reply with ONLY the document type label, nothing else."
)

_KEY_INFO_SYSTEM = """You are a document information extraction assistant.
Extract key structured information from the provided document text.
Reply with ONLY a JSON object containing these fields (use "unknown" if not found):
{
  "document_type": "...",
  "date": "...",
  "parties": "...",
  "subject": "...",
  "reference_number": "...",
  "amount": "...",
  "summary": "..."
}
Do NOT include any explanation or markdown fences."""


def _llm_summary(text: str, api_key: str | None, model: str, max_chars: int) -> str:
    from openai import OpenAI

    effective_key = api_key or os.environ.get("OPENAI_API_KEY")
    if not effective_key:
        raise EnvironmentError("OPENAI_API_KEY is not set.")

    client = OpenAI(api_key=effective_key)
    snippet = text.strip()[:max_chars]

    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": _SUMMARY_SYSTEM},
            {"role": "user", "content": snippet},
        ],
        temperature=0.3,
        max_tokens=256,
    )
    return response.choices[0].message.content.strip()


def _llm_classify(text: str, api_key: str | None, model: str,
                  max_chars: int) -> str:
    from openai import OpenAI

    effective_key = api_key or os.environ.get("OPENAI_API_KEY")
    if not effective_key:
        raise EnvironmentError("OPENAI_API_KEY is not set.")

    client = OpenAI(api_key=effective_key)
    snippet = text.strip()[:max_chars]

    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": _CLASSIFY_SYSTEM},
            {"role": "user", "content": snippet},
        ],
        temperature=0,
        max_tokens=16,
    )
    return response.choices[0].message.content.strip().lower()


def _llm_key_info(text: str, api_key: str | None, model: str,
                  max_chars: int) -> dict[str, str]:
    import json
    from openai import OpenAI

    effective_key = api_key or os.environ.get("OPENAI_API_KEY")
    if not effective_key:
        raise EnvironmentError("OPENAI_API_KEY is not set.")

    client = OpenAI(api_key=effective_key)
    snippet = text.strip()[:max_chars]

    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": _KEY_INFO_SYSTEM},
            {"role": "user", "content": snippet},
        ],
        temperature=0,
        max_tokens=256,
    )
    raw = response.choices[0].message.content.strip()
    raw = re.sub(r"^```[a-z]*\n?", "", raw).rstrip("`").strip()
    try:
        return json.loads(raw)
    except Exception:
        return _heuristic_key_info(text)


# ---------------------------------------------------------------------------
# Heuristic helpers
# ---------------------------------------------------------------------------

_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")

_CLASSIFY_KEYWORDS: dict[str, list[str]] = {
    "invoice": ["invoice", "bill to", "amount due", "payment due", "tax invoice",
                "invoice #", "invoice no"],
    "contract": ["contract", "parties agree", "whereas", "in witness whereof",
                 "this agreement"],
    "agreement": ["agreement", "terms and conditions", "hereby agree", "this agreement"],
    "report": ["report", "findings", "conclusion", "executive summary",
               "analysis", "results"],
    "letter": ["dear ", "sincerely", "regards", "yours truly",
               "to whom it may concern"],
    "memo": ["memorandum", "memo to", "to:", "from:", "re:"],
    "proposal": ["proposal", "we propose", "scope of work", "deliverables",
                 "proposed solution"],
    "resume": ["curriculum vitae", "work experience", "education", "skills",
               "references available"],
    "receipt": ["receipt", "total paid", "payment received",
                "thank you for your purchase"],
    "policy": ["policy", "procedure", "guidelines", "compliance", "regulation"],
    "form": ["please complete", "fill in", "applicant", "date of birth",
             "please print"],
    "minutes": ["minutes of", "meeting minutes", "attendees", "action items"],
    "specification": ["specification", "requirements", "shall", "technical spec"],
    "budget": ["budget", "fiscal year", "allocation", "expenditure", "revenue"],
    "certificate": ["certificate", "this is to certify", "awarded to", "hereby certify"],
    "manual": ["user manual", "operating manual", "instructions", "getting started",
               "table of contents"],
}

_DATE_RE = re.compile(
    r"\b(\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{1,2}[-./]\d{1,2}[-./]\d{4})\b"
)
_AMOUNT_RE = re.compile(r"[\$£€¥]\s*[\d,]+(?:\.\d{2})?")
_REF_RE = re.compile(
    r"\b(?:invoice|ref|reference|order|po|case|ticket|#|no\.?)\s*[:#]?\s*([A-Z0-9\-]{3,20})\b",
    re.IGNORECASE,
)


def _heuristic_summary(text: str, sentences: int = 5) -> str:
    """Return an extractive summary (first *sentences* meaningful sentences)."""
    cleaned = " ".join(text.split())
    all_sentences = _SENTENCE_END.split(cleaned)
    good = [s.strip() for s in all_sentences if len(s.strip().split()) >= 6]
    selected = good[:sentences] if len(good) >= sentences else good
    if not selected:
        return text.strip()[:400]
    return " ".join(selected)


def _heuristic_classify(text: str) -> str:
    """Classify document type via keyword frequency scoring."""
    lower = text.lower()
    scores: dict[str, int] = {}
    for doc_type, keywords in _CLASSIFY_KEYWORDS.items():
        score = sum(1 for kw in keywords if kw in lower)
        if score:
            scores[doc_type] = score
    if not scores:
        return "other"
    return max(scores, key=lambda k: scores[k])


def _heuristic_key_info(text: str) -> dict[str, str]:
    """Extract key information using regex patterns."""
    date_match = _DATE_RE.search(text)
    amount_matches = _AMOUNT_RE.findall(text)
    ref_match = _REF_RE.search(text)

    lines = [l.strip() for l in text.splitlines() if l.strip()]
    subject = lines[0][:80] if lines else "unknown"

    return {
        "document_type": _heuristic_classify(text),
        "date": date_match.group(0) if date_match else "unknown",
        "parties": "unknown",
        "subject": subject,
        "reference_number": ref_match.group(1) if ref_match else "unknown",
        "amount": amount_matches[0] if amount_matches else "unknown",
        "summary": _heuristic_summary(text, sentences=3),
    }
