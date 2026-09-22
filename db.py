from __future__ import annotations

import json
import math
import shutil
import sqlite3
import sys
import threading
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from alembic import command as alembic_command
from alembic.config import Config as AlembicConfig
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from platformdirs import user_data_dir
from sqlalchemy import create_engine

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

PROJECT_ROOT = Path(__file__).resolve().parent
LEGACY_DB_PATH = PROJECT_ROOT / "data" / "focus_timer.db"
DB_PATH = Path(user_data_dir("MuhurataTimer", appauthor=False)) / "focus_timer.db"
BACKUP_DIR = DB_PATH.parent / "backups"
BACKUPS_TO_KEEP = 3
MIGRATIONS_DIR = PROJECT_ROOT / "migrations"

# Schema setup runs once per process; the lock covers concurrent first requests.
_schema_ready = False
_schema_lock = threading.Lock()


def _migrate_legacy_db():
    if not DB_PATH.exists() and LEGACY_DB_PATH.exists():
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        # copy2, not move: leave the old file in place in case migration needs re-running
        shutil.copy2(LEGACY_DB_PATH, DB_PATH)


def _log(msg: str):
    print(f"[muhurata] {msg}", file=sys.stderr)


def _alembic_config() -> AlembicConfig:
    # Built in code rather than read from alembic.ini so the app never depends
    # on the CWD, and so alembic's fileConfig() doesn't clobber Flask logging.
    cfg = AlembicConfig()
    cfg.set_main_option("script_location", str(MIGRATIONS_DIR))
    cfg.set_main_option("sqlalchemy.url", f"sqlite:///{DB_PATH}")
    return cfg


def _backup_db(tag: str):
    """Copy the db via SQLite's online backup API (safe even mid-write) and
    keep only the newest BACKUPS_TO_KEEP files."""
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = BACKUP_DIR / f"focus_timer-{stamp}-{tag}.db"
    src = sqlite3.connect(DB_PATH)
    dst = sqlite3.connect(dest)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    _log(f"backed up db to {dest}")
    backups = sorted(BACKUP_DIR.glob("focus_timer-*.db"))
    for old in backups[:-BACKUPS_TO_KEEP]:
        old.unlink(missing_ok=True)


def _run_migrations():
    cfg = _alembic_config()
    head = ScriptDirectory.from_config(cfg).get_current_head()

    engine = create_engine(f"sqlite:///{DB_PATH}")
    try:
        with engine.connect() as conn:
            current = MigrationContext.configure(conn).get_current_revision()
            table_names = set(conn.exec_driver_sql(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).scalars())
    finally:
        engine.dispose()

    if current == head:
        return

    if current is None and "activity_segments" in table_names:
        # A db created by the pre-alembic executescript() setup: the tables
        # already match the baseline, so just mark it as such.
        alembic_command.stamp(cfg, "head")
        _log(f"stamped existing db at revision {head}")
        return

    if current is not None:
        _backup_db(f"pre-{head}")
    alembic_command.upgrade(cfg, "head")
    _log(f"migrated db {current or '<empty>'} -> {head}")


def init_db():
    global _schema_ready
    if _schema_ready:
        return
    with _schema_lock:
        if _schema_ready:
            return
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        _migrate_legacy_db()
        _run_migrations()
        conn = sqlite3.connect(DB_PATH)
        try:
            conn.execute("INSERT OR IGNORE INTO app_settings (id, json) VALUES (1, '{}')")
            conn.commit()
        finally:
            conn.close()
        _schema_ready = True


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
BELL_MIN_BOUTS = 15


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


def _compute_percentile(sorted_data: list[float], p: float) -> float:
    """Compute the p-th percentile (0-100) from sorted data."""
    n = len(sorted_data)
    if n == 0:
        return 0.0
    if n == 1:
        return sorted_data[0]
    k = (n - 1) * p / 100.0
    f = int(k)
    c = min(f + 1, n - 1)
    frac = k - f
    return sorted_data[f] + frac * (sorted_data[c] - sorted_data[f])


def _bell_bandwidth(sorted_d: list[float]) -> float:
    """Silverman's rule of thumb, guarded against zero spread."""
    n = len(sorted_d)
    mean = sum(sorted_d) / n
    variance = sum((x - mean) ** 2 for x in sorted_d) / (n - 1) if n > 1 else 0.0
    std = variance ** 0.5
    iqr = _compute_percentile(sorted_d, 75) - _compute_percentile(sorted_d, 25)
    spread = min(std, iqr / 1.34) if iqr > 0 else std
    h = 0.9 * spread * (n ** -0.2)
    if h <= 0:
        h = (std * (n ** -0.2)) if std > 0 else 0.0
    if h <= 0:
        h = max(0.5, sorted_d[-1] * 0.05)
    return h


