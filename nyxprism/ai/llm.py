"""One place for every AI call the desktop app makes.

* **NyxPrism AI (default)** -- included with a Professional plan. Requests go
  through the NyxPrism API using the signed-in account (``nyxprism login``),
  so there is nothing extra to set up.
* **Your own OpenAI key (optional)** -- pass ``api_key=`` / ``--api-key`` or set
  ``OPENAI_API_KEY`` and requests go straight to OpenAI instead.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

from nyxprism import account

MAX_INPUT_CHARS = 40_000


def own_key(api_key: str | None) -> str:
    return api_key or os.environ.get("OPENAI_API_KEY", "")


def llm_available(api_key: str | None = None) -> bool:
    """True when an AI backend can be used: the user's own key, or a signed-in account."""
    return bool(own_key(api_key)) or account.signed_in_email() is not None


def chat(system: str, user: str, *, api_key: str | None = None, model: str = "gpt-4o-mini",
         max_tokens: int = 256, temperature: float = 0) -> str:
    """Send one system + user prompt and return the reply text."""
    key = own_key(api_key)
    if key:
        from openai import OpenAI

        response = OpenAI(api_key=key).chat.completions.create(
            model=model,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            temperature=temperature,
            max_tokens=max_tokens,
        )
        return (response.choices[0].message.content or "").strip()

    if account.signed_in_email() is None:
        raise EnvironmentError(
            "AI needs a Professional NyxPrism account (run `nyxprism login`) "
            "or your own OpenAI key (--api-key / OPENAI_API_KEY)."
        )
    return _nyxprism_chat(system, user, max_tokens)


def _nyxprism_chat(system: str, user: str, max_tokens: int) -> str:
    token = account.id_token()
    body = json.dumps({"system": system, "input": user[:MAX_INPUT_CHARS], "maxTokens": max_tokens}).encode()
    request = urllib.request.Request(
        f"{account.API_BASE}/api/ai/desktop", data=body, method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return (json.loads(response.read().decode()).get("reply") or "").strip()
    except urllib.error.HTTPError as exc:
        try:
            message = json.loads(exc.read().decode()).get("error") or ""
        except ValueError:
            message = ""
        raise RuntimeError(message or f"NyxPrism AI request failed ({exc.code}).") from None
    except urllib.error.URLError:
        raise RuntimeError("Could not reach NyxPrism AI. Check your internet connection.") from None
