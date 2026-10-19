# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec: ONE-FOLDER build (one-file re-extracts on every launch,
# is slow and trips antivirus). No console window: the timer opens in its own
# window, closing that window stops it, and problems appear in a pop-up.
#
#   python -m PyInstaller muhurata.spec        ->  dist/Muhurata Timer/
#                                                  (+ dist/Muhurata Timer.app on a Mac)
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
    name="Muhurata Timer",
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
    name="Muhurata Timer",
)

if sys.platform == "darwin":
    VERSION = re.search(r'"(.+)"', open("version.py").read()).group(1)
    app = BUNDLE(
        coll,
        name="Muhurata Timer.app",
        icon="packaging/icon.icns",
        bundle_identifier="com.muhurata.timer",
        version=VERSION,
        info_plist={
            "CFBundleDisplayName": "Muhurata Timer",
            "NSHighResolutionCapable": True,
            # The timer's window is the app; the launcher underneath has no
            # window, so no Dock icon or "not responding" for it.
            "LSUIElement": True,
        },
    )
