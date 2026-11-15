#!/usr/bin/env python3
"""Independent private-ledger checks. Agent claims never establish success.

Mount this only for verification, after the tester has stopped. Unknown journey
facts stay null rather than being inferred from a successful tool call.
"""
import argparse
import datetime
import json
import re
from pathlib import Path


MCPJAM_COMMAND = re.compile(r"(?:\bmcpjam\b|@mcpjam/cli)")


def json_documents(text):
    decoder = json.JSONDecoder()
    offset = 0
    while offset < len(text):
        match = re.search(r"[\[{]", text[offset:])
        if not match:
            return
        start = offset + match.start()
        try:
            value, count = decoder.raw_decode(text[start:])
            yield value
            offset = start + count
        except ValueError:
            offset = start + 1


def has_sum(value, expected):
    if isinstance(value, dict):
        if value.get("isError") is True:
            return False
        structured = value.get("structuredContent")
        if isinstance(structured, dict) and structured.get("sum") == expected:
            return True
        return any(has_sum(v, expected) for v in value.values())
    return isinstance(value, list) and any(has_sum(v, expected) for v in value)


def captured_evidence(directory, successful, workspace=None, evals=None):
    matched, eval_commands, complete, commands = [], [], True, 0
    if not directory or not Path(directory).exists():
        return matched, eval_commands, False, 0
    for meta_path in Path(directory).rglob("event.json"):
        commands += 1
        meta = json.loads(meta_path.read_text())
        streams = [meta_path.with_name(name) for name in ("stdout.txt", "stderr.txt", "stream.jsonl")]
        if "exit_status" not in meta or not all(p.exists() for p in streams):
            complete = False
            continue
        invocation = " ".join(meta.get("argv", []))
        if not MCPJAM_COMMAND.search(invocation) or meta["exit_status"] != 0:
            continue
        start = datetime.datetime.fromisoformat(meta["start"]).timestamp()
        end = datetime.datetime.fromisoformat(meta["end"]).timestamp()
        output = streams[0].read_text(errors="replace")
        documents = list(json_documents(output))
        # Redirection is a normal terminal workflow. A real matching server
        # call during the command is still required, even when stdout is empty.
        if not output.strip() and workspace and Path(workspace).exists():
            for artifact in Path(workspace).rglob("*.json"):
                if artifact.stat().st_size < 100_000 and "node_modules" not in artifact.parts:
                    documents.extend(json_documents(artifact.read_text(errors="replace")))
        if re.search(r"\b(?:cloud\s+)?eval\s+run\b", invocation) and not re.search(r"(?:--help|\s-h\b)", invocation):
            if any(start - .001 <= run["createdAt"] / 1000 <= end and any(run["id"] in json.dumps(v) for v in documents) for run in (evals or [])):
                eval_commands.append(meta.get("event_id", meta_path.parent.name))
        if not re.search(r"\btools\s+call\b", invocation):
            continue
        if any(start <= c["time"] <= end and any(has_sum(v, c["sum"]) for v in documents) for c in successful):
            matched.append(meta.get("event_id", meta_path.parent.name))
    return matched, eval_commands, complete and commands > 0, commands


def reproducible_work(directory):
    if not directory or not Path(directory).exists():
        return []
    result = []
    for path in Path(directory).rglob("*"):
        if not path.is_file() or path.stat().st_size > 100_000 or "node_modules" in path.parts:
            continue
        if path.suffix not in (".json", ".yaml", ".yml", ".sh", ".md", ".mjs", ".js", ".ts"):
            continue
        text = path.read_text(errors="replace")
        command = MCPJAM_COMMAND.search(text) and re.search(r"\b(?:tools\s+call|eval\s+run|conformance)\b", text)
        configuration = '"mcpServers"' in text and "fixture:8765" in text
        result_artifact = any(has_sum(value, 5) for value in json_documents(text))
        if command or configuration or result_artifact:
            result.append(str(path.relative_to(directory)))
    return result


