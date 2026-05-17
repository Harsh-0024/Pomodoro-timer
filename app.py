from __future__ import annotations

import re
import sqlite3
from datetime import datetime

from flask import Flask, jsonify, render_template, request

import db
from presets import BUILTINS

app = Flask(__name__)
app.config["JSON_SORT_KEYS"] = False


@app.before_request
def _ensure_db():
    db.init_db()


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
    return render_template("index.html")


@app.route("/settings")
def settings_page():
    return render_template("settings.html")


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
        db.save_settings({"default_preset_id": "builtin-navin"})
    return "", 204


@app.get("/api/settings")
def api_get_settings():
    return jsonify(db.load_settings())


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


if __name__ == "__main__":
    app.run(debug=True, port=5050)
