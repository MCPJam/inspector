import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  failedTestCount,
  publishPullRequestComment,
  renderReports,
} from "./report.mjs";
import { parseInputs, runAction } from "./run.mjs";

const receipt = {
  baseUrl: "https://app.mcpjam.com",
  projectId: "p1",
  suiteId: "s1",
  runId: "r1",
  suiteName: "Smoke",
};
const bundle = (verdicts) => ({
  receipt,
  run: {
    id: "r1",
    status: "completed",
    result: "failed",
    verdictSummary: {
      cases: verdicts.map((verdict, i) => ({
        caseId: `d_${i}`,
        verdict,
        passedTrials: 2,
        failedTrials: 1,
        eligibleTrials: 3,
      })),
    },
  },
  iterations: [],
});

test("counts failed tests from decisions, keeping failed trials and inconclusive tests distinct", () => {
  const b = bundle(["passed", "failed", "inconclusive"]);
  assert.equal(failedTestCount([b]), "1 of 3 tests failed.");
  const { comment } = renderReports([b]);
  assert.match(comment, /1 of 3 tests failed/);
  assert.match(comment, /Iterations passed/);
  assert.doesNotMatch(comment, /Runs passed/);
  assert.doesNotMatch(comment, /Iteration pass rate/);
  assert.equal(failedTestCount([bundle(["passed", "inconclusive"])]), "");
  assert.equal(failedTestCount([]), "");
  assert.equal(failedTestCount([bundle(["failed"])]), "1 of 1 test failed.");
  assert.equal(failedTestCount([b, b]), "2 of 6 tests failed.");
});

test("retains MCPJam signature when a large posted comment is truncated", async () => {
  let posted;
  await publishPullRequestComment(
    "row\n".repeat(30_000),
    {
      GITHUB_REPOSITORY: "example/repo",
      MCPJAM_ACTION_PULL_REQUEST: "1",
      MCPJAM_ACTION_GITHUB_TOKEN: "token",
    },
    async (_url, init) => {
      if (init.method) posted = JSON.parse(init.body).body;
      return { ok: true, json: async () => [] };
    }
  );
  assert.ok(Buffer.byteLength(posted) <= 64_000);
  assert.match(posted, /Comment truncated/);
  assert.ok(posted.endsWith("_Results by MCPJam_"));
});

