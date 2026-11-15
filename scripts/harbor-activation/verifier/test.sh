#!/bin/sh
set -eu
python3 /tests/verify.py --state /private/state.json --workspace /workspace --evidence /capture --output /logs/verifier --prompt "$(cat /tests/prompt.txt)"
