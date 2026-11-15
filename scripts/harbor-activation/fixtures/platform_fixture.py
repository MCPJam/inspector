"""Minimal stateful authoring contract for the simulated platform.

This is not a hosted model engine. Unsupported case kinds are explicit fixture
gaps, and must invalidate a trial instead of becoming product findings.
"""
import copy
import time
from predicates import evaluate, positive_integer, supported


def public_suite(value):
    return {k: v for k, v in value.items() if k != "cases"}


def authoring(state, method, tail, body, public_url, project, default_suite):
    state.setdefault("servers", [{"id": "server_fixture", "name": "Arithmetic", "projectId": project,
                                  "transportType": "http", "url": public_url + "/mcp", "enabled": True,
                                  "useOAuth": False, "hasClientSecret": False}])
    state.setdefault("suites", {default_suite["id"]: {**default_suite, "cases": [{"id": "case_add", "title": "add 2 and 3 returns 5", "steps": [{"id": "add", "kind": "toolCall", "toolName": "add", "arguments": {"a": 2, "b": 3}}], "expectedOutput": "5"}]}})
    if tail == "/servers":
        if method == "GET":
            return 200, {"items": state["servers"]}
        if method == "POST":
            if body.get("url") != public_url + "/mcp":
                return 422, {"code": "FEATURE_NOT_SUPPORTED", "message": "Synthetic fixture only executes its supplied MCP endpoint.", "details": {"reason": "fixture_unsupported_endpoint"}}
            row = {"id": "server_authored_" + str(len(state["servers"])), "projectId": project,
                   "name": body.get("name", "Arithmetic"), "transportType": "http", "url": body["url"],
                   "enabled": True, "useOAuth": False, "hasClientSecret": False, "createdAt": int(time.time() * 1000), "updatedAt": int(time.time() * 1000)}
            state["servers"].append(row)
            return 201, row
    server_parts = tail.strip("/").split("/")
    if len(server_parts) >= 2 and server_parts[0] == "servers":
        server = next((s for s in state["servers"] if s["id"] == server_parts[1]), None)
        if server is not None and len(server_parts) == 2 and method == "DELETE":
            state["servers"].remove(server)
            return 200, {"id": server["id"], "deleted": True}
        if server is not None and server_parts[2:] == ["tools"] and method == "POST":
            return 200, {"items": [{"name": "add", "description": "Add two finite numbers.", "inputSchema": {"type": "object", "properties": {"a": {"type": "number"}, "b": {"type": "number"}}, "required": ["a", "b"]}}]}
    if tail == "/models" and method == "GET":
        return 200, {"items": [{"id": "anthropic/claude-haiku-4.5", "name": "Synthetic fixture runner", "provider": "anthropic"}]}
    if tail == "/eval-suites" and method == "GET":
        return 200, {"items": [public_suite(s) for s in state["suites"].values()]}
    from_file = tail == "/eval-suites/from-file"
    if method == "POST" and (tail == "/eval-suites" or from_file):
        declared = body.get("declaredSuiteId") if from_file else None
        previous = next((s for s in state["suites"].values() if declared and s.get("declaredId") == declared), None)
        sid = previous["id"] if previous else "suite_authored_" + str(len(state["suites"]))
        created = {**copy.deepcopy(default_suite), "id": sid, "name": body.get("name", "Authored smoke"),
                   "environment": {"servers": body.get("serverNames", [])},
                   "cases": previous["cases"] if previous else copy.deepcopy(body.get("tests", []))}
        for field in ("settings", "executionConfig"):
            if field in body:
                created[field] = copy.deepcopy(body[field])
        if declared:
            created["declaredId"] = declared
        for i, case in enumerate(created["cases"]):
            case.setdefault("id", f"{sid}_case_{i}")
            case["suiteId"] = sid
        state["suites"][sid] = created
        if from_file:
            return (200 if previous else 201), {"created": previous is None, "suite": public_suite(created)}
        return 201, {"suiteId": sid, "name": created["name"], "servers": [{"id": s} for s in body.get("serverIds", [])], "hosts": [], "caseUpsert": {"committed": [{"id": c["id"], "name": c.get("title")} for c in created["cases"]], "failed": []}}
    parts = tail.strip("/").split("/")
    if len(parts) < 2 or parts[0] != "eval-suites" or parts[1] not in state["suites"]:
        return None
    selected = state["suites"][parts[1]]
    if len(parts) == 2:
        if method == "GET":
            return 200, public_suite(selected)
        if method == "PATCH":
            for field in ("name", "description", "settings", "executionConfig"):
                if field in body:
                    selected[field] = body[field]
            return 200, public_suite(selected)
    if parts[2:] == ["runs"] and method == "GET":
        return 200, {"items": [r for r in state["runs"].values() if r["suiteId"] == selected["id"]]}
    if parts[2:] == ["cases"] and method == "GET":
        return 200, {"items": selected["cases"]}
    if parts[2:] in (["cases"], ["cases", "batch"]) and method == "POST":
        batch = parts[-1] == "batch"
        rows = body.get("cases", []) if batch else [body]
        created = []
        for i, source in enumerate(rows):
            row = copy.deepcopy(source)
            row["declaredId"] = source.get("id")
            row["id"] = f"{selected['id']}_case_{len(selected['cases'])}"
            row["suiteId"] = selected["id"]
            selected["cases"].append(row)
            created.append({"index": i, "id": row["id"], "declaredId": row["declaredId"], "title": row.get("title"), "replayed": False})
        return 201, {"created": created, "failed": [], "duplicatePolicy": "block"} if batch else selected["cases"][-1]
    if len(parts) == 4 and parts[2] == "cases":
        found = next((c for c in selected["cases"] if c["id"] == parts[3]), None)
        if found and method == "PATCH":
            found.update(body)
            return 200, found
        if found and method == "DELETE":
            selected["cases"].remove(found)
            return 200, {"id": parts[3], "deleted": True}
    return None


