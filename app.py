from __future__ import annotations

import re
import json
import random
import sqlite3
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

from flask import Flask, jsonify, render_template, request

import db
from presets import BUILTINS

app = Flask(__name__)
app.config["JSON_SORT_KEYS"] = False

BASE_DIR = Path(__file__).resolve().parent
BUILTIN_QUOTES = [
    {"quote": "You have power over your mind, not outside events. Realize this, and you will find strength.", "author": "Marcus Aurelius"},
    {"quote": "The successful warrior is the average man, with laser-like focus.", "author": "Bruce Lee"},
    {"quote": "Concentrate all your thoughts upon the work in hand.", "author": "Alexander Graham Bell"},
]
QUOTE_FILES = (
    BASE_DIR / "quotes.json",
    BASE_DIR / "data" / "quotes.json",
    BASE_DIR / "static" / "quotes.json",
    BASE_DIR / "static" / "js" / "quotes.js",
)


def _normalize_quote(item: dict) -> dict | None:
    quote = str(item.get("quote") or item.get("q") or "").strip()
    author = str(item.get("author") or item.get("a") or "").strip()
    if not quote or not author:
        return None
    return {"quote": quote, "author": author}


def _read_quote_file(path: Path) -> list[dict]:
    raw = path.read_text(encoding="utf-8")
    if path.suffix == ".js":
        match = re.search(r"const\s+FALLBACK_QUOTES\s*=\s*(\[.*\])\s*;?\s*$", raw, re.DOTALL)
        if not match:
            return []
        raw = match.group(1)
        raw = re.sub(r"([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:", r'\1"\2":', raw)
        raw = re.sub(r",\s*([}\]])", r"\1", raw)
    data = json.loads(raw)
    if not isinstance(data, list):
        return []
    return [quote for item in data if isinstance(item, dict) and (quote := _normalize_quote(item))]


def _load_offline_quotes() -> list[dict]:
    for path in QUOTE_FILES:
        if not path.exists():
            continue
        try:
            quotes = _read_quote_file(path)
        except (OSError, json.JSONDecodeError):
            continue
        if quotes:
            return quotes
    return BUILTIN_QUOTES


FALLBACK_QUOTES = _load_offline_quotes()
INITIAL_QUOTE = random.choice(FALLBACK_QUOTES)
SOUND_CHOICES = {
    "soothing-bell",
    "opening-bells",
    "temple-gong",
    "ghanta-trio",
    "soft-bell",
    "bamboo-tick",
}
SOUND_SETTING_KEYS = (
    "manual_sound_rest_end",
    "manual_sound_work_begin",
    "manual_sound_work_end",
    "manual_sound_action",
    "sound_rest_end",
    "sound_work_begin",
    "sound_work_end",
    "sound_action",
)


@app.before_request
def _ensure_db():
    db.init_db()


@app.context_processor
def _inject_theme():
    theme = db.load_settings().get("theme", "system")
    if theme not in ("light", "dark", "system"):
        theme = "system"
    return {"theme": theme}


def _builtin_public(b: dict) -> dict:
    total = b.get("cycle_min") or (b.get("total_work_min", 0) + b.get("total_rest_min", 0))
    focus = round(100 * b.get("total_work_min", 0) / total, 1) if total else 0
    return {
        **b,
        "kind": "builtin",
        "focus_ratio_pct": focus,
    }


def _custom_public(row: dict) -> dict:
    w, s, l = row["work_min"], row["short_rest_min"], row["long_rest_min"]
    tw = 4 * w
    tr = 3 * s + l
    total = tw + tr
    fr = round(100 * tw / total, 2) if total else 0.0
    return {
        "id": f"custom-{row['id']}",
        "kind": "custom",
        "name": row["name"],
        "subtitle": "Your rhythm",
        "work_min": w,
        "short_rest_min": s,
        "long_rest_min": l,
        "total_work_min": tw,
        "total_rest_min": tr,
        "cycle_min": total,
        "focus_ratio_pct": fr,
        "created_at": row["created_at"],
    }


def _preset_exists(preset_id: str) -> bool:
    if preset_id.startswith("builtin-"):
        return any(b["id"] == preset_id for b in BUILTINS)
    m = re.fullmatch(r"custom-(\d+)", preset_id or "")
    if not m:
        return False
    pid = int(m.group(1))
    conn = sqlite3.connect(db.DB_PATH)
    try:
        row = conn.execute(
            "SELECT 1 FROM custom_presets WHERE id = ?", (pid,)
        ).fetchone()
        return row is not None
    finally:
        conn.close()


