# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec: ONE-FOLDER build (one-file re-extracts on every launch,
# is slow and trips antivirus). No console window: the timer opens in its own
# window, closing that window stops it, and problems appear in a pop-up.
#
#   python -m PyInstaller muhurata.spec        ->  dist/Muhurta Pomodoro/
#                                                  (+ dist/Muhurta Pomodoro.app on a Mac)
import re
import sys

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
    name="Muhurta Pomodoro",
    debug=False,
    strip=False,
    upx=False,
    console=False,
    icon="packaging/icon.icns" if sys.platform == "darwin" else None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="Muhurta Pomodoro",
)

if sys.platform == "darwin":
    VERSION = re.search(r'"(.+)"', open("version.py").read()).group(1)
    app = BUNDLE(
        coll,
        name="Muhurta Pomodoro.app",
        icon="packaging/icon.icns",
        bundle_identifier="com.muhurata.timer",
        version=VERSION,
        info_plist={
            "CFBundleDisplayName": "Muhurta Pomodoro",
            "NSHighResolutionCapable": True,
            # The app draws the timer's window itself (pywebview), so it gets
            # a Dock icon and a menu bar like any other app.
        },
    )
