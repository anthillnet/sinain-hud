# -*- mode: python ; coding: utf-8 -*-
# SEED-001 Phase 2: PyInstaller spec for bundling sense_client (SCAFFOLD / STUB)
#
# Builds a self-contained sense_client so the DMG needs no system Python.
# See docs/dmg-distribution-spec.md §3 (Bundle Layout) and §9 Q3.
#
# This is a STARTING-POINT skeleton, NOT a verified spec. The hiddenimports and
# datas below are best-guess from sense_client's deps (Pillow for image work,
# the OpenRouter/Ollama vision clients, OCR backends). They must be validated by
# an actual `pyinstaller tools/dmg/sense_client.spec` run during Phase 2 — OCR
# and vision libraries are notorious for missing dynamic imports.
#
# Open question Q3: one-folder (below) vs. one-file vs. shipping sense_client as
# an optional download. One-folder is assumed here (faster startup, easier signing).

block_cipher = None

a = Analysis(
    ['../../sense_client/__main__.py'],
    pathex=['../../'],
    binaries=[],
    datas=[],
    hiddenimports=[
        # TODO(Phase 2): verify against actual import graph.
        'PIL',
        'PIL._imaging',
        'sense_client.vision',
        'sense_client.ollama_vision',
        'sense_client.ocr',
        'sense_client.change_detector',
        'sense_client.privacy',
        'sense_client.capture',
    ],
    hookspath=[],
    runtime_hooks=[],
    excludes=[],
    cipher=block_cipher,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name='sense_client',
    console=True,
)

coll = COLLECT(
    exe, a.binaries, a.zipfiles, a.datas,
    name='sense_client',  # one-folder output → Contents/Resources/sense_client/
)
