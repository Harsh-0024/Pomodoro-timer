"""remember which computer recorded each session

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-19

Once sessions sync, two computers timing at the same moment produce
overlapping sessions. The dashboard counts that shared time once - but only
between *different* computers; overlaps on one computer keep counting as
they always have. For that, every session records its computer.

Existing sessions were all recorded here. New ones get this computer's id
from the insert trigger; sessions downloaded from another computer arrive
with theirs, which the trigger leaves alone.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0003'
down_revision: Union[str, Sequence[str], None] = '0002'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
NEW_UUID = (
    "(SELECT lower(substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3)"
    " || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(h, 18, 3)"
    " || '-' || substr(h, 21, 12)) FROM (SELECT hex(randomblob(16)) AS h))"
)
THIS_DEVICE = "(SELECT device_id FROM local_device WHERE id = 1)"
# Same as in 0002.
UPDATE_TRIGGER = f"""
    CREATE TRIGGER activity_segments_sync_update AFTER UPDATE ON activity_segments
    WHEN NEW.updated_at IS OLD.updated_at AND NEW.synced_version IS OLD.synced_version
    BEGIN
        UPDATE activity_segments SET updated_at = {NOW} WHERE rowid = NEW.rowid;
    END
"""


def _insert_trigger(with_device: bool) -> str:
    cond = "NEW.uuid IS NULL OR NEW.updated_at IS NULL" + (" OR NEW.device_id IS NULL" if with_device else "")
    sets = f"uuid = COALESCE(uuid, {NEW_UUID}), updated_at = COALESCE(updated_at, {NOW})"
    if with_device:
        sets += f", device_id = COALESCE(device_id, {THIS_DEVICE})"
    return f"""
        CREATE TRIGGER activity_segments_sync_insert AFTER INSERT ON activity_segments
        WHEN {cond}
        BEGIN
            UPDATE activity_segments SET {sets} WHERE rowid = NEW.rowid;
        END
    """


def upgrade() -> None:
    with op.batch_alter_table('activity_segments', recreate='never') as batch_op:
        batch_op.add_column(sa.Column('device_id', sa.Text(), nullable=True))
    # Filling the new column is bookkeeping, not an edit, so the trigger that
    # marks edited rows is paused while it runs.
    op.execute("DROP TRIGGER activity_segments_sync_update")
    op.execute(f"UPDATE activity_segments SET device_id = {THIS_DEVICE}")
    op.execute(UPDATE_TRIGGER)
    op.execute("DROP TRIGGER activity_segments_sync_insert")
    op.execute(_insert_trigger(with_device=True))


def downgrade() -> None:
    op.execute("DROP TRIGGER activity_segments_sync_insert")
    op.execute(_insert_trigger(with_device=False))
    with op.batch_alter_table('activity_segments', recreate='never') as batch_op:
        batch_op.drop_column('device_id')
