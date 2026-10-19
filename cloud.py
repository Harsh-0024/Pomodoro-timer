"""Signing in to the Muhurata cloud account (Supabase Auth).

Sign-in is by email code: the person types their email, Supabase emails a
code, they type the code back. No passwords exist anywhere.

The resulting session (an access token that lasts an hour, and a refresh
token that renews it) is kept in cloud_session.json next to the database,
readable only by this user. Everything here talks to Supabase over HTTPS
with the project's publishable key; the own-rows-only rules in
supabase/schema.sql are what keep one person's data from another.
"""
from __future__ import annotations

import json
import os
import re
import ssl
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import db

# The project's address and publishable key are meant to ship inside the
# app: the publishable key only identifies the project, and the own-rows
# rules decide what anyone can read. Never put a "secret" or "service_role"
# key here. The environment variables exist for testing against another
# project.
SUPABASE_URL = os.environ.get("MUHURATA_SUPABASE_URL", "https://ybjyzvtilicsncuiujks.supabase.co").rstrip("/")
SUPABASE_KEY = os.environ.get("MUHURATA_SUPABASE_KEY", "sb_publishable_YDL_wTS1iPM9bKHpR6yP7g_o8pnFBDk")

TIMEOUT = 15  # seconds; a slow connection should fail, not hang
REFRESH_EARLY = 120  # renew the access token this many seconds before it expires
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
CODE_RE = re.compile(r"^\d{6,10}$")

# Our own list of trusted certificates, so HTTPS works however Python was
# installed. The python.org Mac installer and some frozen builds ship
# without one, and every secure connection then fails.
try:
    import certifi

    _SSL = ssl.create_default_context(cafile=certifi.where())
except ImportError:  # pragma: no cover - certifi is in requirements.txt
    _SSL = ssl.create_default_context()

_lock = threading.Lock()  # one refresh at a time (the sync thread and a page may race)


class CloudError(Exception):
    """Something the person should be told, in words they can act on."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


class Offline(CloudError):
    def __init__(self):
        super().__init__("No internet connection right now. Try again when you are online.", 503)


def configured() -> bool:
    return bool(SUPABASE_URL and SUPABASE_KEY)


def _session_path() -> Path:
    return db.DB_PATH.parent / "cloud_session.json"


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
def _request(method: str, path: str, body: dict | None = None, token: str | None = None):
    """Call Supabase Auth. Returns (status, parsed JSON or None)."""
    if not configured():
        raise CloudError("Sync is not available in this version of the app.", 503)
    headers = {"apikey": SUPABASE_KEY, "Accept": "application/json"}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(f"{SUPABASE_URL}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT, context=_SSL) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            return exc.code, json.loads(raw) if raw else None
        except ValueError:
            return exc.code, None
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, ssl.SSLError):
            # Online, but the connection could not be verified as secure.
            raise CloudError("Couldn't make a secure connection to the sync service. "
                             "Check the date and time on this computer, then try again.", 502) from None
        raise Offline() from None
    except (TimeoutError, OSError):
        raise Offline() from None


def _error_text(payload) -> str:
    if not isinstance(payload, dict):
        return ""
    return " ".join(str(payload.get(k) or "") for k in ("error_code", "code", "error", "msg", "message", "error_description")).lower()


# --------------------------------------------------------------------------- #
# session file
# --------------------------------------------------------------------------- #
def _load() -> dict | None:
    try:
        data = json.loads(_session_path().read_text())
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and data.get("refresh_token") else None


def _save(payload: dict) -> dict:
    user = payload.get("user") or {}
    expires_at = payload.get("expires_at") or (time.time() + int(payload.get("expires_in") or 3600))
    session = {
        "access_token": payload["access_token"],
        "refresh_token": payload["refresh_token"],
        "expires_at": int(expires_at),
        "user_id": user.get("id"),
        "email": user.get("email"),
    }
    path = _session_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    # Created private (owner read/write only), then swapped in, so a crash
    # mid-write never leaves a half-written or world-readable file.
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(session, fh)
    os.replace(tmp, path)
    return session


def _forget():
    _session_path().unlink(missing_ok=True)


# --------------------------------------------------------------------------- #
# public API
# --------------------------------------------------------------------------- #
def status() -> dict:
    """What Settings shows. Never touches the network."""
    session = _load()
    return {
        "configured": configured(),
        "signed_in": session is not None,
        "email": session.get("email") if session else None,
    }


def send_code(email: str) -> None:
    email = (email or "").strip().lower()
    if not EMAIL_RE.match(email):
        raise CloudError("That doesn't look like an email address.")
    code, payload = _request("POST", "/auth/v1/otp", {"email": email, "create_user": True})
    if code == 429 or "rate" in _error_text(payload):
        raise CloudError("Too many codes asked for. Wait a minute, then try again.", 429)
    if code >= 400:
        raise CloudError("The code could not be sent. Check the address and try again.", 502)


def verify_code(email: str, code: str) -> dict:
    email = (email or "").strip().lower()
    code = re.sub(r"\s+", "", code or "")
    if not CODE_RE.match(code):
        raise CloudError("The code is the number in the email, 6 digits or more.")
    status_code, payload = _request("POST", "/auth/v1/verify", {"type": "email", "email": email, "token": code})
    if status_code == 429:
        raise CloudError("Too many tries. Wait a minute, then try again.", 429)
    if status_code >= 400 or not isinstance(payload, dict) or "access_token" not in payload:
        raise CloudError("That code is wrong or has expired. Ask for a new one if it is over an hour old.")
    with _lock:
        _save(payload)
    return status()


def access_token() -> str | None:
    """A valid access token, renewed if needed. None when signed out.

    Raises Offline when the token needs renewing but there is no connection;
    the caller (sync) simply tries again later.
    """
    with _lock:
        session = _load()
        if session is None:
            return None
        if session["expires_at"] - REFRESH_EARLY > time.time():
            return session["access_token"]
        code, payload = _request("POST", "/auth/v1/token?grant_type=refresh_token",
                                 {"refresh_token": session["refresh_token"]})
        if code < 400 and isinstance(payload, dict) and "access_token" in payload:
            # Supabase may leave out the user on refresh; keep what we know.
            payload.setdefault("user", {"id": session["user_id"], "email": session["email"]})
            return _save(payload)["access_token"]
        if code in (400, 401, 403):
            # The refresh token was revoked or expired (signed out elsewhere,
            # account deleted). Sign out here too, rather than retrying forever.
            _forget()
            return None
        raise CloudError("The sync service is having trouble. It will try again later.", 502)


def user_id() -> str | None:
    session = _load()
    return session.get("user_id") if session else None


def sign_out() -> dict:
    with _lock:
        session = _load()
        if session:
            try:
                _request("POST", "/auth/v1/logout", {}, token=session["access_token"])
            except CloudError:
                pass  # offline or already invalid: forgetting locally is what matters
        _forget()
    return status()
