"""Muhurata launcher: update, install, migrate, serve, open browser.

Double-clicked via the .command/.bat launcher the installer writes, or run
directly with ``python run.py``. Everything is logged to
<data dir>/launcher.log so problems on a friend's machine can be diagnosed.

Flags:
  --no-update   skip the git self-update (used after re-exec, and handy in dev)
  --no-browser  don't open a browser tab
  --doctor      print environment / database diagnostics and exit
"""
from __future__ import annotations

import hashlib
import logging
import logging.handlers
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
FROZEN = getattr(sys, "frozen", False)  # running from a PyInstaller bundle
REMOTE_BRANCH = "origin/main"
# A normal update takes under a second. This is the ceiling for a slow or
# half-dead connection: past it we give up and start the app, and the update
# lands on the next launch instead. Waiting is never the user's problem.
UPDATE_BUDGET = 6.0
UV_DIR = Path.home() / ".muhurata" / "bin"
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
    Every step is time-boxed: a slow connection must not delay startup.
    """
    if FROZEN or not (PROJECT_ROOT / ".git").is_dir():
        log.debug("Not a git checkout; skipping update.")
        return False
    if _run(["git", "--version"]).returncode != 0:
        log.warning("git not found; skipping update check.")
        return False
    if _run(["git", "status", "--porcelain", "--untracked-files=no"]).stdout.strip():
        log.warning("This copy has local changes; skipping update.")
        return False

    deadline = time.monotonic() + UPDATE_BUDGET
    if not _online(timeout=2.0):
        log.info("No internet just now - starting your installed version.")
        return False

    log.info("Checking for updates...")
    before = _run(["git", "rev-parse", "HEAD"]).stdout.strip()
    try:
        fetch = _run(["git", "fetch", "--quiet", "origin"],
                     timeout=max(1.0, deadline - time.monotonic()))
    except subprocess.TimeoutExpired:
        log.info("Slow connection - starting now, I will update next time.")
        return False
    if fetch.returncode != 0:
        log.info("Could not reach GitHub - starting now, I will update next time.")
        return False

    remote = _run(["git", "rev-parse", REMOTE_BRANCH]).stdout.strip()
    if _run(["git", "rev-list", "--count", f"{REMOTE_BRANCH}..HEAD"]).stdout.strip() not in ("", "0"):
        log.warning("This copy is ahead of %s; skipping update.", REMOTE_BRANCH)
        return False
    if before == remote:
        log.info("Already the newest version.")
        return False
    if _run(["git", "reset", "--hard", "--quiet", REMOTE_BRANCH]).returncode != 0:
        log.info("Update did not apply - starting your installed version.")
        return False
    log.info("Updated to the newest version. Restarting...")
    log.debug("%s -> %s", before[:7], remote[:7])
    return True


def _uv() -> str | None:
    local = UV_DIR / ("uv.exe" if sys.platform == "win32" else "uv")
    if local.exists():
        return str(local)
    return shutil.which("uv")


def _wanted_python() -> str | None:
    pin = PROJECT_ROOT / ".python-version"
    try:
        return pin.read_text().strip() or None
    except OSError:
        return None


def ensure_python_version() -> bool:
    """Rebuild the virtualenv when the pinned Python version has changed.

    Lets a new Python version ship like any other change: bump
    .python-version, and each install fetches it on the next launch.
    Returns True if the venv was rebuilt (the caller must then re-exec).
    """
    if FROZEN:
        return False
    want = _wanted_python()
    if not want:
        return False
    have = "%d.%d" % sys.version_info[:2]
    if have == want:
        return False

    uv = _uv()
    if not uv:
        log.warning("This copy needs Python %s (running %s), but the toolchain is missing. "
                    "Re-run the install command to fix it.", want, have)
        return False

    venv = PROJECT_ROOT / ".venv"
    if not venv.exists():
        return False
    log.info("Switching to Python %s - one moment...", want)
    try:
        subprocess.run([uv, "python", "install", want], cwd=PROJECT_ROOT,
                       capture_output=True, timeout=600)
        # --clear replaces the existing venv; --seed keeps pip inside it for
        # install_requirements(). We re-exec immediately afterwards, so pulling
        # the environment out from under this process is safe.
        done = subprocess.run([uv, "venv", "--clear", "--seed", "--python", want, str(venv)],
                              cwd=PROJECT_ROOT, capture_output=True, text=True, timeout=600)
    except (subprocess.TimeoutExpired, OSError) as exc:
        log.warning("Could not switch Python version (%s); continuing on %s.", exc, have)
        return False
    if done.returncode != 0:
        log.warning("Could not switch Python version; continuing on %s.", have)
        log.debug(done.stderr)
        return False
    # The new venv is empty, so the packages must be installed again.
    (_data_dir() / "requirements.sha256").unlink(missing_ok=True)
    log.info("Now on Python %s.", want)
    return True


def install_requirements(data_dir: Path):
    if FROZEN:
        return  # everything is baked into the bundle
    req = PROJECT_ROOT / "requirements.txt"
    digest = hashlib.sha256(req.read_bytes()).hexdigest()
    marker = data_dir / "requirements.sha256"
    if marker.exists() and marker.read_text().strip() == digest:
        return
    log.info("Installing new components - this can take a minute, only this once...")
    uv = _uv()
    cmds = []
    if uv:
        cmds.append([uv, "pip", "install", "--python", sys.executable, "-q", "-r", str(req)])
    cmds.append([sys.executable, "-m", "pip", "install", "--quiet",
                 "--disable-pip-version-check", "-r", str(req)])
    for cmd in cmds:
        if subprocess.run(cmd, cwd=PROJECT_ROOT).returncode == 0:
            break
    else:
        raise RuntimeError("Could not install the required components; see output above.")
    marker.write_text(digest)
    log.info("Done.")


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


def doctor(data_dir: Path) -> int:
    """Print what a friend would need to paste into a bug report."""
    import platform
    import sqlite3

    from version import __version__

    print(f"Muhurata {__version__}{' (bundled)' if FROZEN else ''}")
    print(f"Python    : {sys.version.split()[0]}  ({sys.executable})")
    print(f"OS        : {platform.platform()}")
    print(f"Code dir  : {PROJECT_ROOT}")
    if not FROZEN and (PROJECT_ROOT / ".git").is_dir():
        print(f"Git       : {_run(['git', 'rev-parse', '--short', 'HEAD']).stdout.strip() or '?'}"
              f"{'  (local changes)' if _run(['git', 'status', '--porcelain', '-uno']).stdout.strip() else ''}")
    print(f"Data dir  : {data_dir}")
    print(f"Log file  : {data_dir / 'launcher.log'}")
    print(f"Internet  : {'yes' if _online() else 'no'}")

    db_path = data_dir / "focus_timer.db"
    print(f"Database  : {db_path}")
    if not db_path.exists():
        print("            (not created yet - run the app once)")
        return 0
    print(f"            {db_path.stat().st_size / 1024:.0f} KB")
    conn = sqlite3.connect(db_path)
    try:
        tables = [r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        for t in tables:
            n = conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
            extra = ""
            if t == "alembic_version":
                extra = "  rev " + (conn.execute("SELECT version_num FROM alembic_version").fetchone() or ["?"])[0]
            elif t == "activity_segments" and n:
                lo, hi = conn.execute("SELECT MIN(day), MAX(day) FROM activity_segments").fetchone()
                extra = f"  {lo} .. {hi}"
            print(f"            {t:<20}{n:>7} rows{extra}")
        print(f"            integrity: {conn.execute('PRAGMA integrity_check').fetchone()[0]}")
    finally:
        conn.close()
    backups = sorted((data_dir / "backups").glob("focus_timer-*.db")) if (data_dir / "backups").exists() else []
    print(f"Backups   : {len(backups)}" + (f"  (latest {backups[-1].name})" if backups else ""))
    print("Last sync : n/a (cloud sync not set up)")
    return 0


# --------------------------------------------------------------------------- #
def main(argv: list[str]) -> int:
    no_update = "--no-update" in argv
    open_browser = "--no-browser" not in argv

    data_dir = _data_dir()
    if "--doctor" in argv:
        return doctor(data_dir)
    _setup_logging(data_dir)
    from version import __version__  # noqa: E402

    log.info("---- Muhurata %s start (python %s%s) ----", __version__, sys.version.split()[0], ", bundled" if FROZEN else "")

    if not no_update and self_update():
        # Re-exec so the freshly pulled launcher/app code is what actually runs.
        os.execv(sys.executable, [sys.executable, str(PROJECT_ROOT / "run.py"), "--no-update", *argv[1:]])

    if ensure_python_version():
        new_python = PROJECT_ROOT / ".venv" / ("Scripts" if sys.platform == "win32" else "bin") / "python"
        os.execv(str(new_python), [str(new_python), str(PROJECT_ROOT / "run.py"), "--no-update", *argv[1:]])

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
