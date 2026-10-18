"""sync bookkeeping: row ids, change times, delete markers, per-device totals

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-19

Prepares the local database for offline-first sync without changing what
the app shows:

* activity_segments, custom_presets, app_settings gain
    uuid            id shared by every computer (rowids clash between them)
    updated_at      when the row last changed, UTC ISO with milliseconds
    synced_version  the updated_at value the server last confirmed;
                    a row needs uploading when the two differ
* sync_tombstones remembers deleted rows, so a delete reaches the other
  computers instead of being undone by their copy.
* daily_focus (one running total per day) becomes focus_by_device (one
  total per day per computer). Totals from two computers then add up,
  rather than one overwriting the other.
* local_device holds this computer's id.

Triggers keep uuid / updated_at / tombstones current, so the app's existing
INSERT / UPDATE / DELETE statements need no changes. SQLite cannot give an
added column a non-constant default, which is the other reason they are
triggers.
"""
import uuid
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0002'
down_revision: Union[str, Sequence[str], None] = '0001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
# A random version-4 UUID in canonical form, built in SQL for the triggers.
NEW_UUID = (
    "(SELECT lower(substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3)"
    " || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(h, 18, 3)"
    " || '-' || substr(h, 21, 12)) FROM (SELECT hex(randomblob(16)) AS h))"
)
SYNCED_TABLES = ("activity_segments", "custom_presets", "app_settings")
# Tables whose deletes must reach other computers (app_settings is never deleted).
DELETABLE = ("activity_segments", "custom_presets")


def _create_triggers(table: str) -> None:
    op.execute(f"""
        CREATE TRIGGER {table}_sync_insert AFTER INSERT ON {table}
        WHEN NEW.uuid IS NULL OR NEW.updated_at IS NULL
        BEGIN
            UPDATE {table}
            SET uuid = COALESCE(uuid, {NEW_UUID}), updated_at = COALESCE(updated_at, {NOW})
            WHERE rowid = NEW.rowid;
        END
    """)
    # Fires on an ordinary edit. Sync itself sets updated_at or
    # synced_version explicitly, which this leaves alone - otherwise marking
    # a row as uploaded would mark it as changed again.
    op.execute(f"""
        CREATE TRIGGER {table}_sync_update AFTER UPDATE ON {table}
        WHEN NEW.updated_at IS OLD.updated_at AND NEW.synced_version IS OLD.synced_version
        BEGIN
            UPDATE {table} SET updated_at = {NOW} WHERE rowid = NEW.rowid;
        END
    """)
    if table in DELETABLE:
        op.execute(f"""
            CREATE TRIGGER {table}_sync_delete AFTER DELETE ON {table}
            WHEN OLD.uuid IS NOT NULL
            BEGIN
                INSERT INTO sync_tombstones (table_name, uuid, deleted_at)
                VALUES ('{table}', OLD.uuid, {NOW})
                ON CONFLICT (table_name, uuid) DO UPDATE SET
                    deleted_at = excluded.deleted_at, synced_version = NULL;
            END
        """)


def upgrade() -> None:
    conn = op.get_bind()

    op.create_table(
        'local_device',
        sa.Column('id', sa.Integer(), nullable=True),
        sa.Column('device_id', sa.Text(), nullable=False),
        sa.Column('created_at', sa.Text(), server_default=sa.text("(datetime('now'))"), nullable=False),
        sa.CheckConstraint('id = 1'),
        sa.PrimaryKeyConstraint('id'),
    )
    device_id = str(uuid.uuid4())
    conn.execute(sa.text("INSERT INTO local_device (id, device_id) VALUES (1, :d)"), {"d": device_id})

    op.create_table(
        'sync_tombstones',
        sa.Column('table_name', sa.Text(), nullable=False),
        sa.Column('uuid', sa.Text(), nullable=False),
        sa.Column('deleted_at', sa.Text(), nullable=False),
        sa.Column('synced_version', sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint('table_name', 'uuid'),
    )

    for table in SYNCED_TABLES:
        with op.batch_alter_table(table, recreate='never') as batch_op:
            batch_op.add_column(sa.Column('uuid', sa.Text(), nullable=True))
            batch_op.add_column(sa.Column('updated_at', sa.Text(), nullable=True))
            batch_op.add_column(sa.Column('synced_version', sa.Text(), nullable=True))
        # Existing rows: a fresh uuid each, and their creation time as the
        # change time (app_settings has no created_at, so "now").
        has_created = table != "app_settings"
        rows = conn.execute(sa.text(f"SELECT rowid FROM {table}")).scalars().all()
        for rowid in rows:
            conn.execute(
                sa.text(
                    f"UPDATE {table} SET uuid = :u, updated_at = "
                    + (f"strftime('%Y-%m-%dT%H:%M:%fZ', created_at)" if has_created else NOW)
                    + " WHERE rowid = :r"
                ),
                {"u": str(uuid.uuid4()), "r": rowid},
            )
        op.create_index(f'ux_{table}_uuid', table, ['uuid'], unique=True)
        _create_triggers(table)

    op.create_table(
        'focus_by_device',
        sa.Column('day', sa.Text(), nullable=False),
        sa.Column('device_id', sa.Text(), nullable=False),
        sa.Column('minutes', sa.Integer(), server_default=sa.text('0'), nullable=False),
        sa.Column('updated_at', sa.Text(), nullable=False),
        sa.Column('synced_version', sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint('day', 'device_id'),
    )
    # Every total recorded so far was recorded on this computer.
    conn.execute(
        sa.text(
            f"INSERT INTO focus_by_device (day, device_id, minutes, updated_at) "
            f"SELECT day, :d, minutes, {NOW} FROM daily_focus WHERE day IS NOT NULL"
        ),
        {"d": device_id},
    )
    op.drop_table('daily_focus')


def downgrade() -> None:
    op.create_table(
        'daily_focus',
        sa.Column('day', sa.Text(), nullable=True),
        sa.Column('minutes', sa.Integer(), server_default=sa.text('0'), nullable=False),
        sa.PrimaryKeyConstraint('day'),
    )
    op.execute(
        "INSERT INTO daily_focus (day, minutes) "
        "SELECT day, SUM(minutes) FROM focus_by_device GROUP BY day"
    )
    op.drop_table('focus_by_device')

    for table in SYNCED_TABLES:
        for suffix in ("insert", "update", "delete"):
            op.execute(f"DROP TRIGGER IF EXISTS {table}_sync_{suffix}")
        op.drop_index(f'ux_{table}_uuid', table_name=table)
        with op.batch_alter_table(table, recreate='never') as batch_op:
            batch_op.drop_column('synced_version')
            batch_op.drop_column('updated_at')
            batch_op.drop_column('uuid')

    op.drop_table('sync_tombstones')
    op.drop_table('local_device')
