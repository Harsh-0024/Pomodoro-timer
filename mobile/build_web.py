"""Build the Android app's web folder (mobile/www) from the desktop app's screens.

The desktop app renders templates/ with Flask on every request. The phone has
no Python, so this renders each page once, ahead of time, into plain .html
files, and copies static/ next to them. Anything that changes at run time
(theme, account chip, quotes) is filled in by the page's own JavaScript.

Run from anywhere:  python mobile/build_web.py
"""

from __future__ import annotations

import random
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
    "flow_page": ("flow.html", "flow.html"),
    "settings_page": ("settings.html", "settings.html"),
    "history_page": ("history.html", "history.html"),
    "dashboard_page": ("dashboard.html", "dashboard.html"),
}

# Paths the desktop app's JavaScript navigates to, and the file each one is here.
ROUTES = {"/sign-in": "/sign-in.html", "/flow": "/flow.html", "/settings": "/settings.html",
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
        html = html.replace("<head>", "<head>\n  " + ROUTER % json.dumps(ROUTES), 1)
        (WWW / out).write_text(html, encoding="utf-8")


def main() -> None:
    if WWW.exists():
        shutil.rmtree(WWW)
    WWW.mkdir(parents=True)
    shutil.copytree(ROOT / "static", WWW / "static")
    render_pages()
    print(f"Built {WWW.relative_to(ROOT)} (v{__version__}, {len(PAGES)} pages)")


if __name__ == "__main__":
    main()
