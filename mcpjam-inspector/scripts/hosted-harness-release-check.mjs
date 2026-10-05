#!/usr/bin/env node
// The REAL E2B release check for the hosted harnesses. Run on STAGING against
// a candidate computer template and candidate backend/inspector revisions,
// BEFORE widening cloud access to them.
//
// The Docker CI job (`hosted-harness-docker.yml`) pins the stream mapping on a
// container; it mocks everything E2B-specific. This check is the one that
// exercises the real thing — `Sandbox.connect`, the egress baseline, the
// model-broker lease installed as an E2B egress transform, the box's
// reservation and teardown — for BOTH harnesses:
//
//   fresh-baked-start   the run's box boots the CANDIDATE template and the
//                       harness finds the template's marker for exactly the
//                       recipe identity this inspector revision resolves
//                       (no install at turn time)
//   mcp-evidence        a deterministic MCP call is made, attributed to its
//                       server, and recorded on the iteration
//   normal-completion   the iteration completes and scores; model usage is
//                       recorded (iteration usage, and the lease's spend)
//   user-cancellation   cancelling mid-tool ends the run promptly; the fee is
//                       refunded
//   provider-failure    a model-provider failure is recorded as a TYPED infra
//                       error (excluded from the score, fee refunded)
//   worker-interruption the box dies mid-turn: the turn ends (does not hang)
//                       as a typed infra error, fee refunded
//   and after EVERY run: every model lease the run minted is revoked, and the
//   run's boxes are torn down.
//
// SAFETY. Everything runs against a DISPOSABLE staging project the operator
// provisioned for this (its name must carry `RELEASE_CHECK_DISPOSABLE_PREFIX`)
// on a non-production base URL; the check only ever launches and cancels runs
// of the suites it is given, and only ever kills boxes tagged with a run IT
// launched. It never replays writes against customer data.
//
// INPUTS (environment):
//   RELEASE_CHECK_BASE_URL        staging app URL (production is refused)
//   RELEASE_CHECK_API_KEY         `sk_` key of the disposable staging org
//   RELEASE_CHECK_PROJECT_ID      the disposable project
//   RELEASE_CHECK_SUITES          JSON: {"claude-code":{"normal":…,"slow":…,
//                                 "providerFailure":…},"codex":{…}} — suite ids;
//                                 `normal` makes one deterministic MCP call,
//                                 `slow` runs a long shell command, and
//                                 `providerFailure` targets a model route the
//                                 staging gateway is configured to fail
//   RELEASE_CHECK_TEMPLATE_ID     the candidate template (E2B_TEMPLATE_ID on staging)
//   E2B_API_KEY                   staging E2B team key
//   RELEASE_CHECK_MCP_TOOL        the deterministic MCP tool (default `echo`)
//   CONVEX_DEPLOY_KEY + RELEASE_CHECK_BACKEND_DIR
//                                 staging deploy key and a checkout of the
//                                 candidate backend: lease revocation, lease
//                                 spend and refund rows are read from the
//                                 deployment's tables (`npx convex data`)
//   RELEASE_CHECK_INSPECTOR_REVISION / RELEASE_CHECK_BACKEND_REVISION
//                                 recorded with the result
//   RELEASE_CHECK_HARNESSES       default `claude-code,codex`
//   RELEASE_CHECK_OUT             result file (default release-check-result.json)
//   CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET  staging Access, if any
//
// RESULT. One JSON file recording the revisions, the template id, the bake id
// and identities, and every check (`passed` / `failed` / `unverified`, with
// detail). Exit 0 only when every check passed; 1 on any failure or a partial
// configuration; 0 with `status: "skipped"` when NO input is configured at all
// (a fork, a dry dispatch) — never "passed" without having run.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REQUIRED = [
  "RELEASE_CHECK_BASE_URL",
  "RELEASE_CHECK_API_KEY",
  "RELEASE_CHECK_PROJECT_ID",
  "RELEASE_CHECK_SUITES",
  "RELEASE_CHECK_TEMPLATE_ID",
  "E2B_API_KEY",
];
const PRODUCTION_HOSTS = new Set([
  "app.mcpjam.com",
  "mcpjam.com",
  "www.mcpjam.com",
]);
const RUN_TIMEOUT_MS = Number(
  process.env.RELEASE_CHECK_RUN_TIMEOUT_MS ?? 15 * 60_000,
);
const TEARDOWN_TIMEOUT_MS = 3 * 60_000;
const POLL_MS = 3_000;
const TERMINAL_RUN = new Set(["completed", "failed", "cancelled"]);