def score(state, prompt="B", evidence=None, workspace=None):
    successful = [c for c in state["tool_calls"] if c["success"] and c["source"] == "tester"]
    evals = [r for r in state["runs"].values() if r["status"] == "completed" and r["result"] == "passed"]
    refusals = state["refusals"]
    auth_refusals = [r for r in refusals if r["reason"] == "MCP_AUTH_REQUIRED"]
    credit_refusals = [r for r in refusals if r["reason"] == "PLATFORM_FEE_REQUIRED"]
    auth_recovery = bool(auth_refusals and any(c["authenticated"] and c["time"] > auth_refusals[0]["time"] for c in successful))
    completed_ids = {r["id"] for r in evals}
    credit_recovery = bool(credit_refusals and state["account_resolved_at"] and any(c["time"] >= state["account_resolved_at"] and c["run_id"] in completed_ids for c in state["charges"]))
    charge_ids = [c["run_id"] for c in state["charges"]]
    unique_charge_ids = len(set(charge_ids)) == len(charge_ids)
    preserved = all(r["suiteId"] in state.get("suites", {}) for r in evals)
    matches, eval_commands, evidence_complete, command_count = captured_evidence(evidence, successful, workspace, evals)
    artifacts = reproducible_work(workspace)
    first_value = bool(successful and matches)
    completed_eval = bool(evals and eval_commands)
    checks = {"A": first_value and bool(artifacts), "B": first_value and completed_eval and bool(artifacts),
              "C": auth_recovery and first_value and bool(artifacts), "D": credit_recovery and completed_eval and bool(artifacts)}
    earliest = successful[0]["time"] - state["started_at"] if successful else None
    return {
        "schema_version": 1, "simulation": True,
        "prompt": prompt, "task_success": checks[prompt],
        "first_meaningful_result": first_value,
        "server_observed_successful_tool_call": bool(successful),
        "time_to_first_result_seconds": earliest,
        "first_conformance_result": None,
        "first_eval_completed": completed_eval,
        "server_observed_simulated_eval": bool(evals),
        "eval_scope": "deterministic sandbox simulation, not a live hosted Eval",
        "correct_diagnosis": None,
        "successful_recovery": auth_recovery if state["scenario"] == "auth" else credit_recovery if state["scenario"] == "credits" else None,
        "auth_refusal_count": len(auth_refusals),
        "credit_refusal_count": len(credit_refusals),
        "repeated_ineffective_requests": max(0, len(auth_refusals) - 1) + max(0, len(credit_refusals) - 1),
        "state_preserved": preserved if evals else None,
        "duplicate_charges": len(charge_ids) - len(set(charge_ids)),
        "charge_count": len(charge_ids), "synthetic_credits_remaining": state["credits"],
        "human_handoff_correct": None, "credit_cost_understanding": None,
        "errors_explain_cause_action_actor": None, "evidence_completeness": evidence_complete,
        "mcpjam_tool_event_ids": matches, "mcpjam_eval_event_ids": eval_commands,
        "reproducible_artifacts": artifacts, "command_count": command_count,
        "reward": float(checks[prompt] and evidence_complete and unique_charge_ids and preserved),
        "request_count": len(state["requests"]),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", required=True)
    parser.add_argument("--output", default="/logs/verifier")
    parser.add_argument("--workspace")
    parser.add_argument("--evidence")
    parser.add_argument("--prompt", choices=("A", "B", "C", "D"), required=True)
    args = parser.parse_args()
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    try:
        result = score(json.loads(Path(args.state).read_text()), args.prompt, args.evidence, args.workspace)
        result["workspace_collected"] = bool(args.workspace and Path(args.workspace).exists())
        result["command_evidence_collected"] = bool(args.evidence and Path(args.evidence).exists())
    except (OSError, ValueError, KeyError) as error:
        result = {"reward": 0.0, "task_success": False, "harness_invalid": True, "error": str(error)}
    (output / "reward.txt").write_text(str(result["reward"]) + "\n")
    (output / "metrics.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
