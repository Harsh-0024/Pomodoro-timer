"""Single source of truth for the SQLite schema.

Alembic diffs these Table objects against the live database to generate
migrations (``python -m alembic revision --autogenerate -m "..."``).
The app itself still talks to SQLite through the stdlib ``sqlite3`` module;
nothing here is used at query time.
"""
from sqlalchemy import (
    CheckConstraint,
    Column,
    Index,
    Integer,
    MetaData,
    Table,
    Text,
    text,
)
from sqlalchemy.dialects.sqlite import REAL

# Primary-key columns are declared nullable=True on purpose: the original
# executescript DDL wrote ``id INTEGER PRIMARY KEY`` with no explicit NOT NULL,
# and SQLite reflects that as nullable. Matching it keeps autogenerate quiet
# and makes fresh databases identical to existing ones. (INTEGER PRIMARY KEY
# is a rowid alias and can never actually be NULL.)
metadata = MetaData()

# Sync bookkeeping (migration 0002). Rows that sync between computers carry:
#   uuid            id shared by every computer
#   updated_at      last change, UTC ISO with milliseconds
#   synced_version  the updated_at value the server last confirmed
# SQLite triggers fill uuid/updated_at and record deletes in sync_tombstones;
# they live in the migration because Alembic does not track triggers.


def _sync_columns():
    return [
        Column("uuid", Text),
        Column("updated_at", Text),
        Column("synced_version", Text),
    ]

app_settings = Table(
    "app_settings",
    metadata,
    Column("id", Integer, primary_key=True, nullable=True),
    Column("json", Text, nullable=False, server_default=text("'{}'")),
    *_sync_columns(),
    CheckConstraint("id = 1"),
    Index("ux_app_settings_uuid", "uuid", unique=True),
)

custom_presets = Table(
    "custom_presets",
    metadata,
    Column("id", Integer, primary_key=True, nullable=True),
    Column("name", Text, nullable=False),
    Column("work_min", Integer, nullable=False),
    Column("short_rest_min", Integer, nullable=False),
    Column("long_rest_min", Integer, nullable=False),
    Column("created_at", Text, nullable=False, server_default=text("(datetime('now'))")),
    *_sync_columns(),
    Index("ux_custom_presets_uuid", "uuid", unique=True),
    sqlite_autoincrement=True,
)

# One running total per day *per computer*; the day's total is their sum.
# Each computer only ever writes its own rows, so syncing never loses minutes.
focus_by_device = Table(
    "focus_by_device",
    metadata,
    Column("day", Text, primary_key=True),
    Column("device_id", Text, primary_key=True),
    Column("minutes", Integer, nullable=False, server_default=text("0")),
    Column("updated_at", Text, nullable=False),
    Column("synced_version", Text),
)

local_device = Table(
    "local_device",
    metadata,
    Column("id", Integer, primary_key=True, nullable=True),
    Column("device_id", Text, nullable=False),
    Column("created_at", Text, nullable=False, server_default=text("(datetime('now'))")),
    CheckConstraint("id = 1"),
)

sync_tombstones = Table(
    "sync_tombstones",
    metadata,
    Column("table_name", Text, primary_key=True),
    Column("uuid", Text, primary_key=True),
    Column("deleted_at", Text, nullable=False),
    Column("synced_version", Text),
)

activity_segments = Table(
    "activity_segments",
    metadata,
    Column("id", Integer, primary_key=True, nullable=True),
    Column("day", Text, nullable=False),
    Column("kind", Text, nullable=False),
    Column("started_at", Text, nullable=False),
    Column("ended_at", Text, nullable=False),
    Column("duration_sec", REAL, nullable=False),
    Column("productive_sec", REAL, nullable=False, server_default=text("0")),
    Column("rest_sec", REAL, nullable=False, server_default=text("0")),
    Column("preset_id", Text),
    Column("preset_name", Text),
    Column("phase_index", Integer),
    Column("details_json", Text, nullable=False, server_default=text("'{}'")),
    Column("created_at", Text, nullable=False, server_default=text("(datetime('now'))")),
    *_sync_columns(),
    Column("device_id", Text),  # the computer that recorded it (0003)
    Index("idx_activity_segments_day", "day", "started_at"),
    Index("ux_activity_segments_uuid", "uuid", unique=True),
    sqlite_autoincrement=True,
)