const env = process.env;
const outPath = resolve(env.RELEASE_CHECK_OUT ?? "release-check-result.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function gitRevision() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: here,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

const result = {
  check: "hosted-harness-release-check",
  status: "running",
  startedAt: new Date().toISOString(),
  baseUrl: env.RELEASE_CHECK_BASE_URL ?? null,
  revisions: {
    inspector:
      env.RELEASE_CHECK_INSPECTOR_REVISION || env.GITHUB_SHA || gitRevision(),
    backend: env.RELEASE_CHECK_BACKEND_REVISION || null,
  },
  templateId: env.RELEASE_CHECK_TEMPLATE_ID ?? null,
  bake: null,
  checks: [],
};

function save() {
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
}

function record(harness, name, status, detail = {}) {
  result.checks.push({ harness, name, status, ...detail });
  process.stdout.write(
    `[release-check] ${harness} ${name}: ${status}${detail.reason ? ` — ${detail.reason}` : ""}\n`,
  );
  save();
}

// ── Preconditions ───────────────────────────────────────────────────────────

const missing = REQUIRED.filter((name) => !env[name]?.trim());
if (missing.length === REQUIRED.length) {
  result.status = "skipped";
  result.reason = "no release-check inputs are configured; nothing was run";
  save();
  process.stdout.write(
    `::warning::hosted harness release check SKIPPED: ${result.reason}\n`,
  );
  process.exit(0);
}
if (missing.length > 0) {
  result.status = "failed";
  result.reason = `missing inputs: ${missing.join(", ")}`;
  save();
  process.stderr.write(
    `::error::hosted harness release check: ${result.reason}\n`,
  );
  process.exit(1);
}

const baseUrl = env.RELEASE_CHECK_BASE_URL.replace(/\/+$/, "");
if (PRODUCTION_HOSTS.has(new URL(baseUrl).hostname)) {
  result.status = "failed";
  result.reason = `refusing to run against production (${baseUrl}); this check is for staging`;
  save();
  process.stderr.write(`::error::${result.reason}\n`);
  process.exit(1);
}
const projectId = env.RELEASE_CHECK_PROJECT_ID;
const suites = JSON.parse(env.RELEASE_CHECK_SUITES);
const harnesses = (env.RELEASE_CHECK_HARNESSES ?? "claude-code,codex")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);
const mcpTool = env.RELEASE_CHECK_MCP_TOOL ?? "echo";
const disposablePrefix =
  env.RELEASE_CHECK_DISPOSABLE_PREFIX ?? "release-check-";

// ── Clients ─────────────────────────────────────────────────────────────────

async function api(method, path, body) {
  const headers = {
    authorization: `Bearer ${env.RELEASE_CHECK_API_KEY}`,
    "content-type": "application/json",
    ...(env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET
      ? {
          "cf-access-client-id": env.CF_ACCESS_CLIENT_ID,
          "cf-access-client-secret": env.CF_ACCESS_CLIENT_SECRET,
        }
      : {}),
  };
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `${method} ${path} → ${response.status}: ${text.slice(0, 500)}`,
    );
  }
  return text ? JSON.parse(text) : {};
}

const { Sandbox } = await import("e2b");
const e2b = { apiKey: env.E2B_API_KEY };

/** Boxes the backend tagged with this run (ephemeral eval sandboxes carry `runId`). */
async function boxesFor(runId, states = ["running", "paused"]) {
  const paginator = Sandbox.list({
    ...e2b,
    query: { metadata: { runId }, state: states },
  });
  const out = [];
  while (paginator.hasNext) out.push(...(await paginator.nextItems()));
  return out;
}

