import json
import sqlite3
from pathlib import Path

DEFAULT_SETTINGS = {
    "auto_start_work": False,
    "auto_start_break": True,
    "sound_enabled": True,
    "sound_volume": 70,
    "sound_profile": "balanced",
    "tick_sound_enabled": False,
    "chime_work_end": True,
    "chime_break_end": True,
    "chime_session_start": True,
    "chime_pool_add": True,
    "chime_choice": True,
    "chime_skip": True,
    "notifications_enabled": True,
    "default_preset_id": "builtin-navin",
    "daily_focus_goal_minutes": 120,
    "theme": "dark",
}

DB_PATH = Path(__file__).resolve().parent / "data" / "focus_timer.db"


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS app_settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                json TEXT NOT NULL DEFAULT '{}'
            );
            INSERT OR IGNORE INTO app_settings (id, json) VALUES (1, '{}');

            CREATE TABLE IF NOT EXISTS custom_presets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                work_min INTEGER NOT NULL,
                short_rest_min INTEGER NOT NULL,
                long_rest_min INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS daily_focus (
                day TEXT PRIMARY KEY,
                minutes INTEGER NOT NULL DEFAULT 0
            );
            """
        )
        conn.commit()
    finally:
        conn.close()


def load_settings() -> dict:
    init_db()
    conn = sqlite3.connect(DB_PATH)
    try:
        row = conn.execute(
            "SELECT json FROM app_settings WHERE id = 1"
        ).fetchone()
        raw = row[0] if row else "{}"
        data = json.loads(raw)
    finally:
        conn.close()
    return {**DEFAULT_SETTINGS, **data}


def save_settings(partial: dict) -> dict:
    current = load_settings()
    merged = {**current, **partial}
    for k, v in list(merged.items()):
        if k not in DEFAULT_SETTINGS:
            merged.pop(k, None)
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(
            "UPDATE app_settings SET json = ? WHERE id = 1",
            (json.dumps(merged),),
        )
        conn.commit()
    finally:
        conn.close()
    return merged


def list_custom_presets():
    init_db()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            SELECT id, name, work_min, short_rest_min, long_rest_min, created_at
            FROM custom_presets ORDER BY id ASC
            """
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def create_custom_preset(name: str, work_min: int, short_rest_min: int, long_rest_min: int) -> dict:
    init_db()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        cur = conn.execute(
            """
            INSERT INTO custom_presets (name, work_min, short_rest_min, long_rest_min)
            VALUES (?, ?, ?, ?)
            """,
            (name.strip(), work_min, short_rest_min, long_rest_min),
        )
        conn.commit()
        pid = cur.lastrowid
        row = conn.execute(
            """
            SELECT id, name, work_min, short_rest_min, long_rest_min, created_at
            FROM custom_presets WHERE id = ?
            """,
            (pid,),
        ).fetchone()
        return dict(row)
    finally:
        conn.close()


def delete_custom_preset(pid: int) -> bool:
    init_db()
    conn = sqlite3.connect(DB_PATH)
    try:
        cur = conn.execute("DELETE FROM custom_presets WHERE id = ?", (pid,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def add_focus_minutes(day_iso: str, minutes: int) -> int:
    if minutes <= 0:
        return get_focus_minutes(day_iso)
    init_db()
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(
            """
            INSERT INTO daily_focus (day, minutes) VALUES (?, ?)
            ON CONFLICT(day) DO UPDATE SET minutes = daily_focus.minutes + excluded.minutes
            """,
            (day_iso, minutes),
        )
        conn.commit()
        row = conn.execute(
            "SELECT minutes FROM daily_focus WHERE day = ?", (day_iso,)
        ).fetchone()
        return row[0] if row else 0
    finally:
        conn.close()


def get_focus_minutes(day_iso: str) -> int:
    init_db()
    conn = sqlite3.connect(DB_PATH)
    try:
        row = conn.execute(
            "SELECT minutes FROM daily_focus WHERE day = ?", (day_iso,)
        ).fetchone()
        return row[0] if row else 0
    finally:
        conn.close()
