/**
 * `mcpjam cloud climbs`.
 *
 * What these pin: each verb resolves names and sends the route and body the
 * climb API documents (percents become basis points), `start --wait` polls the
 * climb until its baseline has settled and stops at its bound, and a flag
 * mistake is a usage error before any request.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Command } from "commander";
import { registerClimbsCommands } from "../src/commands/climbs.js";
import { waitForClimb } from "../src/lib/climb-command.js";
import { CliError } from "../src/lib/output.js";
import { addPlatformOptions } from "../src/lib/platform-command.js";
import { captureProcessOutput } from "./support/cli-run.js";

const PROJECT = { id: "project-1", name: "Checkout", description: null, icon: null, organizationId: "org-a", visibility: null, createdAt: 1, updatedAt: 2 };
const SUITE = { id: "suite-1", name: "Smoke", description: null, projectId: PROJECT.id, createdAt: 1, updatedAt: 2 };
const SERVER = { id: "server-1", projectId: PROJECT.id, name: "Echo", enabled: true, transportType: "http", url: "https://x.test/mcp", useOAuth: false, hasClientSecret: false, createdAt: 1, updatedAt: 2 };
const ENVIRONMENT = { id: "env-stg", projectId: PROJECT.id, name: "Staging", hostId: "h", revision: 1, archived: false, createdAt: 1, updatedAt: 2 };
const CLIMB = { climbId: "climb-1", suiteId: SUITE.id, state: "baselining" };

type Captured = { method: string; path: string; query: string; body: unknown };

function stubFetch(answers: Record<string, unknown[]> = {}): Captured[] {
  const requests: Captured[] = [];
  const served: Record<string, number> = {};
  globalThis.fetch = (async (target: unknown, init?: RequestInit) => {
    const url = new URL(String(target));
    if (url.pathname.endsWith("/projects")) return Response.json({ items: [PROJECT] });
    if (url.pathname.endsWith("/eval-suites")) return Response.json({ items: [SUITE] });
    if (url.pathname.endsWith("/servers")) return Response.json({ items: [SERVER] });
    if (url.pathname.endsWith("/environments")) return Response.json({ items: [ENVIRONMENT] });
    const method = init?.method ?? "GET";
    requests.push({ method, path: url.pathname, query: url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = `${method} ${url.pathname}`;
    const list = answers[key] ?? [CLIMB];
    const at = Math.min(served[key] ?? 0, list.length - 1);
    served[key] = (served[key] ?? 0) + 1;
    return Response.json(list[at]);
  }) as typeof fetch;
  return requests;
}

function buildProgram(): Command {
  const program = new Command().name("mcpjam").exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} });
  const cloud = program.command("cloud");
  addPlatformOptions(cloud);
  registerClimbsCommands(cloud);
  return program;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function run(verb: string, args: string[]) {
  const { stdout } = await captureProcessOutput(() =>
    buildProgram().parseAsync(["cloud", "climbs", ...verb.split(" "), "--project", "project-1", "--api-key", "sk_test", ...args], { from: "user" }),
  );
  return JSON.parse(stdout);
}

function usageError(pattern: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof CliError, String(error));
    assert.equal(error.code, "USAGE_ERROR");
    assert.match(error.message, pattern);
    return true;
  };
}

const CLIMBS = "/api/v1/projects/project-1/climbs";
const START = ["--suite", "Smoke", "--server", "echo", "--round-limit", "3", "--credit-limit", "400"];

test("start resolves names, converts percents to basis points and sends both limits", async () => {
  const requests = stubFetch();
  await run("start", [
    ...START,
    "--environments", "Staging",
    "--measure", "tokens",
    "--min-improvement-percent", "1.5",
    "--target-percent", "5",
    "--steering", "a,b",
    "--validation", "c",
    "--seed", "7",
  ]);
  const post = requests.find((request) => request.method === "POST");
  assert.equal(post?.path, CLIMBS);
  assert.deepEqual(post?.body, {
    suiteId: "suite-1",
    serverId: "server-1",
    roundLimit: 3,
    creditLimit: 400,
    environmentIds: ["env-stg"],
    measure: "tokens",
    minImprovementBps: 150,
    targetBps: 500,
    groupLists: { steering: ["a", "b"], validation: ["c"] },
    seed: 7,
  });
});

test("start without --wait returns as soon as the baseline has launched", async () => {
  const requests = stubFetch();
  const result = await run("start", START);
  assert.equal(result.state, "baselining");
  assert.equal(requests.filter((request) => request.method === "GET").length, 0);
});

test("start --wait reads the climb until its baseline has settled", async () => {
  const requests = stubFetch({
    [`GET ${CLIMBS}/climb-1`]: [CLIMB, CLIMB, { ...CLIMB, state: "ready" }],
  });
  const waits: number[] = [];
  const context = {
    client: new (await import("@mcpjam/sdk/platform")).PlatformApiClient({
      baseUrl: "https://api.test/api/v1",
      getAuth: () => "t",
      fetch: globalThis.fetch,
    }),
    signal: new AbortController().signal,
  };
  const result = await waitForClimb(
    { climbId: "climb-1" },
    { wait: true, project: "project-1" },
    context,
    (climb) => climb.state !== "baselining",
    async (ms) => void waits.push(ms),
  );
  assert.equal((result as { state: string }).state, "ready");
  assert.equal(waits.length, 2);
  assert.equal(requests.filter((request) => request.method === "GET").length, 3);
});

test("a wait that runs out returns what it last read instead of failing", async () => {
  stubFetch();
  const context = {
    client: new (await import("@mcpjam/sdk/platform")).PlatformApiClient({
      baseUrl: "https://api.test/api/v1",
      getAuth: () => "t",
      fetch: globalThis.fetch,
    }),
    signal: new AbortController().signal,
  };
  const result = await waitForClimb(
    { climbId: "climb-1" },
    { wait: true, waitSeconds: 0, project: "project-1" },
    context,
    () => false,
    async () => {},
  );
  assert.equal((result as { state: string }).state, "baselining");
});

test("update sends basis points, and --clear-target clears the target", async () => {
  const requests = stubFetch();
  await run("update", ["--climb", "climb-1", "--measure", "cost", "--min-improvement-percent", "2"]);
  await run("update", ["--climb", "climb-1", "--clear-target"]);
  const patches = requests.filter((request) => request.method === "PATCH");
  assert.deepEqual(patches.map((request) => request.body), [
    { measure: "cost", minImprovementBps: 200 },
    { targetBps: null },
  ]);
});

test("get and list read the routes", async () => {
  const requests = stubFetch({ [`GET ${CLIMBS}`]: [{ items: [CLIMB] }] });
  await run("get", ["--climb", "climb-1"]);
  await run("list", ["--suite", "Smoke", "--limit", "5"]);
  assert.deepEqual(requests.map((request) => `${request.method} ${request.path}${request.query}`), [
    `GET ${CLIMBS}/climb-1`,
    `GET ${CLIMBS}?suiteId=suite-1&limit=5`,
  ]);
});

test("flag mistakes are usage errors before any request", async () => {
  const requests = stubFetch();
  await assert.rejects(run("start", [...START.slice(0, 4), "--round-limit", "0", "--credit-limit", "5"]), usageError(/--round-limit/));
  await assert.rejects(run("start", [...START.slice(0, 6), "--credit-limit", "x"]), usageError(/--credit-limit must be a number/));
  await assert.rejects(run("start", [...START, "--measure", "speed"]), usageError(/--measure/));
  await assert.rejects(run("start", [...START, "--picker", "robot"]), usageError(/--picker/));
  await assert.rejects(run("start", [...START, "--steering-count", "2", "--steering", "a"]), usageError(/not both/));
  await assert.rejects(run("update", ["--climb", "c", "--clear-target", "--target-percent", "5"]), usageError(/not both/));
  assert.equal(requests.length, 0);
});

test("rounds submit sends the server's id and the retry handle; --wait reads the round until it settles", async () => {
  const requests = stubFetch({
    [`POST ${CLIMBS}/climb-1/rounds`]: [{ climbId: "climb-1", suiteId: "suite-1", roundNumber: 2 }],
    [`GET ${CLIMBS}/climb-1/rounds/2`]: [{ number: 2, status: "running", settled: false }, { number: 2, status: "settled", settled: true, verdict: "kept" }],
  });
  const result = await run("rounds submit", ["--climb", "climb-1", "--server", "echo", "--idempotency-key", "k", "--wait"]);
  assert.equal(result.verdict, "kept");
  const post = requests.find((request) => request.method === "POST");
  assert.deepEqual(post?.body, { serverId: "server-1", idempotencyKey: "k" });
  const reads = requests.filter((request) => request.method === "GET");
  assert.equal(reads.length, 2);
  assert.match(reads[0]!.query, /wait=50/);
});

test("rounds get reads once without --wait, and decide sends the reason", async () => {
  const requests = stubFetch({
    [`GET ${CLIMBS}/climb-1/rounds/2`]: [{ number: 2, status: "running", settled: false }],
    [`POST ${CLIMBS}/climb-1/rounds/2/decision`]: [{ climbId: "climb-1", suiteId: "suite-1", round: {}, best: {} }],
  });
  const round = await run("rounds get", ["--climb", "climb-1", "--round", "2"]);
  assert.equal(round.settled, false);
  await run("rounds decide", ["--climb", "climb-1", "--round", "2", "--decision", "kept", "--reason", "Flaky case."]);
  assert.match(requests[0]!.query, /wait=0/);
  assert.deepEqual(requests[1]!.body, { decision: "kept", reason: "Flaky case." });
});

test("stop posts to the climb, and a bad --decision is a usage error before any request", async () => {
  const requests = stubFetch();
  await run("stop", ["--climb", "climb-1"]);
  assert.equal(requests[0]?.path, `${CLIMBS}/climb-1/stop`);
  await assert.rejects(
    run("rounds decide", ["--climb", "climb-1", "--round", "2", "--decision", "maybe", "--reason", "x"]),
    usageError(/--decision must be kept or reverted/),
  );
  assert.equal(requests.length, 1);
});

test("confirm sends the dry run and the wait; --wait reads the climb for the result after the first call", async () => {
  const requests = stubFetch({
    [`POST ${CLIMBS}/climb-1/confirmation`]: [{ climbId: "climb-1", suiteId: "suite-1", dryRun: false, settled: false }],
    [`GET ${CLIMBS}/climb-1`]: [{ ...CLIMB, confirmationResult: { status: "settled", environments: [] } }],
  });
  await run("confirm", ["--climb", "climb-1", "--dry-run"]);
  assert.deepEqual(requests[0]?.body, { dryRun: true, waitSeconds: 0 });
  const waited = await run("confirm", ["--climb", "climb-1", "--wait"]);
  assert.equal(waited.settled, true);
  const posts = requests.filter((request) => request.method === "POST");
  // One call holds for at most the operation's own bound (50 s), then `get` is read until it settles.
  assert.deepEqual(posts.at(-1)?.body, { waitSeconds: 50 });
});

test("verify sends the commit with the flags; --dry-run starts no wait", async () => {
  const requests = stubFetch({ [`POST ${CLIMBS}/climb-1/verifications`]: [{ climbId: "climb-1", suiteId: "suite-1", ran: false, dryRun: true, settled: false }] });
  await run("verify", ["--climb", "climb-1", "--commit", "abc123", "--branch", "fix", "--dirty", "--server", "echo", "--dry-run", "--run-anyway"]);
  assert.deepEqual(requests[0]?.body, {
    dryRun: true,
    runAnyway: true,
    waitSeconds: 0,
    targetServerId: "server-1",
    commit: { sha: "abc123", branch: "fix", dirty: true },
  });
});
