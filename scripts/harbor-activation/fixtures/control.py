#!/usr/bin/env python3
"""Orchestrator-only synthetic account change; no real money or subscription."""
import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("resolve",))
    parser.add_argument("--state", required=True)
    parser.add_argument("--credits", type=int, default=20)
    args = parser.parse_args()
    if args.credits < 1:
        parser.error("resolution requires positive synthetic credits")
    state = Path(args.state)
    if not state.exists():
        parser.error("fixture state does not exist")
    command = state.with_suffix(".control.json")
    temporary = command.with_suffix(".tmp")
    temporary.write_text(json.dumps({"resolve": True, "credits": args.credits}))
    temporary.chmod(0o600)
    temporary.replace(command)
    print("Simulated account issue resolved; the next request receives the updated state.")


if __name__ == "__main__":
    main()
