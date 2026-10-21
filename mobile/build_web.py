"""Build the Android app's web folder (mobile/www) from the desktop app's screens.

The desktop app renders templates/ with Flask on every request. The phone has
no Python, so this renders each page once, ahead of time, into plain .html
files, and copies static/ next to them. Anything that changes at run time
(theme, account chip, quotes) is filled in by the page's own JavaScript.

Run from anywhere:  python mobile/build_web.py
"""

from __future__ import annotations

import random
import re
import shutil
import sys
from pathlib import Path
from types import SimpleNamespace

from jinja2 import Environment, FileSystemLoader

ROOT = Path(__file__).resolve().parent.parent
MOBILE = ROOT / "mobile"
WWW = MOBILE / "www"
sys.path.insert(0, str(ROOT))

from version import __version__  # noqa: E402

# Flask endpoint -> (template, file in www/). index.html doubles as the router.
PAGES = {
    "index": ("index.html", "index.html"),
    "sign_in_page": ("sign_in.html", "sign-in.html"),
    "timer_page": ("timer.html", "timer.html"),
    "flow_page": ("flow.html", "flow.html"),
    "settings_page": ("settings.html", "settings.html"),
    "history_page": ("history.html", "history.html"),
    "dashboard_page": ("dashboard.html", "dashboard.html"),
}

# Paths the desktop app's JavaScript navigates to, and the file each one is here.
ROUTES = {"/sign-in": "/sign-in.html", "/timer": "/timer.html", "/flow": "/flow.html", "/settings": "/settings.html",
          "/settings/history": "/history.html", "/dashboard": "/dashboard.html"}

PASSWORD_SITE = "harsh-0024.github.io/muhurta-pomodoro"
EMAIL_FROM = "muhurata.pomodoro.timer@gmail.com"

# Runs first on every page: an address like /settings (from the desktop app's
# JavaScript) lands on index.html, so send it on to the page's own file.
ROUTER = """<script>
  (function () {
    var routes = %s;
    var to = routes[location.pathname.replace(/\\/+$/, "")];
    if (to) location.replace(to + location.search + location.hash);
  })();
</script>"""


LOCAL_API = """
  <script src="/mobile-data.js"></script>
  <script src="/local-api.js"></script>
  <script src="/account.js"></script>
  <script src="/alerts.js"></script>"""


def url_for(endpoint: str, filename: str | None = None, **_):
    if endpoint == "static":
        return f"/static/{filename}"
    return "/" + PAGES[endpoint][1].replace("index.html", "")


def render_pages() -> None:
    import json
    import os
    import tempfile

    # app.py is imported only for its quote list; keep it away from real data.
    os.environ["MUHURATA_DATA_DIR"] = tempfile.mkdtemp(prefix="muhurta-build-")
    from app import FALLBACK_QUOTES  # noqa: E402

    env = Environment(loader=FileSystemLoader(ROOT / "templates"), autoescape=True)
    quote = random.choice(FALLBACK_QUOTES)
    for endpoint, (template, out) in PAGES.items():
        html = env.get_template(template).render(
            url_for=url_for,
            request=SimpleNamespace(endpoint=endpoint),
            asset_version=__version__,
            app_version=__version__,
            theme="system",
            account=None,
            bare=endpoint == "sign_in_page",
            initial_quote=quote,
            mobile=True,
            password_site=PASSWORD_SITE,
            email_from=EMAIL_FROM,
            pending_email="",
            pending_has_profile=False,
        )
        # The fonts ship inside the app (mobile/web/fonts): no waiting on Google
        # before the page draws, and the same look offline.
        html = re.sub(r'\s*<link rel="preconnect" href="https://fonts\.(googleapis|gstatic)\.com"[^>]*/>', "", html)
        html = re.sub(r'<link href="https://fonts\.googleapis\.com/css2[^"]*" rel="stylesheet" />',
                      '<link href="/fonts/fonts.css" rel="stylesheet" />', html)
        # First in <head>: the router, then the phone's own /api (local-api.js).
        head = ROUTER % json.dumps(ROUTES) + LOCAL_API
        html = html.replace("<head>", "<head>\n  " + head, 1)
        (WWW / out).write_text(html, encoding="utf-8")


def write_data() -> None:
    """mobile-data.js: the fixed data local-api.js needs, taken from the Python
    files so there is only one copy of each."""
    import json

    import cloud
    import db
    import release_notes
    from app import DOWNLOAD_PAGE, FALLBACK_QUOTES, RELEASES_API, SOUND_CHOICES, SOUND_SETTING_KEYS, UPDATE_POLICY_URL
    from presets import BUILTINS

    data = {
        "version": __version__,
        "builtins": BUILTINS,
        "default_settings": db.DEFAULT_SETTINGS,
        "sound_choices": sorted(SOUND_CHOICES),
        "sound_setting_keys": list(SOUND_SETTING_KEYS),
        "long_segment_sec": db.LONG_SEGMENT_SEC,
        "productive_kinds": list(db.PRODUCTIVE_KINDS),
        "rest_kinds": list(db.REST_KINDS),
        "notes": release_notes.NOTES,
        "quotes": FALLBACK_QUOTES,
        # Where the phone hears about updates (app.py), and where it gets them.
        "releases_api": RELEASES_API,
        "update_policy_url": UPDATE_POLICY_URL,
        "download_page": DOWNLOAD_PAGE + "?os=android",
        # MUHURATA_SUPABASE_URL / _KEY build a copy for a test server.
        "supabase_url": cloud.SUPABASE_URL,
        "supabase_key": cloud.SUPABASE_KEY,
    }
    (WWW / "mobile-data.js").write_text(
        "// Built by mobile/build_web.py from the Python files. Do not edit.\n"
        f"window.__MUHURTA__ = {json.dumps(data, ensure_ascii=False)};\n",
        encoding="utf-8",
    )
    for name in ("local-api.js", "account.js", "alerts.js"):
        shutil.copy2(MOBILE / "web" / name, WWW / name)
    shutil.copytree(MOBILE / "web" / "fonts", WWW / "fonts")


def main() -> None:
    if WWW.exists():
        shutil.rmtree(WWW)
    WWW.mkdir(parents=True)
    shutil.copytree(ROOT / "static", WWW / "static")
    render_pages()
    write_data()
    print(f"Built {WWW.relative_to(ROOT)} (v{__version__}, {len(PAGES)} pages)")


if __name__ == "__main__":
    main()
