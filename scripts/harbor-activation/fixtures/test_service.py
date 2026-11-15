"""Focused boundary tests for fixture isolation, charges, and verifier claims."""
import importlib.util
import datetime
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
import tarfile

from service import Handler, Store, initial_state, API_KEY, TOKEN, PROJECT, SUITE

spec = importlib.util.spec_from_file_location("verify", Path(__file__).parent.parent / "verifier" / "verify.py")
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


class FixtureTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "state.json"
        self.reset("healthy")
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.store = Store(self.path)
        self.server.scenario = "healthy"
        self.server.public_url = f"http://127.0.0.1:{self.server.server_port}"
        self.server.packages = Path(self.tmp.name) / "packages"
        self.server.packages.mkdir()
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.tmp.cleanup()

    def reset(self, scenario):
        self.path.write_text(json.dumps(initial_state(scenario, 42)))

    def request(self, path, body=None, token=None, key=None, method=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        if key:
            headers["Idempotency-Key"] = key
        request = urllib.request.Request(self.server.public_url + path, data=json.dumps(body).encode() if body is not None else None, headers=headers, method=method)
        try:
            response = urllib.request.urlopen(request)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            data = response.read()
            return response.status, json.loads(data) if data else None

    def call(self, token=None):
        return self.request("/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "add", "arguments": {"a": 2, "b": 3}}}, token)

    def test_healthy_first_value_requires_server_state(self):
        self.assertEqual(verify.score(json.loads(self.path.read_text()))["reward"], 0)
        status, body = self.call()
        self.assertEqual((status, body["result"]["structuredContent"]), (200, {"sum": 5}))
        scored = verify.score(json.loads(self.path.read_text()))
        self.assertTrue(scored["server_observed_successful_tool_call"])
        self.assertEqual(scored["reward"], 0)  # Direct HTTP isn't MCPJam evidence.

    def test_auth_recovery_after_refusal(self):
        self.reset("auth")
        self.server.scenario = "auth"
        self.assertEqual(self.call("expired")[0], 401)
        self.assertEqual(verify.score(json.loads(self.path.read_text()))["reward"], 0)
        self.assertEqual(self.call(TOKEN)[0], 200)
        self.assertTrue(verify.score(json.loads(self.path.read_text()))["successful_recovery"])
        self.assertNotIn(TOKEN, self.path.read_text())
        self.assertNotIn("expired", self.path.read_text())

    def test_zero_credits_recovery_and_idempotency(self):
        self.reset("credits")
        route = f"/api/v1/projects/{PROJECT}/eval-runs"
        body = {"suiteId": SUITE}
        self.assertEqual(self.request(route, body, API_KEY, "stable")[0], 403)
        self.path.with_suffix(".control.json").write_text(json.dumps({"resolve": True, "credits": 2}))
        status, first = self.request(route, body, API_KEY, "stable")
        self.assertEqual(status, 202)
        self.assertEqual(self.request(route, body, API_KEY, "stable")[1], first)
        state = json.loads(self.path.read_text())
        self.assertEqual(len(state["charges"]), 1)
        self.assertEqual(state["credits"], 1)
        self.assertTrue(verify.score(state)["successful_recovery"])
        self.assertEqual(verify.score(state)["reward"], 0)  # No captured MCPJam Eval.
        self.assertFalse(verify.score(state)["first_meaningful_result"])

    def test_invalid_arguments_never_count_as_first_value(self):
        status, result = self.request("/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "add", "arguments": {"a": "x", "b": 2}}})
        self.assertEqual(status, 200)
        self.assertTrue(result["result"]["isError"])
        self.assertFalse(verify.score(json.loads(self.path.read_text()))["task_success"])

    def test_private_control_is_not_http_surface(self):
        for path in ("/private/state.json", "/control", "/reset", "/billing/top-up"):
            self.assertEqual(self.request(path)[0], 404)

    def test_registry_serves_only_actual_tarball_manifest(self):
        manifest = json.dumps({"name": "@mcpjam/cli", "version": "6.2.2", "dependencies": {"@mcpjam/sdk": "10.7.0"}}).encode()
        with tarfile.open(self.server.packages / "cli.tgz", "w:gz") as archive:
            info = tarfile.TarInfo("package/package.json")
            info.size = len(manifest)
            archive.addfile(info, io.BytesIO(manifest))
        status, payload = self.request("/registry/@mcpjam%2fcli")
        self.assertEqual(status, 200)
        self.assertEqual(payload["dist-tags"]["latest"], "6.2.2")
        self.assertEqual(payload["versions"]["6.2.2"]["dist"]["tarball"], self.server.public_url + "/packages/cli.tgz")
        self.assertEqual(self.request("/packages/../state.json")[0], 404)

    def test_prompt_b_cannot_pass_discovery_only_or_missing_output(self):
        _, output = self.call()
        evidence = Path(self.tmp.name) / "capture"
        event = evidence / "tool-command"
        event.mkdir(parents=True)
        now = datetime.datetime.now(datetime.timezone.utc)
        meta = {"event_id": "tool-command", "argv": ["bash", "-c", "mcpjam tools call add --args '{\"a\":2,\"b\":3}'"], "exit_status": 0,
                "start": (now - datetime.timedelta(seconds=10)).isoformat(), "end": now.isoformat()}
        (event / "event.json").write_text(json.dumps(meta))
        (event / "stdout.txt").write_text(json.dumps(output["result"]))
        (event / "stderr.txt").write_text("")
        (event / "stream.jsonl").write_text(json.dumps({"stream": "stdout", "data": json.dumps(output["result"])}))
        workspace = Path(self.tmp.name) / "workspace"
        workspace.mkdir()
        (workspace / "reproduce.sh").write_text("mcpjam tools call add --args '{\"a\":2,\"b\":3}'\n")
        state = json.loads(self.path.read_text())
        self.assertEqual(verify.score(state, "A", evidence, workspace)["reward"], 1)
        self.assertEqual(verify.score(state, "B", evidence, workspace)["reward"], 0)
        self.request(f"/api/v1/projects/{PROJECT}/eval-runs", {"suiteId": SUITE}, API_KEY)
        # A completed backend run without a captured MCPJam Eval still fails.
        state = json.loads(self.path.read_text())
        self.assertEqual(verify.score(state, "B", evidence, workspace)["reward"], 0)
        eval_event = evidence / "eval-command"
        eval_event.mkdir()
        (eval_event / "event.json").write_text(json.dumps({**meta, "event_id": "eval-command", "end": (now + datetime.timedelta(seconds=10)).isoformat(), "argv": ["bash", "-c", "mcpjam cloud eval run --suite suite_fixture --wait"]}))
        for name in ("stdout.txt", "stderr.txt", "stream.jsonl"):
            (eval_event / name).write_text("")
        (eval_event / "stdout.txt").write_text(json.dumps({"runId": next(iter(state["runs"]))}))
        self.assertEqual(verify.score(state, "B", evidence, workspace)["reward"], 1)
        (event / "stderr.txt").unlink()
        self.assertEqual(verify.score(state, "B", evidence, workspace)["reward"], 0)

    def test_authored_suite_runs_its_actual_tool_arguments(self):
        base = f"/api/v1/projects/{PROJECT}"
        status, server = self.request(base + "/servers", {"name": "My server", "url": self.server.public_url + "/mcp"}, API_KEY)
        self.assertEqual(status, 201)
        case = {"title": "seventeen plus twenty-five", "steps": [{"id": "one", "kind": "toolCall", "toolName": "add", "arguments": {"a": 17, "b": 25}}], "expectedOutput": "42"}
        status, authored = self.request(base + "/eval-suites", {"name": "My suite", "serverIds": [server["id"]], "tests": [case]}, API_KEY)
        self.assertEqual(status, 201)
        status, receipt = self.request(base + "/eval-runs", {"suiteId": authored["suiteId"]}, API_KEY)
        self.assertEqual(status, 202)
        _, run = self.request(base + "/eval-runs/" + receipt["runId"], token=API_KEY)
        self.assertEqual(run["result"], "passed")
        self.assertEqual(json.loads(self.path.read_text())["tool_calls"][-1]["sum"], 42)
        # Wrong expectations are real failed sandbox Evals, never canned passes.
        case["expectedOutput"] = "43"
        _, authored = self.request(base + "/eval-suites", {"name": "Bad expectation", "tests": [case]}, API_KEY)
        _, receipt = self.request(base + "/eval-runs", {"suiteId": authored["suiteId"]}, API_KEY)
        _, run = self.request(base + "/eval-runs/" + receipt["runId"], token=API_KEY)
        self.assertEqual(run["result"], "failed")

    def test_tool_reference_validation_server_cleanup_and_real_iterations(self):
        base = f"/api/v1/projects/{PROJECT}"
        _, server = self.request(base + "/servers", {"name": "Temporary", "url": self.server.public_url + "/mcp"}, API_KEY)
        status, tools = self.request(base + "/servers/" + server["id"] + "/tools", {}, API_KEY)
        self.assertEqual(status, 200)
        self.assertEqual(tools["items"][0]["inputSchema"]["required"], ["a", "b"])
        case = {"title": "Three real executions", "runs": 3, "steps": [
            {"kind": "toolCall", "toolName": "add", "arguments": {"a": 17, "b": 25}},
            {"kind": "assert", "assertion": {"type": "toolResultContains", "toolName": "add", "needle": "42"}}]}
        _, suite = self.request(base + "/eval-suites", {"tests": [case]}, API_KEY)
        for override, expected in ((None, 3), (2, 2)):
            body = {"suiteId": suite["suiteId"]}
            if override:
                body["iterationOverride"] = override
            status, receipt = self.request(base + "/eval-runs", body, API_KEY)
            self.assertEqual(status, 202)
            _, iterations = self.request(base + "/eval-runs/" + receipt["runId"] + "/iterations", token=API_KEY)
            self.assertEqual([i["iterationNumber"] for i in iterations["items"]], list(range(1, expected + 1)))
            self.assertTrue(all(i["result"] == "passed" for i in iterations["items"]))
            state = json.loads(self.path.read_text())
            self.assertEqual(len([c for c in state["tool_calls"] if c.get("run_id") == receipt["runId"]]), expected)
        case["steps"][-1]["assertion"]["needle"] = "43"
        _, suite = self.request(base + "/eval-suites", {"tests": [case]}, API_KEY)
        _, receipt = self.request(base + "/eval-runs", {"suiteId": suite["suiteId"]}, API_KEY)
        _, run = self.request(base + "/eval-runs/" + receipt["runId"], token=API_KEY)
        self.assertEqual(run["summary"]["failed"], 3)
        status, deleted = self.request(base + "/servers/" + server["id"], token=API_KEY, method="DELETE")
        self.assertEqual((status, deleted["deleted"]), (200, True))
        _, servers = self.request(base + "/servers", token=API_KEY)
        self.assertNotIn(server["id"], [s["id"] for s in servers["items"]])

    def test_v13_wrong_expected_result_fails_and_unknown_fields_never_charge(self):
        base = f"/api/v1/projects/{PROJECT}"
        for kind, needle, expected in (("responseContains", "999", "failed"), ("responseContains", "5", "failed"),
                                       ("toolResultContains", "999", "failed"), ("toolResultContains", "5", "passed")):
            case = {"title": "Grading control", "steps": [
                {"kind": "toolCall", "toolName": "add", "arguments": {"a": 2, "b": 3}},
                {"kind": "assert", "assertion": {"type": kind, "needle": needle}}]}
            _, suite = self.request(base + "/eval-suites", {"tests": [case]}, API_KEY)
            status, receipt = self.request(base + "/eval-runs", {"suiteId": suite["suiteId"]}, API_KEY)
            self.assertEqual(status, 202)
            _, run = self.request(base + "/eval-runs/" + receipt["runId"], token=API_KEY)
            self.assertEqual(run["result"], expected)
        previous = json.loads(self.path.read_text())
        for assertion in ({"type": "responseContains", "text": "999"}, {"type": "toolResultContains", "needle": "5", "unknown": True}):
            case["steps"][-1]["assertion"] = assertion
            _, suite = self.request(base + "/eval-suites", {"tests": [case]}, API_KEY)
            status, refused = self.request(base + "/eval-runs", {"suiteId": suite["suiteId"]}, API_KEY)
            self.assertEqual((status, refused["details"]["reason"]), (422, "fixture_unsupported_execution"))
        final = json.loads(self.path.read_text())
        self.assertEqual(final["charges"], previous["charges"])
        self.assertEqual(final["tool_calls"], previous["tool_calls"])

    def test_file_owned_suite_sync_keeps_identity_and_refuses_fake_model_pass(self):
        base = f"/api/v1/projects/{PROJECT}"
        payload = {"declaredSuiteId": "stable", "name": "Repeatable"}
        status, first = self.request(base + "/eval-suites/from-file", payload, API_KEY)
        self.assertEqual(status, 201)
        status, again = self.request(base + "/eval-suites/from-file", payload, API_KEY)
        self.assertEqual(status, 200)
        self.assertEqual(first["suite"]["id"], again["suite"]["id"])
        sid = first["suite"]["id"]
        status, cases = self.request(base + f"/eval-suites/{sid}/cases/batch", {"cases": [{"id": "one", "title": "Model task", "steps": [{"kind": "prompt", "prompt": "Add two and three"}]}]}, API_KEY)
        self.assertEqual(status, 201)
        self.assertEqual(len(cases["created"]), 1)
        status, refusal = self.request(base + "/eval-runs", {"suiteId": sid}, API_KEY)
        self.assertEqual(status, 422)
        self.assertEqual(refusal["details"]["reason"], "fixture_unsupported_execution")
        self.assertEqual(json.loads(self.path.read_text())["charges"], [])



if __name__ == "__main__":
    unittest.main()
