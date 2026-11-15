#!/usr/bin/env python3
"""Deterministic MCP + *simulated* MCPJam API. Never contacts a billing service.

Run this in a separate container. Mount state only in that container and the
orchestrator/verifier; do not mount this source or state in the tester container.
API shapes follow cli/tests/eval.test.ts and support/fake-mcpjam.ts at c8c4d471.
"""
import argparse
import hashlib
import json
import math
import os
import threading
import tarfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
from platform_fixture import authoring, execute_cases

PROJECT = "project_fixture"
SUITE = "suite_fixture"
ORG = "org_fixture"
TOKEN = "fixture-server-token"
API_KEY = "sk_fixture_synthetic"


def initial_state(scenario, seed, role="owner", plan="team"):
    return {
        "schema_version": 1, "simulation": True, "scenario": scenario,
        "seed": seed, "role": role, "plan": plan, "started_at": time.time(),
        "credits": 0 if scenario == "credits" else 20,
        "initial_credits": 0 if scenario == "credits" else 20,
        "account_resolved_at": None, "requests": [], "tool_calls": [],
        "runs": {}, "run_outcomes": {}, "idempotency": {}, "charges": [], "refusals": [],
    }


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.RLock()

    def change(self, fn):
        # Control writes use a separate command file, avoiding read/write races
        # between two processes replacing the same ledger.
        with self.lock:
            state = json.loads(self.path.read_text())
            control = self.path.with_suffix(".control.json")
            if control.exists():
                update = json.loads(control.read_text())
                if update.get("resolve"):
                    state["credits"] = update.get("credits", 20)
                    state["account_resolved_at"] = time.time()
                control.unlink()
            result = fn(state)
            temporary = self.path.with_suffix(".tmp")
            temporary.write_text(json.dumps(state, indent=2) + "\n")
            os.chmod(temporary, 0o600)
            temporary.replace(self.path)
            return result


def suite():
    return {"id": SUITE, "name": "Arithmetic smoke", "projectId": PROJECT,
            "description": "Synthetic fixture: add 2 and 3 and assert 5.",
            "environment": {"servers": []}, "executionConfig": None,
            "hosts": [], "environmentIds": [], "settings": {"policy": "legacy", "minimumIterations": 1},
            "schedule": {}, "createdAt": 1, "updatedAt": 2}


