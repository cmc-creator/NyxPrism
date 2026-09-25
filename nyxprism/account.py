"""NyxPrism account sign-in and plan checks for the desktop app.

Free tools work without an account. Professional tools (AI, OCR, password
protection and the full-screen UI) need a signed-in NyxPrism account with a
Professional plan or an active trial -- the same tiers as nyxprism.com.

Credentials are the Firebase refresh token for the account, stored in
``~/.nyxprism/credentials.json`` (readable only by the current user). The
plan is re-checked against the NyxPrism API at most once a day; if the API is
unreachable, the last successful check is honoured for up to 7 days.
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

# Public web API key of the NyxPrism Firebase project (the same one nyxprism.com uses).
FIREBASE_API_KEY = "AIzaSyD7bj__SwM4gE_yDnM9jjmzOgh6mX4NiD0"
API_BASE = os.environ.get("NYXPRISM_API", "https://nyxprism-production.up.railway.app")
UPGRADE_URL = "https://www.nyxprism.com/dashboard.html"

RECHECK_SECONDS = 24 * 60 * 60
OFFLINE_GRACE_SECONDS = 7 * 24 * 60 * 60
_TIMEOUT = 15


class AccountError(Exception):
    """A user-facing problem with sign-in or the account's plan."""


def _config_dir() -> Path:
    return Path(os.environ.get("NYXPRISM_HOME", Path.home() / ".nyxprism"))


def _credentials_path() -> Path:
    return _config_dir() / "credentials.json"


def _load() -> dict[str, Any] | None:
    try:
        return json.loads(_credentials_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _save(data: dict[str, Any]) -> None:
    path = _credentials_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def _post_json(url: str, payload: dict[str, Any]) -> dict[str, Any]:
    request = urllib.request.Request(
        url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(request, timeout=_TIMEOUT) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        try:
            message = json.loads(exc.read().decode()).get("error", {}).get("message", "")
        except ValueError:
            message = ""
        raise AccountError(_friendly_firebase_error(message)) from None
    except urllib.error.URLError:
        raise AccountError("Could not reach NyxPrism. Check your internet connection.") from None


def _friendly_firebase_error(code: str) -> str:
    if "INVALID_LOGIN_CREDENTIALS" in code or "INVALID_PASSWORD" in code or "EMAIL_NOT_FOUND" in code:
        return "Incorrect email or password."
    if "TOO_MANY_ATTEMPTS" in code:
        return "Too many attempts. Wait a few minutes and try again."
    if "USER_DISABLED" in code:
        return "This account has been disabled. Contact NyxPrism support."
    if "TOKEN_EXPIRED" in code or "INVALID_REFRESH_TOKEN" in code or "USER_NOT_FOUND" in code:
        return "Your sign-in has expired. Run `nyxprism login` again."
    return "Sign-in failed. Please try again."


def login(email: str, password: str) -> dict[str, Any]:
    """Sign in with a NyxPrism account and store the session."""
    result = _post_json(
        f"https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={FIREBASE_API_KEY}",
        {"email": email, "password": password, "returnSecureToken": True},
    )
    data = {
        "email": result.get("email", email),
        "refresh_token": result["refreshToken"],
        "id_token": result["idToken"],
        "id_token_expires": time.time() + int(result.get("expiresIn", 3600)) - 60,
    }
    _save(data)
    return check_plan(force=True)


def logout() -> bool:
    """Forget the stored session. Returns True if one existed."""
    try:
        _credentials_path().unlink()
        return True
    except FileNotFoundError:
        return False


def signed_in_email() -> str | None:
    data = _load()
    return data.get("email") if data else None


def _id_token(data: dict[str, Any]) -> str:
    if data.get("id_token") and data.get("id_token_expires", 0) > time.time():
        return data["id_token"]
    body = urllib.parse.urlencode({"grant_type": "refresh_token", "refresh_token": data["refresh_token"]}).encode()
    request = urllib.request.Request(
        f"https://securetoken.googleapis.com/v1/token?key={FIREBASE_API_KEY}",
        data=body, headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=_TIMEOUT) as response:
            result = json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        try:
            message = json.loads(exc.read().decode()).get("error", {}).get("message", "")
        except ValueError:
            message = ""
        raise AccountError(_friendly_firebase_error(message)) from None
    data["id_token"] = result["id_token"]
    data["refresh_token"] = result.get("refresh_token", data["refresh_token"])
    data["id_token_expires"] = time.time() + int(result.get("expires_in", 3600)) - 60
    _save(data)
    return data["id_token"]


def id_token() -> str:
    """A current Firebase ID token for the signed-in account (refreshed as needed)."""
    data = _load()
    if not data or not data.get("refresh_token"):
        raise AccountError("You're not signed in. Run `nyxprism login` with your NyxPrism account.")
    try:
        return _id_token(data)
    except urllib.error.URLError:
        raise AccountError("Could not reach NyxPrism. Check your internet connection.") from None


def check_plan(force: bool = False) -> dict[str, Any]:
    """Return ``{"email", "plan", "valid", "reason"}`` for the signed-in account.

    Raises AccountError when nobody is signed in.
    """
    data = _load()
    if not data or not data.get("refresh_token"):
        raise AccountError("You're not signed in. Run `nyxprism login` with your NyxPrism account.")

    cached = data.get("license") or {}
    if not force and cached and time.time() - cached.get("checked_at", 0) < RECHECK_SECONDS:
        return {"email": data.get("email"), **cached}

    try:
        token = _id_token(data)
        request = urllib.request.Request(f"{API_BASE}/api/license/verify", headers={"Authorization": f"Bearer {token}"})
        try:
            with urllib.request.urlopen(request, timeout=_TIMEOUT) as response:
                result = json.loads(response.read().decode())
        except urllib.error.HTTPError as exc:
            try:
                result = json.loads(exc.read().decode())
            except ValueError:
                raise AccountError("NyxPrism could not check your plan right now. Try again shortly.") from None
    except AccountError as exc:
        offline = "internet connection" in str(exc) or "check your plan" in str(exc)
        if offline and cached.get("valid") and time.time() - cached.get("checked_at", 0) < OFFLINE_GRACE_SECONDS:
            return {"email": data.get("email"), **cached, "offline": True}
        raise
    except urllib.error.URLError:
        if cached.get("valid") and time.time() - cached.get("checked_at", 0) < OFFLINE_GRACE_SECONDS:
            return {"email": data.get("email"), **cached, "offline": True}
        raise AccountError("Could not reach NyxPrism to check your plan. Connect to the internet and try again.") from None

    license_info = {
        "plan": result.get("plan"),
        "valid": bool(result.get("valid")),
        "reason": result.get("reason"),
        "checked_at": time.time(),
    }
    data["license"] = license_info
    _save(data)
    return {"email": data.get("email"), **license_info}


def require_professional(feature: str) -> dict[str, Any]:
    """Raise AccountError unless the signed-in account may use Professional features."""
    info = check_plan()
    if not info.get("valid"):
        reason = info.get("reason") or "This needs a Professional plan."
        raise AccountError(f"{feature} is a Professional feature. {reason} Upgrade at {UPGRADE_URL}")
    return info