@app.route("/")
def index():
    return render_template("index.html", initial_quote=INITIAL_QUOTE)


@app.route("/settings")
def settings_page():
    return render_template("settings.html")


@app.route("/dashboard")
def dashboard_page():
    return render_template("dashboard.html")


@app.get("/api/presets")
def api_presets():
    custom = [_custom_public(r) for r in db.list_custom_presets()]
    builtins = [_builtin_public(b) for b in BUILTINS]
    return jsonify({"builtins": builtins, "custom": custom})


@app.post("/api/presets")
def api_create_preset():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    try:
        w = int(data.get("work_min"))
        s = int(data.get("short_rest_min"))
        l = int(data.get("long_rest_min"))
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid durations"}), 400
    if not name or len(name) > 80:
        return jsonify({"error": "Name must be 1–80 characters"}), 400
    if not (1 <= w <= 180 and 1 <= s <= 60 and 1 <= l <= 120):
        return jsonify({"error": "Durations out of allowed range"}), 400
    row = db.create_custom_preset(name, w, s, l)
    return jsonify(_custom_public(row)), 201


@app.delete("/api/presets/<int:preset_id>")
def api_delete_preset(preset_id: int):
    if not db.delete_custom_preset(preset_id):
        return jsonify({"error": "Not found"}), 404
    settings = db.load_settings()
    if settings.get("default_preset_id") == f"custom-{preset_id}":
        db.save_settings({"default_preset_id": "builtin-shishya"})
    return "", 204


@app.get("/api/settings")
def api_get_settings():
    return jsonify(db.load_settings())


@app.get("/api/quote")
def api_quote():
    fallback = random.choice(FALLBACK_QUOTES)
    try:
        req = urllib.request.Request(
            "https://zenquotes.io/api/random",
            headers={"User-Agent": "MuhurataTimer/1.0"},
        )
        with urllib.request.urlopen(req, timeout=4) as res:
            payload = res.read().decode("utf-8")
        data = json.loads(payload)
        item = data[0] if isinstance(data, list) and data else {}
        quote = str(item.get("q") or "").strip()
        author = str(item.get("a") or "").strip()
        if quote and author:
            return jsonify({"quote": quote, "author": author, "source": "zenquotes"})
    except (urllib.error.URLError, TimeoutError, ValueError, KeyError, TypeError):
        pass
    return jsonify({**fallback, "source": "fallback"})


@app.put("/api/settings")
def api_put_settings():
    body = request.get_json(silent=True) or {}
    patch: dict = {}
    if "auto_start_work" in body:
        patch["auto_start_work"] = bool(body["auto_start_work"])
    if "auto_start_break" in body:
        patch["auto_start_break"] = bool(body["auto_start_break"])
    if "sound_enabled" in body:
        patch["sound_enabled"] = bool(body["sound_enabled"])
    if "tick_sound_enabled" in body:
        patch["tick_sound_enabled"] = bool(body["tick_sound_enabled"])
    if "chime_work_end" in body:
        patch["chime_work_end"] = bool(body["chime_work_end"])
    if "chime_break_end" in body:
        patch["chime_break_end"] = bool(body["chime_break_end"])
    if "chime_session_start" in body:
        patch["chime_session_start"] = bool(body["chime_session_start"])
    if "chime_pool_add" in body:
        patch["chime_pool_add"] = bool(body["chime_pool_add"])
    if "chime_choice" in body:
        patch["chime_choice"] = bool(body["chime_choice"])
    if "chime_skip" in body:
        patch["chime_skip"] = bool(body["chime_skip"])
    if "sound_volume" in body:
        try:
            vol = int(body["sound_volume"])
        except (TypeError, ValueError):
            return jsonify({"error": "Invalid volume"}), 400
        if not (0 <= vol <= 100):
            return jsonify({"error": "Volume must be 0–100"}), 400
        patch["sound_volume"] = vol
    if "sound_profile" in body:
        profile = str(body["sound_profile"])
        if profile not in ("subtle", "balanced", "bold"):
            return jsonify({"error": "Invalid sound profile"}), 400
        patch["sound_profile"] = profile
    for key in SOUND_SETTING_KEYS:
        if key in body:
            sound = str(body[key])
            if sound not in SOUND_CHOICES:
                return jsonify({"error": "Invalid sound choice"}), 400
            patch[key] = sound
    if "theme" in body:
        theme = str(body["theme"])
        if theme not in ("light", "dark", "system"):
            return jsonify({"error": "Invalid theme"}), 400
        patch["theme"] = theme
    if "notifications_enabled" in body:
        patch["notifications_enabled"] = bool(body["notifications_enabled"])
    if "default_preset_id" in body:
        pid = str(body["default_preset_id"])
        if not _preset_exists(pid):
            return jsonify({"error": "Unknown default preset"}), 400
        patch["default_preset_id"] = pid
    if "daily_focus_goal_minutes" in body:
        try:
            goal = int(body["daily_focus_goal_minutes"])
        except (TypeError, ValueError):
            return jsonify({"error": "Invalid daily goal"}), 400
        if not (15 <= goal <= 960):
            return jsonify({"error": "Daily goal must be 15–960 minutes"}), 400
        patch["daily_focus_goal_minutes"] = goal
    if not patch:
        return jsonify(db.load_settings())
    saved = db.save_settings(patch)
    return jsonify(saved)


