import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  accessHeadersFromEnv,
  fetchRunBundle,
  publishPullRequestComment,
  readActionReceipts,
  renderReports,
  truncateMarkdown,
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
  const requests = [];
  const fetchImpl = async (url, init) => {
    urls.push(String(url));
    requests.push(init);
    if (!String(url).includes("/iterations"))
      return response({ id: "run1", runNumber: 3, status: "completed", result: "passed" });
    if (!String(url).includes("cursor=next"))
      return response({ items: [{ id: "i1" }], nextCursor: "next" });
    return response({ items: [{ id: "i2" }] });
  };
  const bundle = await fetchRunBundle(receipt, "sk-test", fetchImpl);
  assert.deepEqual(bundle.iterations.map((row) => row.id), ["i1", "i2"]);
  assert.ok(urls.every((url) => url.includes("/projects/project1/eval-runs/run1")));
  assert.ok(requests.every((init) => init.signal instanceof AbortSignal));
});

test("sends the identity-proxy service token with every MCPJam read", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(init.headers);
    return String(url).includes("/iterations")
      ? response({ items: [] })
      : response({ id: "run1", status: "completed", result: "passed" });
  };
  await fetchRunBundle(
    receipt,
    "sk-test",
    fetchImpl,
    accessHeadersFromEnv({
      CF_ACCESS_CLIENT_ID: " id ",
      CF_ACCESS_CLIENT_SECRET: "secret",
    }),
  );
  assert.equal(seen.length, 2);
  for (const headers of seen) {
    assert.equal(headers["cf-access-client-id"], "id");
    assert.equal(headers["cf-access-client-secret"], "secret");
    assert.equal(headers.authorization, "Bearer sk-test");
  }
});

test("withholds a partial or newline-bearing service token", () => {
  assert.deepEqual(accessHeadersFromEnv({}), {});
  assert.deepEqual(
    accessHeadersFromEnv({ CF_ACCESS_CLIENT_ID: "id" }),
    {},
    "an id with no secret is not a usable token",
  );
  assert.deepEqual(
    accessHeadersFromEnv({
      CF_ACCESS_CLIENT_ID: "id",
      CF_ACCESS_CLIENT_SECRET: "secret\r\nx-injected: 1",
    }),
    {},
    "a value that could split into another header is dropped",
  );
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
  // No saved client on this run, so the cell is the model alone — "vitest" is
  // the test framework, and naming it under "Client" invents a client.
  assert.match(reports.comment, /\| gpt-5 \|.*1\/2.*83% \(5\/6\)/);
  assert.match(reports.comment, /Failed cases[\s\S]*Add to cart[\s\S]*67% \(2\/3\)/);
  assert.doesNotMatch(reports.comment, /Expected one item/);
  assert.match(reports.summary, /Recorded failures[\s\S]*Expected one item/);
  assert.match(reports.summary, /Usage and performance/);
});

test("names the saved client the run executed", () => {
  const reports = renderReports([
    {
      receipt,
      run: {
        id: "run1",
        status: "completed",
        result: "passed",
        client: { id: "cl_1", name: "Claude", source: "saved" },
        environment: { name: "Staging" },
        verdictSummary: {
          cases: [verdict("d_search", "mcpjam", "anthropic/claude-haiku-4.5", 3, 3, "passed")],
        },
      },
      iterations: [iteration("search", "Search", "passed", 900)],
    },
  ]);
  // The client the run names wins over the project environment it ran in.
  assert.match(reports.comment, /Claude \/ anthropic\/claude-haiku-4\.5/);
  assert.doesNotMatch(reports.comment, /Staging \/ /);
});