def tool_result(name, args):
    if name != "add":
        return {"content": [{"type": "text", "text": "Unknown tool"}], "isError": True}
    numbers = [args.get("a"), args.get("b")]
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in numbers):
        return {"content": [{"type": "text", "text": "a and b must be finite numbers"}], "isError": True}
    total = sum(numbers)
    return {"content": [{"type": "text", "text": json.dumps({"sum": total})}],
            "structuredContent": {"sum": total}, "isError": False}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "HarborSyntheticFixture/1"

    def log_message(self, *_args):
        pass  # Request evidence is persisted without credentials below.

    def send(self, status, body=None, headers=None):
        encoded = b"" if body is None else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(encoded)

    def dispatch(self):
        path = urlsplit(self.path).path
        raw = self.rfile.read(min(int(self.headers.get("Content-Length", "0")), 1_000_000))
        try:
            body = json.loads(raw) if raw else {}
        except (ValueError, UnicodeDecodeError):
            return self.send(400, {"code": "VALIDATION_ERROR", "message": "Invalid JSON"})
        # Never persist Authorization, cookies, query strings or arbitrary bodies.
        self.server.store.change(lambda state: state["requests"].append({
            "time": time.time(), "method": self.command, "path": path,
            "rpc_method": body.get("method") if isinstance(body, dict) else None,
            "user_agent": self.headers.get("User-Agent", "")[:150],
        }))
        if self.command == "GET" and (path.startswith("/registry/") or path.startswith("/packages/")):
            return self.package(path)
        if path in ("/mcp", "/protected/mcp"):
            return self.mcp(path, body)
        if path.startswith("/api/v1/"):
            if self.headers.get("Authorization") != "Bearer " + API_KEY:
                self.server.store.change(lambda s: s["refusals"].append({"time": time.time(), "reason": "UNAUTHORIZED"}))
                return self.send(401, {"code": "UNAUTHORIZED", "message": "Invalid or expired MCPJam API key."})
            return self.platform(path, body)
        if path == "/health":
            return self.send(200, {"ok": True, "simulation": True})
        return self.send(404, {"code": "NOT_FOUND", "message": "Not found"})

    def package(self, path):
        requested = unquote(path.removeprefix("/registry/"))
        for archive in self.server.packages.glob("*.tgz"):
            if path == "/packages/" + archive.name:
                data = archive.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                return self.wfile.write(data)
            if path.startswith("/registry/"):
                with tarfile.open(archive, "r:gz") as tar:
                    manifest_file = tar.extractfile("package/package.json")
                    if manifest_file is None:
                        continue
                    manifest = json.load(manifest_file)
                if manifest.get("name") == requested:
                    version = manifest["version"]
                    manifest["dist"] = {"tarball": self.server.public_url + "/packages/" + archive.name,
                                        "shasum": hashlib.sha1(archive.read_bytes()).hexdigest()}
                    return self.send(200, {"name": requested, "dist-tags": {"latest": version}, "versions": {version: manifest}})
        self.send(404, {"error": "Package is not present in this trial's immutable distribution."})

    def mcp(self, path, body):
        auth_required = path == "/protected/mcp" or self.server.scenario == "auth"
        if auth_required and self.headers.get("Authorization") != "Bearer " + TOKEN:
            self.server.store.change(lambda s: s["refusals"].append({"time": time.time(), "reason": "MCP_AUTH_REQUIRED"}))
            return self.send(401, {"error": "invalid_token"}, {"WWW-Authenticate": 'Bearer realm="fixture", error="invalid_token"'})
        if self.command == "GET":
            return self.send(405, {"error": "Use POST"}, {"Allow": "POST, DELETE"})
        if self.command == "DELETE":
            return self.send(200)
        if not isinstance(body, dict) or body.get("jsonrpc") != "2.0":
            return self.send(400, {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid request"}})
        if "id" not in body:
            return self.send(202)
        method, params = body.get("method"), body.get("params") or {}
        if method == "initialize":
            version = params.get("protocolVersion", "2025-11-25")
            result = {"protocolVersion": version if version in ("2025-11-25", "2026-07-28", "2025-03-26") else "2025-11-25",
                      "capabilities": {"tools": {"listChanged": False}},
                      "serverInfo": {"name": "arithmetic-fixture", "version": "1.0.0"}}
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": [{"name": "add", "description": "Add two finite numbers and return their sum.",
                                  "inputSchema": {"type": "object", "properties": {"a": {"type": "number"}, "b": {"type": "number"}}, "required": ["a", "b"], "additionalProperties": False},
                                  "outputSchema": {"type": "object", "properties": {"sum": {"type": "number"}}, "required": ["sum"]},
                                  "annotations": {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False}}]}
        elif method == "tools/call":
            args = params.get("arguments", {})
            result = tool_result(params.get("name"), args)
            # Keep only known arithmetic inputs, not arbitrary user-supplied data.
            safe_args = {k: v for k, v in args.items() if k in ("a", "b") and isinstance(v, (int, float))}
            self.server.store.change(lambda s: s["tool_calls"].append({
                "time": time.time(), "name": "add" if params.get("name") == "add" else "unknown",
                "arguments": safe_args, "success": not result["isError"],
                "sum": result.get("structuredContent", {}).get("sum"), "source": "tester",
                "authenticated": auth_required,
            }))
        else:
            return self.send(200, {"jsonrpc": "2.0", "id": body["id"], "error": {"code": -32601, "message": "Method not found"}})
        self.send(200, {"jsonrpc": "2.0", "id": body["id"], "result": result})

    def platform(self, path, body):
        state = self.server.store.change(lambda s: dict(s))
        project = {"id": PROJECT, "name": "Fixture", "organizationId": ORG, "createdAt": 1, "updatedAt": 2}
        base = "/api/v1/projects/" + PROJECT
        if path.startswith(base + "/"):
            response = self.server.store.change(lambda s: authoring(s, self.command, path[len(base):], body, self.server.public_url, PROJECT, suite()))
            if response is not None:
                return self.send(*response)
        if self.command == "GET" and path == "/api/v1/me":
            return self.send(200, {"id": "user_fixture", "name": "Fixture user", "email": "fixture@example.test", "plan": state["plan"]})
        if self.command == "GET" and path == "/api/v1/organizations":
            return self.send(200, {"items": [{"id": ORG, "name": "Fixture organization", "plan": state["plan"], "myRole": state["role"], "isCreator": state["role"] == "owner", "logoUrl": None, "createdAt": 1}]})
        if self.command == "GET" and path == "/api/v1/projects":
            return self.send(200, {"items": [project]})
        if self.command == "GET" and path == base:
            return self.send(200, project)
        if self.command == "GET" and path == base + "/capabilities":
            return self.send(200, {"projectId": PROJECT, "organizationId": ORG, "role": state["role"], "projectRole": state["role"], "surface": "cli", "features": {"sandboxes": {"enabled": False, "mode": "off", "enforced": False}}, "plan": {"name": state["plan"], "limits": {}, "features": {}}, "can": {}})
        if self.command == "GET" and path == base + "/servers":
            return self.send(200, {"items": [{"id": "server_fixture", "name": "Arithmetic", "projectId": PROJECT, "transportType": "http", "url": self.server.public_url + "/mcp"}]})
        if self.command == "GET" and path == base + "/eval-suites":
            return self.send(200, {"items": [suite()]})
        if self.command == "GET" and path == base + "/eval-suites/" + SUITE:
            return self.send(200, suite())
        if self.command == "GET" and path == base + "/eval-suites/" + SUITE + "/cases":
            return self.send(200, {"items": [{"id": "case_add", "suiteId": SUITE, "title": "add 2 and 3 returns 5"}]})
        if self.command == "GET" and path.endswith("/run-disclosure"):
            return self.send(422, {"code": "FEATURE_NOT_SUPPORTED", "message": "The synthetic fixture does not implement disclosure.", "details": {"reason": "contract_unavailable"}})
        if self.command == "POST" and path == base + "/eval-runs":
            return self.launch(body)
        if self.command == "GET" and path == base + "/eval-suites/" + SUITE + "/runs":
            return self.send(200, {"items": list(state["runs"].values())})
        if self.command == "GET" and path.startswith(base + "/eval-runs/"):
            suffix = path[len(base + "/eval-runs/"):].split("/")
            run = state["runs"].get(suffix[0])
            if run and len(suffix) == 1:
                return self.send(200, run)
            if run and suffix[1:] == ["iterations"]:
                outcomes = state["run_outcomes"][run["id"]]
                return self.send(200, {"items": [{"id": run["id"] + "_" + str(i), "testCaseId": o["case_id"], "title": o["title"], "iterationNumber": o["iteration_number"], "status": "completed", "result": "passed" if o["passed"] else "failed", "actualToolCalls": o["calls"], "expectedToolCalls": [], "durationMs": 1, "error": None} for i, o in enumerate(outcomes)]})
        # Unsupported routes are explicit fixture gaps, never fabricated data.
        self.send(404, {"code": "NOT_FOUND", "message": "Synthetic fixture does not implement this route."})

    def launch(self, body):
        key = self.headers.get("Idempotency-Key") or body.get("idempotencyKey")
        key_digest = hashlib.sha256(key.encode()).hexdigest() if isinstance(key, str) else None

        def apply(state):
            selected = state.get("suites", {}).get(body.get("suiteId"))
            if selected is None:
                return 400, {"code": "VALIDATION_ERROR", "message": "Unknown suite."}
            if key_digest in state["idempotency"]:
                return 202, state["idempotency"][key_digest]
            if state["credits"] < 1:
                state["refusals"].append({"time": time.time(), "reason": "PLATFORM_FEE_REQUIRED"})
                return 403, {"code": "FORBIDDEN", "message": "This work requires platform credits. Add credits or contact your organization administrator.", "details": {"reason": "PLATFORM_FEE_REQUIRED"}}
            outcomes = execute_cases(selected["cases"], tool_result, body.get("iterationOverride"), (selected.get("settings") or {}).get("minimumIterations", 1) or 1)
            if outcomes is None:
                return 422, {"code": "FEATURE_NOT_SUPPORTED", "message": "Synthetic fixture supports deterministic toolCall steps and a validated assertion subset only. Unsupported or malformed fields, policies, and hosted prompt/model execution are refused without a charge.", "details": {"reason": "fixture_unsupported_execution"}}
            passed_count = sum(int(o["passed"]) for o in outcomes)
            passed = passed_count == len(outcomes)
            run_id = "run_fixture_" + str(len(state["runs"]) + 1)
            state["credits"] -= 1  # Synthetic unit, NOT a product price.
            state["charges"].append({"time": time.time(), "run_id": run_id, "synthetic_units": 1, "idempotency_digest": key_digest})
            for outcome in outcomes:
                for call in outcome["calls"]:
                    state["tool_calls"].append({"time": time.time(), "name": call["toolName"], "arguments": call["arguments"], "sum": call["result"].get("structuredContent", {}).get("sum"), "success": not call["result"]["isError"], "source": "simulated_eval", "run_id": run_id})
            state["run_outcomes"][run_id] = outcomes
            state["runs"][run_id] = {"id": run_id, "suiteId": selected["id"], "runNumber": len(state["runs"]) + 1, "status": "completed", "result": "passed" if passed else "failed", "summary": {"total": len(outcomes), "passed": passed_count, "failed": len(outcomes) - passed_count, "passRate": passed_count / len(outcomes)}, "source": "api", "notes": "SIMULATED: deterministic fixture execution; no hosted model or live billing.", "createdAt": int(time.time() * 1000), "completedAt": int(time.time() * 1000)}
            receipt = {"runId": run_id, "suiteId": selected["id"], "status": "running", "servers": [{"id": "server_fixture", "name": "Arithmetic"}], "environment": None}
            if key_digest:
                state["idempotency"][key_digest] = receipt
            return 202, receipt

        status, payload = self.server.store.change(apply)
        self.send(status, payload)

    do_GET = dispatch
    do_POST = dispatch
    do_DELETE = dispatch
    do_PATCH = dispatch


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", required=True)
    parser.add_argument("--scenario", choices=("healthy", "auth", "credits"), default="healthy")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--role", choices=("owner", "admin", "member"), default="owner")
    parser.add_argument("--plan", choices=("free", "pro", "team", "enterprise"), default="team")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--public-url")
    parser.add_argument("--packages", default="/packages")
    args = parser.parse_args()
    state_path = Path(args.state)
    state_path.parent.mkdir(parents=True, exist_ok=True)
    if state_path.exists():
        parser.error("Refusing to reuse state: choose a fresh trial state path.")
    state_path.write_text(json.dumps(initial_state(args.scenario, args.seed, args.role, args.plan)))
    os.chmod(state_path, 0o600)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.store = Store(state_path)
    server.scenario = args.scenario
    server.public_url = args.public_url or f"http://127.0.0.1:{args.port}"
    server.packages = Path(args.packages)
    print(json.dumps({"ready": True, "simulation": True, "port": args.port}), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