def _bell_domain(sorted_d: list[float], h: float) -> tuple[float, float]:
    """Pick a display domain that is robust to a handful of very long sittings.

    A single 16-hour outlier must not squash every real session into the far
    left of the chart, so the upper edge is capped at an outlier fence. The
    true maximum is still reported separately so nothing is hidden.

    The lower edge follows the data too, so a user whose shortest sitting is an
    hour does not get half a chart of empty space.
    """
    q1 = _compute_percentile(sorted_d, 25)
    q3 = _compute_percentile(sorted_d, 75)
    iqr = max(0.0, q3 - q1)
    p1 = _compute_percentile(sorted_d, 1)
    p95 = _compute_percentile(sorted_d, 95)
    data_max = sorted_d[-1]

    x_lo = max(0.0, p1 - 2.0 * h)
    fence = max(q3 + 3.0 * iqr, p95 * 1.25, q3 + 2.0 * h)
    x_hi = min(data_max, fence) + 2.0 * h
    x_hi = min(x_hi, data_max + 2.0 * h)
    if x_hi <= x_lo:
        x_hi = x_lo + max(1.0, h)
    return x_lo, x_hi


def _compute_kde(
    durations: list[float],
    x_lo: float,
    x_hi: float,
    h: float,
    num_points: int = 160,
) -> list[list[float]]:
    """Gaussian KDE sampled across [x_lo, x_hi].

    No boundary correction is applied: the 5-minute noise floor is a reporting
    cutoff rather than a real limit on how short a sitting can be, so mirroring
    the kernel there would invent a peak that the data does not contain.
    """
    n = len(durations)
    if n == 0 or h <= 0 or num_points < 2:
        return []

    step = (x_hi - x_lo) / (num_points - 1)
    inv_sqrt_2pi = 0.3989422804014327

    points: list[list[float]] = []
    for i in range(num_points):
        x = x_lo + i * step
        density = 0.0
        for d in durations:
            z = (x - d) / h
            if -6.0 < z < 6.0:
                density += inv_sqrt_2pi * math.exp(-0.5 * z * z)
        density /= (n * h)
        points.append([round(x, 2), density])

    return points


def _compute_bell_curve(bout_durations_sec: list[float]) -> dict:
    """Session-length distribution for the dashboard's rhythm curve.

    Below the minimum bout count the shape would be noise, so only progress
    towards the threshold is returned.
    """
    min_bouts = BELL_MIN_BOUTS
    durations_min = [d / 60.0 for d in bout_durations_sec]
    bout_count = len(durations_min)

    if bout_count < min_bouts:
        return {
            "ready": False,
            "bout_count": bout_count,
            "min_required": min_bouts,
        }

    sorted_d = sorted(durations_min)
    n = len(sorted_d)
    mean_min = sum(sorted_d) / n
    variance = sum((x - mean_min) ** 2 for x in sorted_d) / (n - 1)
    std_dev_min = variance ** 0.5

    median_min = _compute_percentile(sorted_d, 50)
    p5_min = _compute_percentile(sorted_d, 5)
    p25_min = _compute_percentile(sorted_d, 25)
    p75_min = _compute_percentile(sorted_d, 75)
    p95_min = _compute_percentile(sorted_d, 95)

    h = _bell_bandwidth(sorted_d)
    x_lo, x_hi = _bell_domain(sorted_d, h)
    curve = _compute_kde(sorted_d, x_lo, x_hi, h)

    peak_min = median_min
    y_max = 0.0
    if curve:
        peak_point = max(curve, key=lambda pt: pt[1])
        peak_min = peak_point[0]
        y_max = peak_point[1]

    clipped = [d for d in sorted_d if d > x_hi]

    return {
        "ready": True,
        "bout_count": bout_count,
        "mean_min": round(mean_min, 1),
        "median_min": round(median_min, 1),
        "std_dev_min": round(std_dev_min, 1),
        "peak_min": round(peak_min, 1),
        "p5_min": round(p5_min, 1),
        "p25_min": round(p25_min, 1),
        "p75_min": round(p75_min, 1),
        "p95_min": round(p95_min, 1),
        "max_min": round(sorted_d[-1], 1),
        "bandwidth_min": round(h, 2),
        "x_min": round(x_lo, 2),
        "x_max": round(x_hi, 2),
        "y_max": y_max,
        "clipped_count": len(clipped),
        "curve": curve,
        "durations": [round(d, 2) for d in sorted_d],
    }

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

    current_bout_sec = 0.0
    current_bout_end: datetime | None = None
    bout_durations: list[float] = []

    def finalize_bout():
        nonlocal current_bout_sec, current_bout_end
        if current_bout_sec >= RHYTHM_NOISE_FLOOR_SEC:
            bout_durations.append(current_bout_sec)
        current_bout_sec = 0.0
        current_bout_end = None

    for row in segment_rows:
        started_at = _parse_segment_time(row["started_at"])
        ended_at = _parse_segment_time(row["ended_at"])
        if started_at is None or ended_at is None or ended_at <= started_at:
            continue

        productive_sec = max(0.0, float(row["productive_sec"] or 0))
        if productive_sec > 0:
            # Use productive seconds, not wall-clock duration: a paused or
            # abandoned flow segment can span hours of clock time while only a
            # few minutes were actually focused.
            rhythm_duration_sec = productive_sec
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

    bell_curve = _compute_bell_curve(bout_durations)

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
        "bell_curve": bell_curve,
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
