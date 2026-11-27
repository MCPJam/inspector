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
  const withOutcome = renderReports([b], {
    result: "failed",
    message: "1 of 3 tests failed. See the reports.",
  });
  assert.equal(withOutcome.comment.match(/1 of 3 tests failed/g).length, 1);
  assert.match(comment, /Runs passed/);
  assert.doesNotMatch(comment, /Iteration pass rate/);
  assert.equal(failedTestCount([bundle(["passed", "inconclusive"])]), "");
  assert.equal(failedTestCount([]), "");
  assert.equal(failedTestCount([bundle(["failed"])]), "1 of 1 test failed.");
  assert.equal(
    failedTestCount([b, b]),
    "2 of 6 tests failed across client/model combinations."
  );
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
  "missing-token",
]) {
  test(`PR reporting: ${scenario}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "eftw59-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const failed = scenario === "forbidden-fail";
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
    const rows = [{ id: "r1", status: "completed", result }];
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
            targets: [{ status: "started", runId: "r1" }],
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
          ok: !scenario.startsWith("forbidden"),
          status: 403,
          json: async () => [],
        };
      }
      return {
        ok: true,
        json: async () =>
          String(url).includes("/iterations")
            ? {
                items: [
                  {
                    caseId: "case1",
                    title: "Search",
                    status: "completed",
                    result,
                  },
                ],
              }
            : rows[0],
      };
    };
    const state = await runAction(
      env,
      invoke,
      (line) => logs.push(line),
      undefined,
      fetchImpl,
      async (selector) => {
        assert.equal(selector, "6");
        return "6.4.1";
      }
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
    else assert.equal(calls.length, scenario === "default" ? 2 : 1);
    if (scenario === "default")
      assert.match(JSON.parse(calls[1].init.body).body, /Results by MCPJam/);
    if (scenario.startsWith("forbidden") || scenario === "missing-token")
      assert.ok(
        logs.some(
          (line) =>
            line.includes("::warning::") && line.includes("fork PR tokens")
        )
      );
    if (failed) {
      assert.match(state.message, /1 of 1 test failed/);
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
