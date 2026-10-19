"""Which timer windows are open, so the app can quit when the last one closes.

Every page checks in about every 30 seconds (static/js/alive.js) and says
goodbye when it closes. Browsers slow the check-ins of hidden or minimized
windows to about once a minute, so a window counts as gone only after
STALE seconds of silence; a goodbye shortens that to GRACE, which is long
enough for the next page to load when moving between Timer and Settings.
"""
from __future__ import annotations

import threading
import time

STALE = 180  # seconds without a check-in before a window counts as closed
GRACE = 15  # after the last window says goodbye or goes stale

_lock = threading.Lock()
_pages: dict[str, float] = {}  # page id -> last check-in
_seen_any = False
_last_change = time.monotonic()


def checked_in(page_id: str):
    global _seen_any, _last_change
    with _lock:
        _pages[page_id] = _last_change = time.monotonic()
        _seen_any = True


def closed(page_id: str):
    global _last_change
    with _lock:
        _pages.pop(page_id, None)
        _last_change = time.monotonic()


def should_quit(now: float | None = None) -> bool:
    """True once a window has been open and none is left.

    Never true before the first check-in, so the app does not quit while
    the window is still opening, or when it was started without one.
    """
    global _last_change
    now = time.monotonic() if now is None else now
    with _lock:
        if not _seen_any:
            return False
        for page_id, seen in list(_pages.items()):
            if now - seen > STALE:
                del _pages[page_id]
                _last_change = max(_last_change, seen + STALE)
        return not _pages and now - _last_change > GRACE