/** Rows of a staging table, newest first, via the candidate backend's CLI. */
function convexRows(table, limit = 500) {
  if (!env.CONVEX_DEPLOY_KEY || !env.RELEASE_CHECK_BACKEND_DIR) return null;
  const out = execFileSync(
    "npx",
    [
      "convex",
      "data",
      table,
      "--limit",
      String(limit),
      "--order",
      "desc",
      "--format",
      "jsonLines",
    ],
    {
      cwd: env.RELEASE_CHECK_BACKEND_DIR,
      encoding: "utf8",
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return out
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line));
}

// ── Run helpers ─────────────────────────────────────────────────────────────

async function launch(suiteId) {
  const created = await api("POST", `/projects/${projectId}/eval-runs`, {
    suiteId,
  });
  const runId =
    created.id ?? created.runId ?? created.run?.id ?? created.data?.id;
  if (!runId)
    throw new Error(
      `launch returned no run id: ${JSON.stringify(created).slice(0, 300)}`,
    );
  return { runId, launchedAt: Date.now() };
}

const getRun = (runId) =>
  api("GET", `/projects/${projectId}/eval-runs/${runId}`);
async function iterations(runId) {
  const page = await api(
    "GET",
    `/projects/${projectId}/eval-runs/${runId}/iterations?limit=200`,
  );
  return page.items ?? page.data ?? [];
}

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(POLL_MS);
  }
}

const waitTerminal = (runId) =>
  waitFor(
    async () => {
      const run = await getRun(runId);
      return TERMINAL_RUN.has(String(run.status)) ? run : null;
    },
    RUN_TIMEOUT_MS,
    `run ${runId} to finish`,
  );

/**
 * Watch the run's box while it runs: its template, and the bootstrap marker
 * for this harness's recipe. A marker written by the TEMPLATE is the bake's
 * JSON; one the framework wrote at turn time is empty.
 */
async function watchBox(runId, recipe) {
  const [box] = await waitFor(
    async () => {
      const boxes = await boxesFor(runId, ["running"]);
      return boxes.length > 0 ? boxes : null;
    },
    RUN_TIMEOUT_MS,
    `a box for run ${runId}`,
  );
  const sandbox = await Sandbox.connect(box.sandboxId, {
    ...e2b,
    // Long enough to outlive the turn; the backend tears the box down itself.
    timeoutMs: RUN_TIMEOUT_MS,
  });
  const marker = `/home/user/${recipe.bootstrapDir}/${recipe.marker}`;
  let content = null;
  try {
    content = await waitFor(
      async () => {
        try {
          return { text: await sandbox.files.read(marker) };
        } catch {
          return null;
        }
      },
      60_000,
      `the ${recipe.dir} marker`,
    );
  } catch {
    // Reported below as a missing marker.
  }
  let baked = null;
  try {
    baked = content ? JSON.parse(content.text) : null;
  } catch {
    baked = null;
  }
  return {
    box,
    sandboxId: box.sandboxId,
    markerContent: content?.text ?? null,
    baked,
  };
}

/** After a run: every lease it minted revoked; its boxes gone. */
async function afterRun(harness, scenario, runId) {
  try {
    await waitFor(
      async () => (await boxesFor(runId, ["running"])).length === 0,
      TEARDOWN_TIMEOUT_MS,
      "box teardown",
    );
    record(harness, `${scenario}:box-teardown`, "passed");
  } catch (error) {
    record(harness, `${scenario}:box-teardown`, "failed", {
      reason: error.message,
    });
  }
  const leases = convexRows("harnessModelLeases");
  if (!leases) {
    record(harness, `${scenario}:broker-revocation`, "unverified", {
      reason:
        "CONVEX_DEPLOY_KEY / RELEASE_CHECK_BACKEND_DIR not set; lease rows unreadable",
    });
    return { leases: null };
  }
  const mine = leases.filter((lease) => lease.evalRunId === runId);
  const live = mine.filter((lease) => typeof lease.revokedAt !== "number");
  record(
    harness,
    `${scenario}:broker-revocation`,
    mine.length > 0 && live.length === 0 ? "passed" : "failed",
    { leases: mine.length, unrevoked: live.length },
  );
  return { leases: mine };
}

