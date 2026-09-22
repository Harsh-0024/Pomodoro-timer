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

app_settings = Table(
    "app_settings",
    metadata,
    Column("id", Integer, primary_key=True, nullable=True),
    Column("json", Text, nullable=False, server_default=text("'{}'")),
    CheckConstraint("id = 1"),
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
    sqlite_autoincrement=True,
)

daily_focus = Table(
    "daily_focus",
    metadata,
    Column("day", Text, primary_key=True, nullable=True),
    Column("minutes", Integer, nullable=False, server_default=text("0")),
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
    Index("idx_activity_segments_day", "day", "started_at"),
    sqlite_autoincrement=True,
)
