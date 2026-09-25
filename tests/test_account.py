"""Desktop app uses the same Free / Professional tiers as nyxprism.com."""
import io
import json
import time
import urllib.error

import pytest
from click.testing import CliRunner
from pypdf import PdfWriter

from nyxprism import account
from nyxprism.cli.main import cli


class _Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("NYXPRISM_HOME", str(tmp_path))
    pdf = tmp_path / "in.pdf"
    writer = PdfWriter()
    writer.add_blank_page(200, 200)
    writer.write(str(pdf))
    state = {"license": {"valid": True, "plan": "professional", "reason": None}, "offline": False}

    def fake_urlopen(request, timeout=None):
        url = request.full_url
        if "signInWithPassword" in url:
            return _Response(json.dumps({"email": "pro@example.com", "idToken": "id", "refreshToken": "rt", "expiresIn": "3600"}).encode())
        if "license/verify" in url:
            if state["offline"]:
                raise urllib.error.URLError("offline")
            return _Response(json.dumps(state["license"]).encode())
        raise AssertionError(f"unexpected request {url}")

    monkeypatch.setattr(account.urllib.request, "urlopen", fake_urlopen)
    return tmp_path, pdf, state


def test_free_tools_work_without_an_account(env):
    tmp, pdf, _ = env
    result = CliRunner().invoke(cli, ["rotate", str(pdf), "--degrees", "90", "--output", str(tmp / "out.pdf")])
    assert result.exit_code == 0
    assert (tmp / "out.pdf").exists()


def test_professional_tools_need_sign_in(env):
    _, pdf, _ = env
    result = CliRunner().invoke(cli, ["protect", str(pdf), "--password", "secret"])
    assert result.exit_code == 1
    assert "nyxprism login" in result.output


def test_professional_plan_unlocks_and_free_plan_is_told_to_upgrade(env):
    tmp, pdf, state = env
    runner = CliRunner()
    assert runner.invoke(cli, ["login", "--email", "pro@example.com", "--password", "pw"]).exit_code == 0
    ok = runner.invoke(cli, ["protect", str(pdf), "--password", "secret", "--output", str(tmp / "locked.pdf")])
    assert ok.exit_code == 0 and (tmp / "locked.pdf").exists()

    state["license"] = {"valid": False, "plan": "free", "reason": "Professional features need an active subscription."}
    account.check_plan(force=True)
    blocked = runner.invoke(cli, ["ocr", str(pdf)])
    assert blocked.exit_code == 1
    assert "Professional feature" in blocked.output and "nyxprism.com" in blocked.output


def test_offline_grace_is_limited_to_seven_days(env):
    tmp, _, state = env
    account.login("pro@example.com", "pw")
    state["offline"] = True
    creds = tmp / "credentials.json"

    data = json.loads(creds.read_text())
    data["license"]["checked_at"] = time.time() - 2 * 86400
    creds.write_text(json.dumps(data))
    assert account.require_professional("x")["offline"] is True

    data["license"]["checked_at"] = time.time() - 9 * 86400
    creds.write_text(json.dumps(data))
    with pytest.raises(account.AccountError):
        account.require_professional("x")


def test_ai_uses_nyxprism_when_signed_in_and_own_key_when_given(env, monkeypatch):
    from nyxprism.ai import llm

    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    assert llm.llm_available() is False  # signed out, no key: heuristics only
    account.login("pro@example.com", "pw")
    assert llm.llm_available() is True

    calls = []
    monkeypatch.setattr(llm, "_nyxprism_chat", lambda system, user, max_tokens: calls.append("nyxprism") or "Named_By_NyxPrism")
    assert llm.chat("sys", "text") == "Named_By_NyxPrism"

    import types
    import openai
    reply = types.SimpleNamespace(choices=[types.SimpleNamespace(message=types.SimpleNamespace(content="Named_By_Own_Key"))])
    monkeypatch.setattr(openai, "OpenAI", lambda api_key=None: types.SimpleNamespace(
        chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=lambda **kw: reply))))
    assert llm.chat("sys", "text", api_key="sk-own") == "Named_By_Own_Key"
    assert calls == ["nyxprism"]
