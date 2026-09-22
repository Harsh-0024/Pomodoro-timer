"""Muhurata launcher: update, install, migrate, serve, open browser.

Double-clicked via the .command/.bat launcher the installer writes, or run
directly with ``python run.py``. Everything is logged to
<data dir>/launcher.log so problems on a friend's machine can be diagnosed.

Flags:
  --no-update   skip the git self-update (used after re-exec, and handy in dev)
  --no-browser  don't open a browser tab
"""
from __future__ import annotations

import hashlib
import logging
import logging.handlers
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
REMOTE_BRANCH = "origin/main"
FIRST_PORT = 8000
HOST = "127.0.0.1"

log = logging.getLogger("muhurata.launcher")


# --------------------------------------------------------------------------- #
# setup
# --------------------------------------------------------------------------- #
def _data_dir() -> Path:
    # Same locations platformdirs.user_data_dir("MuhurataTimer", appauthor=False)
    # resolves to, computed by hand because platformdirs isn't installed yet on
    # the very first run.
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "MuhurataTimer"
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "MuhurataTimer"
    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(base) / "MuhurataTimer"


def _setup_logging(data_dir: Path):
    data_dir.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)-5s %(message)s", "%Y-%m-%d %H:%M:%S")
    file_h = logging.handlers.RotatingFileHandler(
        data_dir / "launcher.log", maxBytes=512_000, backupCount=2, encoding="utf-8"
    )
    file_h.setFormatter(fmt)
    console = logging.StreamHandler(sys.stderr)
    console.setFormatter(logging.Formatter("%(message)s"))
    # Per-request lines go to the file only; the console stays readable.
    console.addFilter(lambda r: not r.name.startswith("werkzeug"))
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(file_h)
    root.addHandler(console)
    logging.getLogger("alembic").setLevel(logging.WARNING)


def _run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    log.debug("$ %s", " ".join(cmd))
    return subprocess.run(cmd, cwd=PROJECT_ROOT, capture_output=True, text=True, **kw)


# --------------------------------------------------------------------------- #
# steps
# --------------------------------------------------------------------------- #
def _online(timeout: float = 3.0) -> bool:
    try:
        socket.create_connection(("github.com", 443), timeout=timeout).close()
        return True
    except OSError:
        return False


def self_update() -> bool:
    """Fast-forward the checkout to origin/main. Returns True if code changed.

    Uses fetch + reset --hard rather than pull so a friend's copy can never
    end up in a merge conflict. Skipped when the tree has local edits or
    unpushed commits, which protects a developer checkout from being wiped.
    """
    if not (PROJECT_ROOT / ".git").is_dir():
        log.info("Not a git checkout; skipping update.")
        return False
    if _run(["git", "--version"]).returncode != 0:
        log.warning("git not found; skipping update.")
        return False
    if _run(["git", "status", "--porcelain", "--untracked-files=no"]).stdout.strip():
        log.warning("Local changes present; skipping update.")
        return False
    if not _online():
        log.info("Offline; running the installed version.")
        return False

    before = _run(["git", "rev-parse", "HEAD"]).stdout.strip()
    fetch = _run(["git", "fetch", "--quiet", "origin"], timeout=60)
    if fetch.returncode != 0:
        log.warning("git fetch failed: %s", fetch.stderr.strip())
        return False
    remote = _run(["git", "rev-parse", REMOTE_BRANCH]).stdout.strip()
    if _run(["git", "rev-list", "--count", f"{REMOTE_BRANCH}..HEAD"]).stdout.strip() not in ("", "0"):
        log.warning("Local commits ahead of %s; skipping update.", REMOTE_BRANCH)
        return False
    if before == remote:
        log.info("Already up to date (%s).", before[:7])
        return False
    reset = _run(["git", "reset", "--hard", "--quiet", REMOTE_BRANCH])
    if reset.returncode != 0:
        log.warning("git reset failed: %s", reset.stderr.strip())
        return False
    log.info("Updated %s -> %s", before[:7], remote[:7])
    return True


def install_requirements(data_dir: Path):
    req = PROJECT_ROOT / "requirements.txt"
    digest = hashlib.sha256(req.read_bytes()).hexdigest()
    marker = data_dir / "requirements.sha256"
    if marker.exists() and marker.read_text().strip() == digest:
        return
    log.info("Installing Python packages (first run or requirements changed)...")
    proc = subprocess.run(
        [sys.executable, "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "-r", str(req)],
        cwd=PROJECT_ROOT,
    )
    if proc.returncode != 0:
        raise RuntimeError("pip install failed; see output above.")
    marker.write_text(digest)
    log.info("Packages installed.")


def free_port(start: int = FIRST_PORT, attempts: int = 50) -> int:
    for port in range(start, start + attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((HOST, port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"No free port found in {start}-{start + attempts}")


def _open_when_ready(url: str, open_browser: bool):
    for _ in range(100):  # ~20s
        try:
            with urllib.request.urlopen(url, timeout=1) as resp:
                if resp.status == 200:
                    break
        except Exception:
            time.sleep(0.2)
    else:
        log.warning("Server did not respond in time; open %s manually.", url)
        return
    log.info("Muhurata is running at %s  (Ctrl+C or close this window to stop)", url)
    if open_browser:
        webbrowser.open(url)


# --------------------------------------------------------------------------- #
def main(argv: list[str]) -> int:
    no_update = "--no-update" in argv
    open_browser = "--no-browser" not in argv

    data_dir = _data_dir()
    _setup_logging(data_dir)
    log.info("---- launcher start (python %s) ----", sys.version.split()[0])

    if not no_update and self_update():
        # Re-exec so the freshly pulled launcher/app code is what actually runs.
        log.info("Restarting with updated code...")
        os.execv(sys.executable, [sys.executable, str(PROJECT_ROOT / "run.py"), "--no-update", *argv[1:]])

    install_requirements(data_dir)

    sys.path.insert(0, str(PROJECT_ROOT))
    import db  # noqa: E402

    db.init_db()  # applies any pending migrations (with backup)

    from app import app  # noqa: E402

    from werkzeug.serving import make_server  # noqa: E402

    port = free_port()
    url = f"http://{HOST}:{port}/"
    # make_server rather than app.run: no "development server" banner, and
    # the request log goes through logging (file) instead of raw stderr.
    server = make_server(HOST, port, app, threaded=True)
    threading.Thread(target=_open_when_ready, args=(url, open_browser), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    log.info("Stopped.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except Exception:
        log.exception("Launcher failed")
        print("\nSomething went wrong. The log is at:", _data_dir() / "launcher.log", file=sys.stderr)
        if sys.stdin and sys.stdin.isatty():
            input("Press Enter to close...")
        sys.exit(1)