test("deep-links the run into the Evaluate tab, not the tab it replaces", () => {
  const reports = renderReports([
    {
      receipt,
      run: { id: "run1", runNumber: 3, status: "completed", result: "passed" },
      iterations: [iteration("cart", "Add to cart", "passed", 900)],
    },
  ]);
  assert.match(
    reports.comment,
    /https:\/\/app\.mcpjam\.com\/evaluate\/suite\/suite1\/runs\/run1\?project=project1/,
  );
  assert.doesNotMatch(reports.comment, /\/evals\/suite\//);
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

test("keeps a hosted case's own verdict when its minted id cannot be reproduced", () => {
  // A stored `caseKey` is encoded into the `k_` space and the iteration DTO
  // does not carry it, so the row cannot be joined by id. Re-deriving the
  // verdict from trials would call this 2/3 case failed under a ✅ header.
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
              ...verdict("k_hash_9f2a", "openai", "gpt-5", 2, 3, "passed"),
              effectivePassThreshold: 0.66,
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
  assert.match(reports.comment, /No failed or inconclusive cases/);
  assert.match(reports.comment, /Requirement:.*≥66%/);
  // The title still comes back: one decided case, one iteration group.
  assert.match(reports.summary, /Add to cart/);
});

test("reports the action verdict and the run result separately", () => {
  const bundle = {
    receipt,
    run: { id: "run1", status: "cancelled", result: "cancelled" },
    iterations: [iteration("cart", "Add to cart", "passed", 900)],
  };
  assert.match(
    renderReports([bundle]).comment,
    /## ⚠️ MCPJam Evals — Cancelled/,
  );
  const gated = renderReports([bundle], {
    result: "passed",
    message: "All gates passed or were waived.",
  });
  assert.match(gated.comment, /## ✅ MCPJam Evals — Passed/);
  assert.match(gated.comment, /All gates passed or were waived\./);
  assert.match(gated.comment, /Run result: ⚠️ Cancelled/);
});

test("separates two cases that share a title and escapes table headers", () => {
  const reports = renderReports([
    {
      receipt,
      run: {
        id: "run1",
        status: "completed",
        result: "failed",
        environment: { name: "Staging | EU" },
        verdictSummary: {
          cases: [
            verdict("d_search-a", "openai", "gpt-5", 3, 3, "passed"),
            verdict("d_search-b", "openai", "gpt-5", 0, 3, "failed"),
          ],
        },
      },
      iterations: [
        iteration("search-a", "Search", "passed", 900),
        iteration("search-b", "Search", "failed", 900),
      ],
    },
  ]);
  // The failing case's own rate, not the passing namesake's.
  assert.match(reports.comment, /Failed cases[\s\S]*\| Search \| ❌ 0% \(0\/3\)/);
  assert.match(reports.comment, /2 cases/);
  assert.match(reports.comment, /Staging \\\| EU \/ gpt-5/);
});

test("truncates an oversized report instead of losing it whole", () => {
  const long = `header\n${"row\n".repeat(500)}`;
  const cut = truncateMarkdown(long, 200, "\n\n_trimmed_");
  assert.ok(cut.length <= 200);
  assert.ok(cut.startsWith("header"));
  assert.ok(cut.endsWith("_trimmed_"));
  assert.equal(truncateMarkdown("short", 200, "\n\n_trimmed_"), "short");
});

test("counts UTF-8 bytes when truncating multibyte reports", () => {
  const limit = 200;
  const cut = truncateMarkdown(
    `header\n${"🔥 row\n".repeat(100)}`,
    limit,
    "\n\n_trimmed_",
  );
  assert.ok(Buffer.byteLength(cut, "utf8") <= limit);
  assert.ok(cut.endsWith("_trimmed_"));
});

test("refuses a receipt that points at another deployment", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mcpjam-receipts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "good.json"), JSON.stringify(receipt));
  await writeFile(
    join(directory, "elsewhere.json"),
    JSON.stringify({ ...receipt, runId: "run2", baseUrl: "https://evil.example.com" }),
  );
  await writeFile(
    join(directory, "insecure.json"),
    JSON.stringify({ ...receipt, runId: "run3", baseUrl: "http://app.mcpjam.com" }),
  );
  assert.deepEqual(
    await readActionReceipts(directory, "https://app.mcpjam.com"),
    [receipt],
  );
  assert.deepEqual(
    (await readActionReceipts(directory)).map((row) => row.runId).sort(),
    ["run1", "run2"],
  );
  assert.deepEqual(
    await readActionReceipts(directory, "http://app.mcpjam.com"),
    [],
  );
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

  const updateFetch = async (url, init = {}) => {
    calls.push({ url, init });
    return response(init.method === "PATCH" ? { id: 7 } : [{ id: 7, body: created }]);
  };
  assert.equal(await publishPullRequestComment("new", env, updateFetch), "updated");
  assert.equal(calls.length, 4);
  for (const { init } of calls) {
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
  }
  assert.equal(new Set(calls.map(({ init }) => init.signal)).size, calls.length);
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

function sibling(runId, clientName, provider, model, rows, overrides = {}) {
  return {
    receipt: { ...receipt, runId },
    run: {
      id: runId,
      runNumber: 7,
      runGroupId: "g1",
      status: "completed",
      result: rows.some(([, , result]) => result === "failed") ? "failed" : "passed",
      client: { name: clientName },
      ...overrides,
    },
    iterations: rows.map(([caseId, title, result]) => ({
      ...iteration(caseId, title, result, 1000),
      provider,
      model,
    })),
  };
}

test("renders sibling runs of one group as one table with a row per client", () => {
  const { comment } = renderReports([
    sibling("run-opus", "Claude Opus", "anthropic", "anthropic/claude-opus-4.5", [
      ["search", "Search coffee", "passed"],
      ["cart", "Add to cart", "passed"],
    ]),
    sibling("run-astra", "chatGPT Astra", "openai", "openai/gpt-5", [
      ["search", "Search coffee", "passed"],
      ["cart", "Add to cart", "failed"],
    ]),
  ]);

  assert.equal(comment.match(/^## /gm)?.length, 1, "one section, not one per run");
  assert.doesNotMatch(comment, /\n---\n/);
  assert.match(comment, /Amazon smoke · Run #7/);
  // One failed sibling fails the group.
  assert.match(comment, /Run result: ❌ Failed/);
  assert.match(comment, /2 client\/model combinations/);
  assert.match(comment, /\| chatGPT Astra \/ openai\/gpt-5 \| ❌ Failed \| 1\/2 \|/);
  assert.match(comment, /\| Claude Opus \/ anthropic\/claude-opus-4\.5 \| ✅ Passed \| 2\/2 \|/);
  // Failed cases: one column per sibling, and the passing sibling's cell is filled.
  assert.match(
    comment,
    /\| Case \| chatGPT Astra \/ openai\/gpt-5 \| Claude Opus \/ anthropic\/claude-opus-4\.5 \|/,
  );
  assert.match(comment, /\| Add to cart \| ❌ 0% \(0\/1\) \| ✅ 100% \(1\/1\) \|/);
  // Each sibling keeps its own run page.
  assert.match(comment, /\[View run in MCPJam — Claude Opus\]\([^)]*runs\/run-opus/);
  assert.match(comment, /\[View run in MCPJam — chatGPT Astra\]\([^)]*runs\/run-astra/);
});

test("keeps two clients on the same model as two rows", () => {
  const { comment } = renderReports([
    sibling("run-a", "Claude", "anthropic", "anthropic/claude-haiku-4.5", [
      ["search", "Search", "passed"],
    ]),
    sibling("run-b", "Claude strict", "anthropic", "anthropic/claude-haiku-4.5", [
      ["search", "Search", "passed"],
    ]),
  ]);
  assert.match(comment, /\| Claude \/ anthropic\/claude-haiku-4\.5 \|/);
  assert.match(comment, /\| Claude strict \/ anthropic\/claude-haiku-4\.5 \|/);
});

test("names each sibling in recorded failures and sums run details", () => {
  const failing = sibling("run-astra", "chatGPT Astra", "openai", "openai/gpt-5", [
    ["cart", "Add to cart", "failed"],
  ]);
  failing.iterations[0].error = "Expected one item";
  const { summary } = renderReports([
    sibling("run-opus", "Claude Opus", "anthropic", "anthropic/claude-opus-4.5", [
      ["cart", "Add to cart", "passed"],
    ]),
    failing,
  ]);
  assert.match(
    summary,
    /\| Add to cart \(chatGPT Astra \/ openai\/gpt-5\) \| Expected one item \|/,
  );
  assert.match(summary, /\| Completed iterations \| 2\/2 \|/);
});

test("keeps runs with different or absent group ids in separate sections", () => {
  const { comment } = renderReports([
    sibling("run-1", "A", "openai", "openai/gpt-5", [["s", "S", "passed"]], { runGroupId: "g1" }),
    sibling("run-2", "B", "openai", "openai/gpt-5", [["s", "S", "passed"]], { runGroupId: "g2" }),
    sibling("run-3", "C", "openai", "openai/gpt-5", [["s", "S", "passed"]], { runGroupId: undefined }),
  ]);
  assert.equal(comment.split("\n\n---\n\n").length, 3);
  // A group of one keeps the single-run link text.
  assert.equal(comment.match(/\[View full run in MCPJam\]/g)?.length, 3);
});

test("does not pass a group whose sibling has no recorded result", () => {
  const unknown = sibling("run-b", "B", "openai", "openai/gpt-5", [["s", "S", "passed"]]);
  unknown.run.result = null;
  const { comment } = renderReports([
    sibling("run-a", "A", "openai", "openai/gpt-5", [["s", "S", "passed"]]),
    unknown,
  ]);
  assert.doesNotMatch(comment, /Run result: ✅ Passed/);
  assert.match(comment, /Run result: ⚠️ Unknown/);
});
