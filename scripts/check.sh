#!/bin/sh
set -eu
task_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$task_root"
# Tests and package probes must never send production usage events.
export IPHONE_USE_ANALYTICS=0
# DSH plugin first: the generated table, the package, and the install path are
# cheap and device-free, so they must be checked even when a later, slower
# suite cannot run on this machine.
python3 dsh/scripts/emit_tools.py --check
node dsh/scripts/build.mjs
node --test --test-timeout=20000 'dsh/plugin/test/**/*.test.js'
python3 -m unittest discover -s tests -v
python3 scripts/package.py --validate-only
node --check tooling/forward.mjs
node --check tooling/screen-stream.mjs
python3 scripts/check_screen_ui.py