for (const scenario of [
  "default",
  "opt-out",
  "no-pr",
  "forbidden-pass",
  "forbidden-fail",
  "write-forbidden-pass",
  "write-forbidden-fail",
  "multiple-groups",
  "missing-token",
]) {
  test(`PR reporting: ${scenario}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "eftw59-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const failed = scenario.endsWith("-fail") || scenario === "multiple-groups";
    const result = failed ? "failed" : "passed";
    const env = {
      MCPJAM_ACTION_IDEMPOTENCY_KEY: "eftw59-test",
      MCPJAM_API_KEY: "fixture-key",
      MCPJAM_ACTION_PROJECT: "p1",
      MCPJAM_ACTION_SUITE: "s1",
      MCPJAM_ACTION_PULL_REQUEST: scenario === "no-pr" ? "" : "42",
      MCPJAM_ACTION_GITHUB_TOKEN: scenario === "missing-token" ? "" : "token",
      GITHUB_REPOSITORY: "example/repo",
      RUNNER_TEMP: root,
      GITHUB_STEP_SUMMARY: join(root, "summary"),
      ...(scenario === "opt-out" ? { MCPJAM_ACTION_COMMENT: "false" } : {}),
    };
    assert.equal(parseInputs(env).comment, scenario !== "opt-out");
    const rows = (scenario === "multiple-groups" ? ["r1", "r2"] : ["r1"]).map(
      (id) => ({ id, status: "completed", result })
    );
    const invoke = async (args) => {
      await writeFile(
        args.find((arg) => arg.startsWith("--out=")).slice(6),
        JSON.stringify({
          schemaVersion: 1,
          kind: "eval-run",
          cases: [],
          metadata: {
            runs: rows.map((r) => ({ ...r, iterationsComplete: true })),
          },
        })
      );
      return {
        code: failed ? 1 : 0,
        stdout: JSON.stringify({
          launch: {
            project: { id: "p1" },
            suite: { id: "s1" },
            outcome: "started",
            targets: rows.map((row) => ({ status: "started", runId: row.id })),
          },
          runs: rows,
        }),
      };
    };
    const calls = [];
    const logs = [];
    const fetchImpl = async (url, init) => {
      if (String(url).startsWith("https://api.github.com")) {
        calls.push({ url, init });
        return {
          ok:
            !scenario.startsWith("forbidden") &&
            !(scenario.startsWith("write-forbidden") && init.method),
          status: 403,
          json: async () => [],
        };
      }
      const runId = /eval-runs\/([^/?]+)/.exec(String(url))?.[1];
      const iterations =
        scenario === "multiple-groups"
          ? Array.from({ length: runId === "r1" ? 3 : 2 }, (_, i) => ({
              caseId: `case${i}`,
              title: `Test ${i}`,
              status: "completed",
              result: i === 0 ? "failed" : "passed",
              provider: "openai",
              model: "gpt-5",
            }))
          : [{ caseId: "case1", title: "Search", status: "completed", result }];
      return {
        ok: true,
        json: async () =>
          String(url).includes("/iterations")
            ? { items: iterations }
            : {
                ...rows.find((row) => row.id === runId),
                runGroupId: runId,
                client: { name: "SDK harness" },
              },
      };
    };
    const state = await runAction(
      env,
      invoke,
      (line) => logs.push(line),
      undefined,
      fetchImpl
    );
    assert.equal(state.result, result);
    const summary = await readFile(env.GITHUB_STEP_SUMMARY, "utf8");
    assert.match(summary, /MCPJam Evals/);
    assert.ok(
      await readFile(
        join(
          root,
          (
            await readdir(root)
          ).find((name) => name.startsWith("mcpjam-evals-")),
          "eval-report.md"
        ),
        "utf8"
      )
    );
    if (["opt-out", "no-pr", "missing-token"].includes(scenario))
      assert.equal(calls.length, 0);
    else assert.equal(calls.length, scenario.startsWith("forbidden") ? 1 : 2);
    if (scenario.startsWith("write-forbidden")) {
      assert.equal(calls[0].init.method, undefined);
      assert.equal(calls[1].init.method, "POST");
    }
    if (scenario === "default")
      assert.match(JSON.parse(calls[1].init.body).body, /Results by MCPJam/);
    if (scenario.includes("forbidden") || scenario === "missing-token")
      assert.ok(
        logs.some(
          (line) =>
            line.includes("::warning::") && line.includes("fork PR tokens")
        )
      );
    if (scenario === "multiple-groups") {
      const sections = summary.split("\n\n---\n\n");
      assert.match(sections[0], /1 of 3 tests failed/);
      assert.match(sections[1], /1 of 2 tests failed/);
      assert.doesNotMatch(
        summary,
        /2 of 5 tests failed|across client\/model combinations/
      );
      assert.ok(
        logs.some((line) => line.startsWith("::error::2 of 5 tests failed."))
      );
      const posted = JSON.parse(calls.at(-1).init.body).body;
      assert.doesNotMatch(posted, /2 of 5 tests failed/);
    } else if (failed) {
      assert.doesNotMatch(state.message, /1 of 1 test failed/);
      assert.ok(
        logs.some((line) => line.startsWith("::error::1 of 1 test failed"))
      );
    }
  });
}

test("published action metadata enables comments by default and preserves opt-out wiring", async () => {
  const yaml = await readFile(new URL("./action.yml", import.meta.url), "utf8");
  const commentInput = yaml.match(
    /\n  comment:\n([\s\S]*?)(?=\n  [a-z-]+:)/
  )?.[1];
  assert.match(commentInput, /default: "true"/);
  assert.match(yaml, /MCPJAM_ACTION_COMMENT: \$\{\{ inputs.comment \}\}/);
});

test("failure-count qualifier follows distinct clients/models instead of bundle count", () => {
  const first = bundle(["failed", "passed", "passed"]);
  first.run.client = { id: "client1", name: "Client one" };
  for (const entry of first.run.verdictSummary.cases)
    entry.executionVariant = { provider: "openai", model: "gpt-5" };
  const second = structuredClone(first);
  second.receipt = { ...receipt, runId: "r2", suiteId: "s2" };
  second.run.id = "r2";
  assert.equal(failedTestCount([first, second]), "2 of 6 tests failed.");
  second.run.client = { id: "client2", name: "Client two" };
  assert.equal(
    failedTestCount([first, second]),
    "2 of 6 tests failed across client/model combinations."
  );
  second.run.client = first.run.client;
  second.run.verdictSummary.cases[0].executionVariant.model = "gpt-5-mini";
  assert.equal(
    failedTestCount([first, second]),
    "2 of 6 tests failed across client/model combinations."
  );
  assert.equal(
    failedTestCount([second]),
    "1 of 3 tests failed across client/model combinations."
  );
});
