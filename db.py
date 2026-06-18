import json
import sqlite3
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from presets import BUILTINS

DEFAULT_SETTINGS = {
    "auto_start_work": False,
    "auto_start_break": False,
    "sound_enabled": True,
    "sound_volume": 70,
    "sound_profile": "bold",
    "sound_rest_end": "opening-bells",
    "sound_work_begin": "temple-gong",
    "sound_work_end": "soothing-bell",
    "sound_action": "soft-bell",
    "manual_sound_rest_end": "opening-bells",
    "manual_sound_work_begin": "temple-gong",
    "manual_sound_work_end": "soothing-bell",
    "manual_sound_action": "soft-bell",
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
    if "sound_rest_end" not in data and "sound_break_end" in data:
        data["sound_rest_end"] = data["sound_break_end"]
    if "sound_work_begin" not in data and "sound_session_start" in data:
        data["sound_work_begin"] = data["sound_session_start"]
    if "manual_sound_rest_end" not in data and "sound_rest_end" in data:
        data["manual_sound_rest_end"] = data["sound_rest_end"]
    if "manual_sound_work_begin" not in data and "sound_work_begin" in data:
        data["manual_sound_work_begin"] = data["sound_work_begin"]
    if "manual_sound_work_end" not in data and "sound_work_end" in data:
        data["manual_sound_work_end"] = data["sound_work_end"]
    if "manual_sound_action" not in data and "sound_action" in data:
        data["manual_sound_action"] = data["sound_action"]
    data.pop("sound_break_end", None)
    data.pop("sound_session_start", None)
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
    productive_sec = duration_sec if kind in ("work", "extend", "flow") else 0.0
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


RHYTHM_BOUT_GAP_SEC = 120
RHYTHM_NOISE_FLOOR_SEC = 5 * 60


def _parse_segment_time(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def _dashboard_timezone(timezone_name: str | None):
    if timezone_name:
        try:
            return ZoneInfo(timezone_name)
        except (ZoneInfoNotFoundError, ValueError):
            pass
    return datetime.now().astimezone().tzinfo or timezone.utc


def _day_range_utc_bounds(start_day: date, end_day: date, tz) -> tuple[str, str]:
    local_start = datetime.combine(start_day, time.min, tzinfo=tz)
    local_end = datetime.combine(end_day + timedelta(days=1), time.min, tzinfo=tz)
    return (
        local_start.astimezone(timezone.utc).isoformat(),
        local_end.astimezone(timezone.utc).isoformat(),
    )


def _empty_dashboard_bucket() -> dict:
    return {
        "productive_sec": 0.0,
        "rest_sec": 0.0,
        "duration_sec": 0.0,
        "segment_count": 0,
        "focus_segments": 0,
    }


def _credit_bucket(bucket: dict, duration_sec: float, productive_sec: float, rest_sec: float):
    if duration_sec <= 0 and productive_sec <= 0 and rest_sec <= 0:
        return
    bucket["duration_sec"] += duration_sec
    bucket["productive_sec"] += productive_sec
    bucket["rest_sec"] += rest_sec
    bucket["segment_count"] += 1
    if productive_sec > 0:
        bucket["focus_segments"] += 1


def _credit_row_to_days(
    buckets: dict[str, dict],
    row: sqlite3.Row,
    started_at: datetime,
    ended_at: datetime,
    start_day: date,
    end_day: date,
    tz,
):
    duration_sec = max(0.0, float(row["duration_sec"] or 0))
    productive_sec = max(0.0, float(row["productive_sec"] or 0))
    rest_sec = max(0.0, float(row["rest_sec"] or 0))
    actual_sec = max(0.0, (ended_at - started_at).total_seconds())
    if actual_sec <= 0:
        return

    range_start = datetime.combine(start_day, time.min, tzinfo=tz)
    range_end = datetime.combine(end_day + timedelta(days=1), time.min, tzinfo=tz)
    local_start = max(started_at.astimezone(tz), range_start)
    local_end = min(ended_at.astimezone(tz), range_end)
    if local_end <= local_start:
        return

    cursor = local_start
    while cursor < local_end:
        next_midnight = datetime.combine(cursor.date() + timedelta(days=1), time.min, tzinfo=tz)
        chunk_end = min(local_end, next_midnight)
        chunk_sec = max(0.0, (chunk_end - cursor).total_seconds())
        if chunk_sec > 0:
            fraction = chunk_sec / actual_sec
            day_iso = cursor.date().isoformat()
            bucket = buckets.setdefault(day_iso, _empty_dashboard_bucket())
            _credit_bucket(
                bucket,
                duration_sec * fraction,
                productive_sec * fraction,
                rest_sec * fraction,
            )
        cursor = chunk_end


def _rhythm_profile_from_weights(weighted_sec: dict[str, float], total_weighted_sec: float, rhythms: list[dict]) -> list[dict]:
    rows = []
    for rhythm in rhythms:
        sec = weighted_sec[rhythm["name"]]
        if sec <= 0:
            continue
        rows.append(
            {
                "name": rhythm["name"],
                "session_minutes": rhythm["session_minutes"],
                "focus_minutes": round(sec / 60, 1),
                "focus_pct": round((sec / total_weighted_sec) * 100, 1) if total_weighted_sec else 0,
            }
        )
    return sorted(rows, key=lambda row: row["focus_minutes"], reverse=True)


def _builtin_rhythms() -> list[dict]:
    return sorted(
        (
            {
                "id": preset["id"],
                "name": preset["name"],
                "session_minutes": int(preset["work_min"]),
                "work_sec": float(preset["work_min"]) * 60,
            }
            for preset in BUILTINS
        ),
        key=lambda rhythm: rhythm["work_sec"],
    )


def _rhythm_weights_for_bout(duration_sec: float, rhythms: list[dict]) -> list[tuple[str, float]]:
    if not rhythms or duration_sec <= 0:
        return []
    first = rhythms[0]
    last = rhythms[-1]
    if duration_sec <= first["work_sec"]:
        return [(first["name"], duration_sec)]
    if duration_sec >= last["work_sec"]:
        return [(last["name"], duration_sec)]

    for rhythm in rhythms:
        if abs(duration_sec - rhythm["work_sec"]) < 0.001:
            return [(rhythm["name"], duration_sec)]

    for lower, upper in zip(rhythms, rhythms[1:]):
        if lower["work_sec"] < duration_sec < upper["work_sec"]:
            lower_gap = duration_sec - lower["work_sec"]
            upper_gap = upper["work_sec"] - duration_sec
            total_gap = lower_gap + upper_gap
            if total_gap <= 0:
                return [(lower["name"], duration_sec)]
            return [
                (lower["name"], duration_sec * (upper_gap / total_gap)),
                (upper["name"], duration_sec * (lower_gap / total_gap)),
            ]
    return [(last["name"], duration_sec)]


def dashboard_summary(
    end_day_iso: str | None = None,
    days: int = 365,
    year: int | None = None,
    timezone_name: str | None = None,
) -> dict:
    init_db()
    tz = _dashboard_timezone(timezone_name)
    today = datetime.now(tz).date()
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
    range_start_utc, range_end_utc = _day_range_utc_bounds(start_day, end_day, tz)

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
            range_start_utc, range_end_utc = _day_range_utc_bounds(start_day, end_day, tz)

        years = _dashboard_years(first_year, selected_year)
        segment_rows = conn.execute(
            """
            SELECT kind, started_at, ended_at, duration_sec, productive_sec, rest_sec
            FROM activity_segments
            WHERE julianday(started_at) < julianday(?)
              AND julianday(ended_at) > julianday(?)
            ORDER BY julianday(started_at) ASC, id ASC
            """,
            (range_end_utc, range_start_utc),
        ).fetchall()
    finally:
        conn.close()

    settings = load_settings()
    goal_minutes = int(settings.get("daily_focus_goal_minutes") or 120)
    activity: dict[str, dict] = {}

    rhythms = _builtin_rhythms()
    weighted_sec = {rhythm["name"]: 0.0 for rhythm in rhythms}
    total_weighted_sec = 0.0
    current_bout_sec = 0.0
    current_bout_end: datetime | None = None

    def finalize_bout():
        nonlocal current_bout_sec, current_bout_end, total_weighted_sec
        if current_bout_sec >= RHYTHM_NOISE_FLOOR_SEC:
            total_weighted_sec += current_bout_sec
            for name, contribution_sec in _rhythm_weights_for_bout(current_bout_sec, rhythms):
                weighted_sec[name] += contribution_sec
        current_bout_sec = 0.0
        current_bout_end = None

    for row in segment_rows:
        started_at = _parse_segment_time(row["started_at"])
        ended_at = _parse_segment_time(row["ended_at"])
        if started_at is None or ended_at is None or ended_at <= started_at:
            continue

        productive_sec = max(0.0, float(row["productive_sec"] or 0))
        if productive_sec > 0:
            rhythm_duration_sec = max(0.0, float(row["duration_sec"] or 0))
            joins_current = False
            if current_bout_sec > 0 and current_bout_end is not None:
                gap_sec = (started_at - current_bout_end).total_seconds()
                joins_current = gap_sec <= RHYTHM_BOUT_GAP_SEC

            if current_bout_sec > 0 and not joins_current:
                finalize_bout()

            current_bout_sec += rhythm_duration_sec
            current_bout_end = max(current_bout_end, ended_at) if current_bout_end and joins_current else ended_at

        _credit_row_to_days(activity, row, started_at, ended_at, start_day, end_day, tz)

    finalize_bout()

    records = []
    recent_days = []
    total_focus = 0.0
    total_rest = 0.0
    total_tracked = 0.0
    active_days = 0
    goal_days = 0
    best_day = None
    longest_streak = 0
    running_streak = 0
    current_streak = 0
    first_active_day = None
    calc_end_iso = calc_end_day.isoformat()

    for offset in range(days):
        day = start_day + timedelta(days=offset)
        day_iso = day.isoformat()
        seg = activity.get(day_iso)
        segment_focus = float(seg["productive_sec"] or 0) / 60 if seg else 0.0
        segment_rest = float(seg["rest_sec"] or 0) / 60 if seg else 0.0
        focus_minutes = segment_focus
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
        record = {
            "day": day_iso,
            "weekday": day.weekday(),
            "focus_minutes": round(focus_minutes, 1),
            "rest_minutes": round(rest_minutes, 1),
            "tracked_minutes": round(tracked_minutes, 1),
            "segment_count": int(seg["segment_count"] or 0) if seg else 0,
            "focus_segments": int(seg["focus_segments"] or 0) if seg else 0,
            "goal_met": focus_minutes >= goal_minutes,
        }
        records.append(record)
        if day_iso <= calc_end_iso:
            current_streak = current_streak + 1 if focus_minutes > 0 else 0
            recent_days.insert(0, record)
            if len(recent_days) > 14:
                recent_days.pop()

    if first_active_day:
        consistency_days_elapsed = max(1, (calc_end_day - first_active_day).days + 1)
    else:
        consistency_days_elapsed = max(1, (calc_end_day - start_day).days + 1)

    top_presets = _rhythm_profile_from_weights(weighted_sec, total_weighted_sec, rhythms)

    return {
        "range": {
            "start": start_iso,
            "end": end_iso,
            "days": days,
            "year": selected_year,
            "years": years,
            "calc_start": first_active_day.isoformat() if first_active_day else start_iso,
            "calc_end": calc_end_iso,
        },
        "goal_minutes": goal_minutes,
        "days": records,
        "recent_days": recent_days,
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
