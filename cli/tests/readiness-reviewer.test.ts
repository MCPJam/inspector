/**
 * `mcpjam readiness reviewer`: each verb sends the route and body the
 * reviewer attempts API documents, with secret names only. No flag takes a
 * credential's value.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Command } from "commander";
import { registerReadinessCommands } from "../src/commands/readiness.js";
import { captureProcessOutput } from "./support/cli-run.js";

const PROJECT = {
  id: "project-1",
  name: "Checkout",
  description: null,
  icon: null,
  organizationId: "org-a",
  visibility: null,
  createdAt: 1,
  updatedAt: 2,
};
const ATTEMPT = {
  id: "att-1",
  submissionId: "sub-1",
  projectId: PROJECT.id,
  serverId: "server-1",
  passwordSecretName: "MCPJAM_REVIEWER_ACME_PASSWORD",
  state: "running",
  stages: [],
  runIds: [],
  expiresAt: 10,
  createdBy: "user-1",
  createdAt: 1,
  updatedAt: 1,
};
const RUN = { runId: "run-1", status: "pending", deduped: false };
const BASE = "/api/v1/projects/project-1/directory-submissions/sub-1/reviewer-attempts";

type Captured = { key: string; query: Record<string, string>; body: unknown };

/** The API the commands reach: one reply per key. */
function stubFetch(routes: Record<string, unknown>): Captured[] {
  const requests: Captured[] = [];
  globalThis.fetch = (async (target: unknown, init?: RequestInit) => {
    const url = new URL(String(target));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    if (key.endsWith("/projects")) return Response.json({ items: [PROJECT] });
    if (!(key in routes)) throw new Error(`unexpected ${key}`);
    requests.push({
      key,
      query: Object.fromEntries(url.searchParams),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return Response.json(routes[key]);
  }) as typeof fetch;
  return requests;
}

function buildProgram(): Command {
  const program = new Command()
    .name("mcpjam")
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerReadinessCommands(program);
  return program;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function run(args: string[]) {
  const { stdout } = await captureProcessOutput(() =>
    buildProgram().parseAsync(["readiness", "reviewer", ...args, "--api-key", "sk_test"], {
      from: "user",
    })
  );
  return JSON.parse(stdout) as Record<string, unknown>;
}

test("start sends secret names and plain fields, and prints the attempt and its run", async () => {
  const requests = stubFetch({ [`POST ${BASE}`]: { attempt: ATTEMPT, run: RUN } });
  const printed = await run([
    "start",
    "sub-1",
    "--password-secret",
    "MCPJAM_REVIEWER_ACME_PASSWORD",
    "--username",
    "review@example.com",
    "--tenant",
    "Acme",
  ]);
  assert.deepEqual(requests[0]!.body, {
    passwordSecretName: "MCPJAM_REVIEWER_ACME_PASSWORD",
    username: "review@example.com",
    tenant: "Acme",
  });
  assert.deepEqual(printed.attempt, ATTEMPT);
  assert.deepEqual(printed.run, RUN);
});

test("no flag takes a credential's value", async () => {
  const requests = stubFetch({});
  await assert.rejects(
    run([
      "start",
      "sub-1",
      "--password-secret",
      "MCPJAM_REVIEWER_ACME_PASSWORD",
      "--password",
      "reviewer-password-sample",
    ]),
    /unknown option '--password'/
  );
  // A value passed as a secret's name is refused before anything is sent.
  await assert.rejects(
    run(["start", "sub-1", "--password-secret", "reviewer password sample"]),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "USAGE_ERROR");
      assert.doesNotMatch(String((error as Error).message), /reviewer password sample/);
      return true;
    }
  );
  assert.deepEqual(requests, []);
});

test("status lists the attempts, or shows the one it is given", async () => {
  const requests = stubFetch({
    [`GET ${BASE}`]: { items: [ATTEMPT] },
    [`GET ${BASE}/att-1`]: ATTEMPT,
  });
  const listed = await run(["status", "sub-1", "--limit", "5"]);
  const shown = await run(["status", "sub-1", "--attempt", "att-1"]);
  assert.deepEqual(
    requests.map((request) => [request.key, request.query]),
    [
      [`GET ${BASE}`, { limit: "5" }],
      [`GET ${BASE}/att-1`, {}],
    ]
  );
  assert.deepEqual(listed.attempts, [ATTEMPT]);
  assert.deepEqual(shown.attempt, ATTEMPT);
});

test("resume and cancel name the attempt", async () => {
  const requests = stubFetch({
    [`POST ${BASE}/att-1/resume`]: { attempt: ATTEMPT, run: RUN },
    [`POST ${BASE}/att-1/cancel`]: { ...ATTEMPT, state: "cancelled" },
  });
  const resumed = await run(["resume", "sub-1", "--attempt", "att-1"]);
  const cancelled = await run(["cancel", "sub-1", "--attempt", "att-1"]);
  assert.deepEqual(
    requests.map((request) => request.key),
    [`POST ${BASE}/att-1/resume`, `POST ${BASE}/att-1/cancel`]
  );
  assert.deepEqual(resumed.run, RUN);
  assert.equal((cancelled.attempt as { state: string }).state, "cancelled");
  await assert.rejects(run(["cancel", "sub-1"]), /--attempt/);
});
