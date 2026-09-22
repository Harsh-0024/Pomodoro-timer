"""Alembic environment.

Entered two ways:
  * from the CLI (``python -m alembic ...``) with alembic.ini loaded, and
  * programmatically from ``db.init_db()`` on app startup, with no ini file.

The database URL is resolved in this order:
  1. ``-x db=/path/to/file.db`` on the CLI (handy for generating a migration
     against a throwaway database instead of the real one),
  2. ``sqlalchemy.url`` set on the Config object (what ``db.py`` does),
  3. ``db.DB_PATH`` — the app's real database.
"""
import sys
from logging.config import fileConfig
from pathlib import Path

from sqlalchemy import create_engine, pool

from alembic import context

# Make ``schema`` and ``db`` importable no matter where alembic is invoked from.
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import schema  # noqa: E402

config = context.config

# Only configure logging when driven by alembic.ini; when called from the app
# we must not clobber Flask's logging setup.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = schema.metadata


def _resolve_url() -> str:
    x_args = context.get_x_argument(as_dictionary=True)
    if "db" in x_args:
        return f"sqlite:///{Path(x_args['db']).expanduser().resolve()}"
    url = config.get_main_option("sqlalchemy.url")
    if url:
        return url
    import db  # noqa: E402  (deferred: only needed when nothing else set a URL)

    return f"sqlite:///{db.DB_PATH}"


def _configure_kwargs() -> dict:
    return {
        "target_metadata": target_metadata,
        # SQLite can't ALTER most things in place; batch mode rebuilds the
        # table via a temp copy, which is the only way to drop/alter columns.
        "render_as_batch": True,
        "compare_type": True,
        "compare_server_default": True,
    }


def run_migrations_offline() -> None:
    context.configure(
        url=_resolve_url(),
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        **_configure_kwargs(),
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = create_engine(_resolve_url(), poolclass=pool.NullPool)
    with connectable.connect() as connection:
        context.configure(connection=connection, **_configure_kwargs())
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
