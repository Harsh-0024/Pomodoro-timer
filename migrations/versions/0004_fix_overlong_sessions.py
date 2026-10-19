"""correct sessions saved longer than they really were

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-19

Until v1.3.1, resuming a paused focus block saved its last part as a whole
block, so it "ended" up to the full block length after it really did. The
minutes before the pause were already saved as their own session, so that
time was counted twice and ran over whatever came next. The background
monitor could also save a block the page had just saved.

The tell-tale sign: such a session claims to end after the moment it was
saved (created_at), which no finished session can. For those sessions on
this computer the end becomes the earliest of the old end, one second after
it was saved, and the start of the next session; length, focus and rest
follow from the new end. Exact duplicates (same kind and start) keep only
the first copy. Sessions added or edited by hand are never touched.

Every affected session is first copied unchanged into
activity_segments_fix_backup, and downgrading puts them back. The changes
reach other computers through sync like any edit.
"""
import json
from datetime import datetime, timedelta, timezone
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.sqlite import REAL


revision: str = '0004'
down_revision: Union[str, Sequence[str], None] = '0003'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TIMED_KINDS = ("work", "rest", "cumulative")
PRODUCTIVE_KINDS = ("work", "extend", "flow")
REST_KINDS = ("rest", "cumulative", "pause")
SAVED_LATE_SEC = 4  # a finished session is saved within a second or so of its end
COLUMNS = (
    "id", "day", "kind", "started_at", "ended_at", "duration_sec", "productive_sec", "rest_sec",
    "preset_id", "preset_name", "phase_index", "details_json", "created_at",
    "uuid", "updated_at", "synced_version", "device_id",
)


def _type(column: str):
    if column in ("id", "phase_index"):
        return sa.Integer()
    if column in ("duration_sec", "productive_sec", "rest_sec"):
        return REAL()
    return sa.Text()


def _parse(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def upgrade() -> None:
    op.create_table(
        'activity_segments_fix_backup',
        *[sa.Column(c, _type(c), nullable=True) for c in COLUMNS],
        sa.Column('fix_action', sa.Text(), nullable=False),  # "shortened" or "removed"
        sa.Column('fixed_at', sa.Text(), nullable=False),
    )
    conn = op.get_bind()
    device = conn.execute(sa.text("SELECT device_id FROM local_device WHERE id = 1")).scalar()
    rows = [dict(r._mapping) for r in conn.execute(sa.text(
        f"SELECT {', '.join(COLUMNS)} FROM activity_segments WHERE device_id IS :d "
        "ORDER BY julianday(started_at), id"), {"d": device})]
    fixed_at = _iso(datetime.now(timezone.utc))

    def backup(row, action):
        conn.execute(sa.text(
            f"INSERT INTO activity_segments_fix_backup ({', '.join(COLUMNS)}, fix_action, fixed_at) "
            f"VALUES ({', '.join(':' + c for c in COLUMNS)}, :fix_action, :fixed_at)"),
            {**row, "fix_action": action, "fixed_at": fixed_at})

    # 1. exact duplicates: the same block saved twice
    seen, keep = set(), []
    for row in rows:
        key = (row["kind"], row["started_at"])
        if key in seen:
            backup(row, "removed")
            conn.execute(sa.text("DELETE FROM activity_segments WHERE id = :id"), {"id": row["id"]})
        else:
            seen.add(key)
            keep.append(row)

    # 2. sessions that end after they were saved, or store more time than they span
    for i, row in enumerate(keep):
        if row["kind"] not in TIMED_KINDS:
            continue
        details = json.loads(row["details_json"] or "{}")
        if details.get("source") == "manual" or details.get("edit"):
            continue  # added or edited by hand: what the person said stands
        try:
            start, end = _parse(row["started_at"]), _parse(row["ended_at"])
            saved = datetime.fromisoformat(row["created_at"]).replace(tzinfo=timezone.utc)
        except (TypeError, ValueError):
            continue
        new_end = end
        if end > saved + timedelta(seconds=SAVED_LATE_SEC):
            candidates = [end, saved + timedelta(seconds=1)]
            later = [_parse(r["started_at"]) for r in keep[i + 1:i + 6] if _parse(r["started_at"]) > start]
            if later:
                candidates.append(min(later))
            new_end = min(candidates)
        span = (new_end - start).total_seconds()
        if span <= 0:
            continue
        if new_end == end and float(row["duration_sec"] or 0) <= span + SAVED_LATE_SEC:
            continue  # nothing wrong with this one
        backup(row, "shortened")
        conn.execute(sa.text(
            "UPDATE activity_segments SET ended_at = :end, duration_sec = :dur, "
            "productive_sec = :prod, rest_sec = :rest WHERE id = :id"),
            {"end": _iso(new_end), "dur": span,
             "prod": span if row["kind"] in PRODUCTIVE_KINDS else 0.0,
             "rest": span if row["kind"] in REST_KINDS else 0.0, "id": row["id"]})


def downgrade() -> None:
    conn = op.get_bind()
    now = _iso(datetime.now(timezone.utc))
    for row in [dict(r._mapping) for r in conn.execute(sa.text(
            f"SELECT {', '.join(COLUMNS)}, fix_action FROM activity_segments_fix_backup"))]:
        if row["fix_action"] == "shortened":
            conn.execute(sa.text(
                "UPDATE activity_segments SET ended_at = :ended_at, duration_sec = :duration_sec, "
                "productive_sec = :productive_sec, rest_sec = :rest_sec WHERE uuid = :uuid"), row)
        else:
            # Back in, as a fresh change so sync sends it up again.
            conn.execute(sa.text(
                f"INSERT INTO activity_segments ({', '.join(COLUMNS)}) "
                f"VALUES ({', '.join(':' + c for c in COLUMNS)})"),
                {**row, "updated_at": now, "synced_version": None})
            conn.execute(sa.text(
                "DELETE FROM sync_tombstones WHERE table_name = 'activity_segments' AND uuid = :uuid"), row)
    op.drop_table('activity_segments_fix_backup')