/** Refund rows for an iteration (unit fee refunds land in `creditTransactions`). */
function refundFor(iterationId, runId) {
  const rows = convexRows("creditTransactions", 1000);
  if (!rows) return null;
  return rows.filter(
    (row) =>
      row.kind === "refund" &&
      typeof row.idempotencyKey === "string" &&
      (row.idempotencyKey.includes(iterationId) ||
        row.idempotencyKey.includes(runId)),
  );
}

function infraErrorOf(iteration) {
  return iteration.infraError ?? iteration.execution?.infraError ?? null;
}

function checkRefund(harness, scenario, iteration, runId) {
  const refunds = refundFor(iteration.id, runId);
  if (refunds === null) {
    record(harness, `${scenario}:refund`, "unverified", {
      reason:
        "credit ledger unreadable without CONVEX_DEPLOY_KEY / RELEASE_CHECK_BACKEND_DIR",
    });
  } else {
    record(
      harness,
      `${scenario}:refund`,
      refunds.length > 0 ? "passed" : "failed",
      {
        refunds: refunds.length,
      },
    );
  }
}

// ── Scenarios ───────────────────────────────────────────────────────────────

async function normal(harness, recipe) {
  const { runId } = await launch(suites[harness].normal);
  const watched = await watchBox(runId, recipe);
  record(
    harness,
    "fresh-baked-start:template",
    watched.box.templateId === env.RELEASE_CHECK_TEMPLATE_ID ||
      watched.box.name === env.RELEASE_CHECK_TEMPLATE_ID
      ? "passed"
      : "failed",
    {
      runId,
      sandboxTemplateId: watched.box.templateId,
    },
  );
  record(
    harness,
    "fresh-baked-start:marker",
    watched.baked?.bakedBy === "mcpjam-harness-bake" &&
      watched.baked.identity === recipe.identity
      ? "passed"
      : "failed",
    {
      expectedIdentity: recipe.identity,
      found:
        watched.markerContent === null
          ? "no marker"
          : watched.markerContent === ""
            ? "installed at turn time"
            : (watched.baked ?? "unparseable"),
    },
  );
  const run = await waitTerminal(runId);
  const [iteration] = await iterations(runId);
  record(
    harness,
    "normal-completion",
    run.status === "completed" && iteration?.result === "passed"
      ? "passed"
      : "failed",
    {
      runId,
      runStatus: run.status,
      iterationStatus: iteration?.status,
      iterationResult: iteration?.result,
      error: iteration?.error ?? null,
    },
  );
  const calls = iteration?.actualToolCalls ?? [];
  const mcpCall = calls.find(
    (call) => (call.toolName ?? call.name) === mcpTool,
  );
  record(
    harness,
    "mcp-evidence",
    mcpCall && (mcpCall.serverId || mcpCall.serverName) ? "passed" : "failed",
    {
      toolCalls: calls.map((call) => ({
        toolName: call.toolName ?? call.name,
        serverId: call.serverId ?? null,
      })),
    },
  );
  const tokens = iteration?.usage?.totalTokens ?? iteration?.tokensUsed ?? 0;
  const { leases } = await afterRun(harness, "normal", runId);
  const spent = leases?.reduce((sum, lease) => sum + (lease.spentUsd ?? 0), 0);
  record(
    harness,
    "model-usage-accounting",
    tokens > 0 && (spent === undefined || spent > 0) ? "passed" : "failed",
    { tokens, leaseSpentUsd: spent ?? "unverified" },
  );
}

async function cancellation(harness, recipe) {
  const { runId } = await launch(suites[harness].slow);
  await watchBox(runId, recipe);
  // Let the long tool actually start before the user cancels.
  await sleep(10_000);
  const cancelledAt = Date.now();
  await api("POST", `/projects/${projectId}/eval-runs/${runId}/cancel`);
  const run = await waitTerminal(runId);
  record(
    harness,
    "user-cancellation",
    run.status === "cancelled" ? "passed" : "failed",
    {
      runId,
      runStatus: run.status,
      endedWithinMs: Date.now() - cancelledAt,
    },
  );
  const [iteration] = await iterations(runId);
  await afterRun(harness, "cancellation", runId);
  if (iteration) checkRefund(harness, "cancellation", iteration, runId);
}