@app.get("/api/focus/today")
def api_focus_today():
    day = request.args.get("day")
    if not day or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
        day = datetime.now().date().isoformat()
    minutes = db.get_focus_minutes(day)
    return jsonify({"day": day, "minutes": minutes})


@app.post("/api/focus/log")
def api_focus_log():
    data = request.get_json(silent=True) or {}
    try:
        minutes = int(data.get("minutes", 0))
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid minutes"}), 400
    day = data.get("day")
    if not day or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(day)):
        return jsonify({"error": "Invalid day"}), 400
    if not (1 <= minutes <= 240):
        return jsonify({"error": "Minutes out of range"}), 400
    total = db.add_focus_minutes(str(day), minutes)
    return jsonify({"day": day, "minutes": total})


@app.post("/api/activity/segment")
def api_activity_segment():
    data = request.get_json(silent=True) or {}
    kind = str(data.get("kind") or "")
    if kind not in ("work", "extend", "rest", "cumulative", "pause"):
        return jsonify({"error": "Invalid activity kind"}), 400
    day = str(data.get("day") or "")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
        return jsonify({"error": "Invalid day"}), 400
    started_at = str(data.get("started_at") or "")
    ended_at = str(data.get("ended_at") or "")
    try:
        datetime.fromisoformat(started_at.replace("Z", "+00:00"))
        datetime.fromisoformat(ended_at.replace("Z", "+00:00"))
        duration_sec = float(data.get("duration_sec"))
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid activity timing"}), 400
    if not (0.5 <= duration_sec <= 24 * 60 * 60):
        return jsonify({"error": "Activity duration out of range"}), 400
    phase_index = data.get("phase_index")
    if phase_index is not None:
        try:
            phase_index = int(phase_index)
        except (TypeError, ValueError):
            return jsonify({"error": "Invalid phase index"}), 400
    details = data.get("details")
    if details is not None and not isinstance(details, dict):
        return jsonify({"error": "Invalid details"}), 400
    segment = db.add_activity_segment(
        {
            "day": day,
            "kind": kind,
            "started_at": started_at,
            "ended_at": ended_at,
            "duration_sec": duration_sec,
            "preset_id": str(data.get("preset_id") or ""),
            "preset_name": str(data.get("preset_name") or ""),
            "phase_index": phase_index,
            "details": details or {},
        }
    )
    return jsonify(segment), 201


@app.get("/api/activity/day")
def api_activity_day():
    day = request.args.get("day")
    if not day or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
        day = datetime.now().date().isoformat()
    return jsonify(db.activity_for_day(str(day)))


@app.get("/api/dashboard")
def api_dashboard():
    day = request.args.get("day")
    if day and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
        return jsonify({"error": "Invalid day"}), 400
    year = request.args.get("year")
    parsed_year = None
    if year:
        try:
            parsed_year = int(year)
        except (TypeError, ValueError):
            return jsonify({"error": "Invalid year"}), 400
    try:
        days = int(request.args.get("days", 365))
    except (TypeError, ValueError):
        days = 365
    return jsonify(db.dashboard_summary(day, days, parsed_year))


if __name__ == "__main__":
    app.run(port=8080, debug=True)