def execute_cases(cases, tool_result, iteration_override=None, minimum_iterations=1):
    """Only deterministic tool calls; unimplemented semantics never pass."""
    outcomes = []
    planned = []
    if not isinstance(cases, list) or not positive_integer(minimum_iterations):
        return None
    for case in cases:
        if not isinstance(case, dict) or not isinstance(case.get("steps"), list):
            return None
        # Do not silently drop alternate grading surfaces or negative cases.
        if any(case.get(key) for key in ("predicates", "checks", "assertions", "expectedToolCalls", "isNegative", "isNegativeTest")):
            return None
        if "runs" in case and "iterations" in case:
            return None
        configured = case.get("runs", case.get("iterations", 1))
        if not positive_integer(configured):
            return None
        count = iteration_override if iteration_override is not None else max(configured, minimum_iterations)
        if not positive_integer(count) or count > 10:
            return None
        for step in case["steps"]:
            if not isinstance(step, dict):
                return None
            if step.get("kind") == "assert":
                if set(step) - {"id", "kind", "assertion"} or not supported(step.get("assertion")):
                    return None
            elif step.get("kind") == "toolCall":
                if set(step) - {"id", "kind", "serverId", "serverName", "toolName", "arguments"}:
                    return None
                if not isinstance(step.get("toolName"), str) or not isinstance(step.get("arguments"), dict):
                    return None
            else:
                return None
        planned.extend((case, number) for number in range(1, count + 1))
    for case, number in planned:
        calls, text, passed = [], "", True
        for step in case["steps"]:
            if step["kind"] == "toolCall":
                result = tool_result(step["toolName"], step["arguments"])
                passed = passed and not result["isError"]
                text = " ".join(c.get("text", "") for c in result["content"])
                calls.append({"toolName": step["toolName"], "arguments": step["arguments"], "result": result})
            else:
                verdict = evaluate(step["assertion"], calls)
                if verdict is None:
                    return None
                passed = passed and verdict
        if not calls:
            return None
        if case.get("expectedOutput"):
            passed = passed and str(case["expectedOutput"]) in text
        outcomes.append({"case_id": case["id"], "iteration_number": number, "title": case.get("title", "Arithmetic"), "passed": passed, "calls": calls})
    return outcomes or None
