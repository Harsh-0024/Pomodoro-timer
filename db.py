import json
import sqlite3
from datetime import date, timedelta
from pathlib import Path

DEFAULT_SETTINGS = {
    "auto_start_work": False,
    "auto_start_break": False,
    "sound_enabled": True,
    "sound_volume": 70,
    "sound_profile": "bold",
    "sound_work_end": "soothing-bell",
    "sound_break_end": "opening-bells",
    "sound_session_start": "temple-gong",
    "sound_action": "soft-bell",
    "tick_sound_enabled": True,
    "chime_work_end": True,
    "chime_break_end": True,
    "chime_session_start": True,
    "chime_pool_add": True,
    "chime_choice": True,
    "chime_skip": True,
    "notifications_enabled": True,
    "default_preset_id": "builtin-shishya",
    "daily_focus_goal_minutes": 120,
    "theme": "system",
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

            CREATE TABLE IF NOT EXISTS activity_segments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                day TEXT NOT NULL,
                kind TEXT NOT NULL,
                started_at TEXT NOT NULL,
                ended_at TEXT NOT NULL,
                duration_sec REAL NOT NULL,
                productive_sec REAL NOT NULL DEFAULT 0,
                rest_sec REAL NOT NULL DEFAULT 0,
                preset_id TEXT,
                preset_name TEXT,
                phase_index INTEGER,
                details_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE INDEX IF NOT EXISTS idx_activity_segments_day
            ON activity_segments(day, started_at);
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


def add_activity_segment(segment: dict) -> dict:
    init_db()
    kind = str(segment["kind"])
    duration_sec = float(segment["duration_sec"])
    productive_sec = duration_sec if kind in ("work", "extend") else 0.0
    rest_sec = duration_sec if kind in ("rest", "cumulative", "pause") else 0.0
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        cur = conn.execute(
            """
            INSERT INTO activity_segments (
                day, kind, started_at, ended_at, duration_sec,
                productive_sec, rest_sec, preset_id, preset_name, phase_index, details_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                segment["day"],
                kind,
                segment["started_at"],
                segment["ended_at"],
                duration_sec,
                productive_sec,
                rest_sec,
                segment.get("preset_id"),
                segment.get("preset_name"),
                segment.get("phase_index"),
                json.dumps(segment.get("details") or {}),
            ),
        )
        conn.commit()
        row = conn.execute(
            """
            SELECT id, day, kind, started_at, ended_at, duration_sec,
                   productive_sec, rest_sec, preset_id, preset_name,
                   phase_index, details_json, created_at
            FROM activity_segments WHERE id = ?
            """,
            (cur.lastrowid,),
        ).fetchone()
        return _activity_public(row)
    finally:
        conn.close()


def _activity_public(row: sqlite3.Row) -> dict:
    item = dict(row)
    item["details"] = json.loads(item.pop("details_json") or "{}")
    return item


def activity_for_day(day_iso: str) -> dict:
    init_db()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            SELECT id, day, kind, started_at, ended_at, duration_sec,
                   productive_sec, rest_sec, preset_id, preset_name,
                   phase_index, details_json, created_at
            FROM activity_segments
            WHERE day = ?
            ORDER BY started_at ASC, id ASC
            """,
            (day_iso,),
        ).fetchall()
        segments = [_activity_public(row) for row in rows]
        productive = sum(float(s["productive_sec"]) for s in segments)
        rest = sum(float(s["rest_sec"]) for s in segments)
        tracked = productive + rest
        return {
            "day": day_iso,
            "segments": segments,
            "totals": {
                "productive_sec": productive,
                "rest_sec": rest,
                "tracked_sec": tracked,
                "productivity_pct": round((productive / tracked) * 100, 2) if tracked else None,
            },
        }
    finally:
        conn.close()


def _logged_year_bounds(conn: sqlite3.Connection) -> tuple[int, int] | None:
    rows = conn.execute(
        """
        SELECT substr(day, 1, 4) AS year FROM daily_focus
        UNION
        SELECT substr(day, 1, 4) AS year FROM activity_segments
        """
    ).fetchall()
    years = set()
    for row in rows:
        try:
            years.add(int(row["year"]))
        except (TypeError, ValueError):
            pass
    if not years:
        return None
    return min(years), max(years)


def _dashboard_years(first_year: int, selected_year: int) -> list[int]:
    end_year = max(date.today().year, selected_year, first_year)
    return list(range(first_year, end_year + 1))


def dashboard_summary(end_day_iso: str | None = None, days: int = 365, year: int | None = None) -> dict:
    init_db()
    today = date.today()
    try:
        selected_year = int(year) if year is not None else None
    except (TypeError, ValueError):
        selected_year = None

    if selected_year is not None:
        selected_year = max(1970, min(selected_year, today.year))
        start_day = date(selected_year, 1, 1)
        end_day = date(selected_year, 12, 31)
        days = (end_day - start_day).days + 1
        calc_end_day = min(end_day, today)
    else:
        days = max(7, min(int(days or 365), 370))
        try:
            end_day = date.fromisoformat(end_day_iso) if end_day_iso else today
        except ValueError:
            end_day = today
        selected_year = end_day.year
        start_day = end_day - timedelta(days=days - 1)
        calc_end_day = min(end_day, today)

    start_iso = start_day.isoformat()
    end_iso = end_day.isoformat()

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        year_bounds = _logged_year_bounds(conn)
        if year_bounds:
            first_year, _ = year_bounds
            selected_year = max(first_year, min(selected_year, today.year))
        else:
            first_year = selected_year

        if year is not None:
            start_day = date(selected_year, 1, 1)
            end_day = date(selected_year, 12, 31)
            days = (end_day - start_day).days + 1
            calc_end_day = min(end_day, today)
            start_iso = start_day.isoformat()
            end_iso = end_day.isoformat()

        years = _dashboard_years(first_year, selected_year)
        focus_rows = conn.execute(
            """
            SELECT day, minutes
            FROM daily_focus
            WHERE day BETWEEN ? AND ?
            """,
            (start_iso, end_iso),
        ).fetchall()
        segment_rows = conn.execute(
            """
            SELECT day,
                   SUM(productive_sec) AS productive_sec,
                   SUM(rest_sec) AS rest_sec,
                   SUM(duration_sec) AS duration_sec,
                   COUNT(*) AS segment_count,
                   SUM(CASE WHEN kind IN ('work', 'extend') THEN 1 ELSE 0 END) AS focus_segments
            FROM activity_segments
            WHERE day BETWEEN ? AND ?
            GROUP BY day
            """,
            (start_iso, end_iso),
        ).fetchall()
        preset_rows = conn.execute(
            """
            SELECT COALESCE(NULLIF(preset_name, ''), 'Unnamed rhythm') AS preset_name,
                   SUM(productive_sec) AS productive_sec,
                   COUNT(*) AS segment_count
            FROM activity_segments
            WHERE day BETWEEN ? AND ?
              AND productive_sec > 0
            GROUP BY COALESCE(NULLIF(preset_name, ''), 'Unnamed rhythm')
            ORDER BY productive_sec DESC
            """,
            (start_iso, end_iso),
        ).fetchall()
    finally:
        conn.close()

    daily_focus = {row["day"]: float(row["minutes"] or 0) for row in focus_rows}
    activity = {row["day"]: row for row in segment_rows}
    settings = load_settings()
    goal_minutes = int(settings.get("daily_focus_goal_minutes") or 120)

    records = []
    total_focus = 0.0
    total_rest = 0.0
    total_tracked = 0.0
    active_days = 0
    goal_days = 0
    best_day = None
    longest_streak = 0
    running_streak = 0
    first_active_day = None

    for offset in range(days):
        day = start_day + timedelta(days=offset)
        day_iso = day.isoformat()
        seg = activity.get(day_iso)
        segment_focus = float(seg["productive_sec"] or 0) / 60 if seg else 0.0
        segment_rest = float(seg["rest_sec"] or 0) / 60 if seg else 0.0
        focus_minutes = max(segment_focus, daily_focus.get(day_iso, 0.0))
        rest_minutes = segment_rest
        tracked_minutes = max(
            float(seg["duration_sec"] or 0) / 60 if seg else 0.0,
            focus_minutes + rest_minutes,
        )
        productive = focus_minutes > 0
        if productive:
            active_days += 1
            if first_active_day is None:
                first_active_day = day
            running_streak += 1
            longest_streak = max(longest_streak, running_streak)
        else:
            running_streak = 0
        if focus_minutes >= goal_minutes:
            goal_days += 1
        if focus_minutes > 0 and (best_day is None or focus_minutes > best_day["focus_minutes"]):
            best_day = {"day": day_iso, "focus_minutes": round(focus_minutes, 1)}

        total_focus += focus_minutes
        total_rest += rest_minutes
        total_tracked += tracked_minutes
        records.append(
            {
                "day": day_iso,
                "weekday": day.weekday(),
                "focus_minutes": round(focus_minutes, 1),
                "rest_minutes": round(rest_minutes, 1),
                "tracked_minutes": round(tracked_minutes, 1),
                "segment_count": int(seg["segment_count"] or 0) if seg else 0,
                "focus_segments": int(seg["focus_segments"] or 0) if seg else 0,
                "goal_met": focus_minutes >= goal_minutes,
            }
        )

    current_streak = 0
    for record in reversed(records):
        if record["day"] > calc_end_day.isoformat():
            continue
        if record["focus_minutes"] > 0:
            current_streak += 1
        else:
            break

    if first_active_day:
        consistency_days_elapsed = max(1, (calc_end_day - first_active_day).days + 1)
    else:
        consistency_days_elapsed = max(1, (calc_end_day - start_day).days + 1)

    total_preset_focus = sum(float(row["productive_sec"] or 0) for row in preset_rows)
    top_presets = [
        {
            "name": row["preset_name"],
            "focus_minutes": round(float(row["productive_sec"] or 0) / 60, 1),
            "focus_pct": round((float(row["productive_sec"] or 0) / total_preset_focus) * 100, 1)
            if total_preset_focus
            else 0,
            "segment_count": int(row["segment_count"] or 0),
        }
        for row in preset_rows
    ]

    return {
        "range": {
            "start": start_iso,
            "end": end_iso,
            "days": days,
            "year": selected_year,
            "years": years,
            "calc_start": first_active_day.isoformat() if first_active_day else start_iso,
            "calc_end": calc_end_day.isoformat(),
        },
        "goal_minutes": goal_minutes,
        "days": records,
        "recent_days": [
            record for record in reversed(records) if record["day"] <= calc_end_day.isoformat()
        ][:14],
        "top_presets": top_presets,
        "summary": {
            "total_focus_minutes": round(total_focus, 1),
            "total_rest_minutes": round(total_rest, 1),
            "total_tracked_minutes": round(total_tracked, 1),
            "active_days": active_days,
            "goal_days": goal_days,
            "current_streak": current_streak,
            "longest_streak": longest_streak,
            "best_day": best_day,
            "days_elapsed": consistency_days_elapsed,
            "consistency_days_per_week": round((active_days / consistency_days_elapsed) * 7, 2)
            if consistency_days_elapsed
            else 0,
            "average_focus_active_day": round(total_focus / active_days, 1) if active_days else 0,
            "productivity_pct": round((total_focus / total_tracked) * 100, 1) if total_tracked else None,
        },
    }