async function providerFailure(harness) {
  const { runId } = await launch(suites[harness].providerFailure);
  const run = await waitTerminal(runId);
  const [iteration] = await iterations(runId);
  const infra = iteration ? infraErrorOf(iteration) : null;
  record(
    harness,
    "provider-failure",
    infra?.layer === "model" && iteration?.result === "failed"
      ? "passed"
      : "failed",
    {
      runId,
      runStatus: run.status,
      infraError: infra,
      error: iteration?.error ?? null,
    },
  );
  await afterRun(harness, "provider-failure", runId);
  if (iteration) checkRefund(harness, "provider-failure", iteration, runId);
}

async function workerInterruption(harness, recipe) {
  const { runId } = await launch(suites[harness].slow);
  const watched = await watchBox(runId, recipe);
  await sleep(10_000);
  // Only ever a box tagged with the run THIS check launched.
  await Sandbox.kill(watched.sandboxId, e2b);
  const killedAt = Date.now();
  const run = await waitTerminal(runId);
  const [iteration] = await iterations(runId);
  const infra = iteration ? infraErrorOf(iteration) : null;
  record(
    harness,
    "worker-interruption",
    infra && ["sandbox", "worker_lost"].includes(infra.class)
      ? "passed"
      : "failed",
    {
      runId,
      runStatus: run.status,
      endedWithinMs: Date.now() - killedAt,
      infraError: infra,
      error: iteration?.error ?? null,
    },
  );
  await afterRun(harness, "worker-interruption", runId);
  if (iteration) checkRefund(harness, "worker-interruption", iteration, runId);
}

// ── Main ────────────────────────────────────────────────────────────────────

try {
  const project = await api("GET", `/projects/${projectId}`);
  const name = String(project.name ?? project.data?.name ?? "");
  if (!name.startsWith(disposablePrefix)) {
    throw new Error(
      `project ${projectId} is "${name}", not a disposable release-check project ` +
        `(its name must start with "${disposablePrefix}")`,
    );
  }
  // What THIS inspector revision resolves — the identities the template must
  // have baked.
  const { resolveHarnessBake } = await import("./harness-bake-context.mjs");
  const { manifest } = await resolveHarnessBake();
  result.bake = {
    bakeId: manifest.bakeId,
    recipes: manifest.recipes.map((r) => ({
      harnessId: r.harnessId,
      bootstrapDir: r.bootstrapDir,
      identity: r.identity,
    })),
    pins: manifest.pins,
    harnessPinnedVersions: manifest.harnessPinnedVersions,
  };
  save();
  for (const harness of harnesses) {
    if (!suites[harness])
      throw new Error(`RELEASE_CHECK_SUITES has no suites for ${harness}`);
    const recipe = manifest.recipes.find((r) => r.harnessId === harness);
    if (!recipe) throw new Error(`the bake has no recipe for ${harness}`);
    for (const [name, scenario] of [
      ["normal", () => normal(harness, recipe)],
      ["cancellation", () => cancellation(harness, recipe)],
      ["provider-failure", () => providerFailure(harness)],
      ["worker-interruption", () => workerInterruption(harness, recipe)],
    ]) {
      try {
        await scenario();
      } catch (error) {
        record(harness, name, "failed", {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  const failed = result.checks.filter((c) => c.status === "failed").length;
  const unverified = result.checks.filter(
    (c) => c.status === "unverified",
  ).length;
  result.status =
    failed > 0 ? "failed" : unverified > 0 ? "incomplete" : "passed";
} catch (error) {
  result.status = "failed";
  result.reason = error instanceof Error ? error.message : String(error);
}
result.finishedAt = new Date().toISOString();
save();
process.stdout.write(`[release-check] ${result.status} — ${outPath}\n`);
process.exit(result.status === "passed" ? 0 : 1);
