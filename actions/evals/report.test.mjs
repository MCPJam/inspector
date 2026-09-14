import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  fetchRunBundle,
  publishPullRequestComment,
  readActionReceipts,
  renderReports,
} from "./report.mjs";

const receipt = {
  schemaVersion: 1,
  baseUrl: "https://app.mcpjam.com",
  projectId: "project1",
  suiteId: "suite1",
  suiteName: "Amazon smoke",
  framework: "vitest",
  runId: "run1",
};

test("reads only valid, unique SDK action receipts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mcpjam-receipts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "one.json"), JSON.stringify(receipt));
  await writeFile(join(directory, "duplicate.json"), JSON.stringify(receipt));
  await writeFile(join(directory, "other.json"), "not json");
  assert.deepEqual(await readActionReceipts(directory), [receipt]);
});

test("fetches every iteration page for the exact receipt run", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (!String(url).includes("/iterations"))
      return response({ id: "run1", runNumber: 3, status: "completed", result: "passed" });
    if (!String(url).includes("cursor=next"))
      return response({ items: [{ id: "i1" }], nextCursor: "next" });
    return response({ items: [{ id: "i2" }] });
  };
  const bundle = await fetchRunBundle(receipt, "sk-test", fetchImpl);
  assert.deepEqual(bundle.iterations.map((row) => row.id), ["i1", "i2"]);
  assert.ok(urls.every((url) => url.includes("/projects/project1/eval-runs/run1")));
});

test("renders the client summary and failed-case tables from stored results", () => {
  const reports = renderReports([
    {
      receipt,
      run: {
        id: "run1",
        runNumber: 3,
        status: "completed",
        result: "failed",
        verdictSummary: {
          cases: [
            verdict("d_search", "openai", "gpt-5", 3, 3, "passed"),
            verdict("d_cart", "openai", "gpt-5", 2, 3, "failed"),
          ],
        },
      },
      iterations: [
        iteration("search", "Search coffee", "passed", 1000),
        iteration("search", "Search coffee", "passed", 1200),
        iteration("search", "Search coffee", "passed", 1400),
        iteration("cart", "Add to cart", "passed", 900),
        iteration("cart", "Add to cart", "passed", 1000),
        iteration("cart", "Add to cart", "failed", 1100, "Expected one item"),
      ],
    },
  ]);
  assert.match(reports.comment, /Client \/ Model.*Cases passed.*P50 \/ P95/);
  assert.match(reports.comment, /vitest \/ gpt-5.*1\/2.*83% \(5\/6\)/);
  assert.match(reports.comment, /Failed cases[\s\S]*Add to cart[\s\S]*67% \(2\/3\)/);
  assert.doesNotMatch(reports.comment, /Expected one item/);
  assert.match(reports.summary, /Recorded failures[\s\S]*Expected one item/);
  assert.match(reports.summary, /Usage and performance/);
});

test("uses the backend case verdict through its encoded declared identity", () => {
  const reports = renderReports([
    {
      receipt,
      run: {
        id: "run1",
        status: "completed",
        result: "passed",
        verdictSummary: {
          cases: [
            {
              ...verdict("d_cart", "openai", "gpt-5", 2, 3, "passed"),
              effectivePassThreshold: 0.6,
            },
          ],
        },
      },
      iterations: [
        iteration("cart", "Add to cart", "passed", 900),
        iteration("cart", "Add to cart", "passed", 1000),
        iteration("cart", "Add to cart", "failed", 1100),
      ],
    },
  ]);
  assert.match(reports.comment, /✅ Passed.*1\/1/s);
  assert.match(reports.comment, /No failed or inconclusive cases/);
});

test("creates and then updates one marked PR comment", async () => {
  const calls = [];
  const env = githubEnv();
  const createFetch = async (url, init = {}) => {
    calls.push({ url, init });
    return response(init.method === "POST" ? { id: 7 } : []);
  };
  assert.equal(await publishPullRequestComment("report", env, createFetch), "created");
  assert.equal(calls.at(-1).init.method, "POST");
  const created = JSON.parse(calls.at(-1).init.body).body;

  const updateFetch = async (_url, init = {}) =>
    response(init.method === "PATCH" ? { id: 7 } : [{ id: 7, body: created }]);
  assert.equal(await publishPullRequestComment("new", env, updateFetch), "updated");
});

test("does not let an older workflow overwrite a newer comment", async () => {
  const env = githubEnv();
  const newer = `<!-- mcpjam-evals:${markerFor(env)} run=999 attempt=1 -->\nnewer`;
  let writes = 0;
  const fetchImpl = async (_url, init = {}) => {
    if (init.method) writes += 1;
    return response([{ id: 7, body: newer }]);
  };
  assert.equal(await publishPullRequestComment("old", env, fetchImpl), "stale");
  assert.equal(writes, 0);
});

function verdict(caseId, provider, model, passed, eligible, result) {
  return {
    caseId,
    executionVariant: { provider, model },
    passedTrials: passed,
    failedTrials: eligible - passed,
    eligibleTrials: eligible,
    effectivePassThreshold: 0.8,
    verdict: result,
  };
}

function iteration(caseId, title, result, durationMs, error = null) {
  return {
    id: `${caseId}-${Math.random()}`,
    caseId,
    testCaseId: caseId,
    title,
    result,
    status: "completed",
    provider: "openai",
    model: "gpt-5",
    durationMs,
    error,
    usage: null,
    actualToolCalls: [],
  };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function githubEnv() {
  return {
    GITHUB_REPOSITORY: "example/repo",
    GITHUB_WORKFLOW: "Eval",
    GITHUB_JOB: "eval",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    MCPJAM_ACTION_INVOCATION: "action",
    MCPJAM_ACTION_MATRIX: "{}",
    MCPJAM_ACTION_PULL_REQUEST: "42",
    MCPJAM_ACTION_GITHUB_TOKEN: "token",
  };
}

function markerFor(env) {
  const identity = [
    env.GITHUB_REPOSITORY,
    env.GITHUB_WORKFLOW,
    env.GITHUB_JOB,
    env.MCPJAM_ACTION_INVOCATION,
    env.MCPJAM_ACTION_MATRIX,
  ];
  return createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex")
    .slice(0, 20);
}
