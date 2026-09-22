# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec: ONE-FOLDER build (one-file re-extracts on every launch,
# is slow and trips antivirus). Console mode on purpose: the terminal window
# is how a friend sees "running at http://..." and how they stop the app.
#
#   python -m PyInstaller muhurata.spec        ->  dist/Muhurata Timer/

from PyInstaller.utils.hooks import collect_submodules

datas = [
    ("templates", "templates"),
    ("static", "static"),
    ("migrations", "migrations"),  # alembic loads env.py/versions from disk
]

hiddenimports = (
    collect_submodules("sqlalchemy.dialects.sqlite")
    + ["schema", "logging.config", "logging.handlers"]  # schema: only imported by migrations/env.py (a data file)
)

a = Analysis(
    ["run.py"],
    pathex=["."],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "pytest", "PyInstaller"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Muhurata Timer",
    debug=False,
    strip=False,
    upx=False,
    console=True,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="Muhurata Timer",
)
