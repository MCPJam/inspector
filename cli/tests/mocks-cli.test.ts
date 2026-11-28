/**
 * `mcpjam cloud mocks`.
 *
 * What these pin: each command sends the route and body its operation does,
 * prints the result the REST route answers (the same bodies the SDK, REST and
 * MCP tests use, in sdk/tests/fixtures/mock-surfaces.json), and refuses an
 * unclear patch before any request.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { Command } from "commander";
import { registerMocksCommands } from "../src/commands/mocks.js";
import { CliError } from "../src/lib/output.js";
import { addPlatformOptions } from "../src/lib/platform-command.js";
import { captureProcessOutput } from "./support/cli-run.js";

const fixture = JSON.parse(
  readFileSync(new URL("../../sdk/tests/fixtures/mock-surfaces.json", import.meta.url), "utf8"),
) as Record<string, any>;
const { project, base, mock } = fixture.ids as Record<string, string>;
const ROOT = `/api/v1/projects/${project}/mock-servers`;
const PROJECT = {
  id: project,
  name: "Checkout",
  description: null,
  icon: null,
  organizationId: "org-a",
  visibility: null,
  createdAt: 1,
  updatedAt: 2,
};
const SERVERS = [
  { id: base, projectId: project, name: "markets", enabled: true, transportType: "http", url: "https://x.test/mcp", createdAt: 1, updatedAt: 2 },
  { id: mock, projectId: project, name: "markets (mock)", enabled: true, transportType: "http", url: "https://mock.mcpjam.invalid/m", createdAt: 1, updatedAt: 2 },
];
const POLICY = { forwarding: "block", scope: "workspace", updatedAt: 9, projectId: project };

type Captured = { method: string; path: string; query: Record<string, string>; body: unknown };

function stubFetch(): Captured[] {
  const requests: Captured[] = [];
  globalThis.fetch = (async (target: unknown, init?: RequestInit) => {
    const url = new URL(String(target));
    const method = init?.method ?? "GET";
    if (url.pathname.endsWith("/projects")) return Response.json({ items: [PROJECT] });
    if (url.pathname.endsWith(`${project}/servers`)) return Response.json({ items: SERVERS });
    requests.push({
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const key = `${method} ${url.pathname}`;
    if (key === `POST ${ROOT}`) return Response.json(fixture.created, { status: 201 });
    if (key === `GET ${ROOT}/${mock}`) return Response.json(url.searchParams.has("path") ? fixture.value : fixture.summary);
    if (key === `PATCH ${ROOT}/${mock}`) return Response.json(fixture.patched, { status: 201 });
    if (key === `POST ${ROOT}/${mock}/refresh`) return Response.json({ view: "refresh", applied: false });
    if (key === `POST ${ROOT}/${mock}/runs`) return Response.json(fixture.run, { status: 201 });
    if (key === `POST ${ROOT}/${mock}/runs/run-1/reset`) return Response.json(fixture.reset);
    if (key === `POST ${ROOT}/${mock}/runs/run-1/close`) return Response.json(fixture.closed);
    if (url.pathname.endsWith("/mock-forwarding-policy")) return Response.json(POLICY);
    throw new Error(`unexpected ${key}`);
  }) as typeof fetch;
  return requests;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function buildProgram(): Command {
  const program = new Command().name("mcpjam").exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} });
  const cloud = program.command("cloud");
  addPlatformOptions(cloud);
  registerMocksCommands(cloud);
  return program;
}

async function run(verb: string[], args: string[]): Promise<Record<string, any>> {
  const { stdout } = await captureProcessOutput(() =>
    buildProgram().parseAsync(["cloud", "mocks", ...verb, "--project", project, "--api-key", "sk_test", ...args], { from: "user" }),
  );
  return JSON.parse(stdout);
}

// The CLI adds the project and a link to what it prints; the rest is the route's body.
const withoutProject = ({ project: _project, permalinks: _links, ...rest }: Record<string, any>) => rest;

test("create sends the saved server and the definition and prints the result", async () => {
  const requests = stubFetch();
  const printed = await run(["create"], ["--name", "markets (mock)", "--server", "markets", "--definition", '{"instructions":"Use the tools."}']);
  assert.deepEqual(requests[0], {
    method: "POST",
    path: ROOT,
    query: {},
    body: { name: "markets (mock)", serverId: base, definition: { instructions: "Use the tools." } },
  });
  assert.deepEqual(withoutProject(printed), fixture.created);
});

test("get reads the summary, then one field with its selectors", async () => {
  const requests = stubFetch();
  assert.deepEqual(withoutProject(await run(["get"], ["--mock", "markets (mock)"])), fixture.summary);
  const field = await run(["get"], ["--mock", "markets (mock)", "--family", "tools", "--name", "tool_001", "--path", "description", "--cursor", "c1", "--limit", "5"]);
  assert.deepEqual(withoutProject(field), fixture.value);
  assert.deepEqual(requests[1]?.query, { family: "tools", name: "tool_001", path: '["description"]', cursor: "c1", limit: "5" });
});

test("get sends a path with a dotted key as a JSON list", async () => {
  const requests = stubFetch();
  await run(["get"], ["--mock", "markets (mock)", "--family", "tools", "--name", "t", "--path", '["a.b","c"]']);
  assert.equal(requests[0]?.query.path, '["a.b","c"]');
});

test("patch sends one path and the version it read, and prints the result", async () => {
  const requests = stubFetch();
  const printed = await run(["patch"], ["--mock", "markets (mock)", "--expected-version", "2", "--family", "tools", "--name", "tool_001", "--path", "description", "--value-text", "Second."]);
  assert.deepEqual(requests[0]?.body, { expectedVersion: 2, family: "tools", name: "tool_001", path: ["description"], value: "Second." });
  assert.deepEqual(withoutProject(printed), fixture.patched);
});

test("patch removes a path, and refuses a missing or doubled value before any request", async () => {
  const requests = stubFetch();
  await run(["patch"], ["--mock", "markets (mock)", "--expected-version", "2", "--family", "tools", "--name", "t", "--path", "description", "--remove"]);
  assert.deepEqual(requests[0]?.body, { expectedVersion: 2, family: "tools", name: "t", path: ["description"], remove: true });
  const before = requests.length;
  for (const extra of [[], ["--value", "1", "--value-text", "x"], ["--value", "{nope"]]) {
    await assert.rejects(
      run(["patch"], ["--mock", "markets (mock)", "--expected-version", "2", "--path", "instructions", ...extra]),
      (error: unknown) => error instanceof CliError && error.code === "USAGE_ERROR",
    );
  }
  assert.equal(requests.length, before);
});

test("refresh previews unless --apply is given", async () => {
  const requests = stubFetch();
  await run(["refresh"], ["--mock", "markets (mock)", "--expected-version", "2"]);
  await run(["refresh"], ["--mock", "markets (mock)", "--expected-version", "2", "--apply"]);
  assert.deepEqual(requests.map((r) => r.body), [{ expectedVersion: 2 }, { expectedVersion: 2, apply: true }]);
});

test("policy reads and sets the workspace's setting", async () => {
  const requests = stubFetch();
  assert.equal((await run(["policy", "get"], [])).forwarding, "block");
  await run(["policy", "set"], ["--forwarding", "allow"]);
  assert.deepEqual(requests.map((r) => [r.method, r.body]), [["GET", undefined], ["PUT", { forwarding: "allow" }]]);
  await assert.rejects(run(["policy", "set"], ["--forwarding", "maybe"]), (error: unknown) => error instanceof CliError && error.code === "USAGE_ERROR");
});

test("run open, reset and close send the run's route and print what REST answers", async () => {
  const requests = stubFetch();
  assert.deepEqual(withoutProject(await run(["run", "open"], ["--mock", "markets (mock)", "--version", "2", "--platform-run-id", "eval-9"])), fixture.run);
  assert.deepEqual(withoutProject(await run(["run", "reset"], ["--mock", "markets (mock)", "--run-id", "run-1", "--expected-epoch", "1"])), fixture.reset);
  assert.deepEqual(withoutProject(await run(["run", "close"], ["--mock", "markets (mock)", "--run-id", "run-1"])), fixture.closed);
  assert.deepEqual(requests.map((r) => [r.method, r.path.replace(ROOT, ""), r.body]), [
    ["POST", `/${mock}/runs`, { version: 2, platformRunId: "eval-9" }],
    ["POST", `/${mock}/runs/run-1/reset`, { expectedEpoch: 1 }],
    ["POST", `/${mock}/runs/run-1/close`, {}],
  ]);
  await assert.rejects(
    run(["run", "reset"], ["--mock", "markets (mock)", "--run-id", "run-1", "--expected-epoch", "0"]),
    (error: unknown) => error instanceof CliError && error.code === "USAGE_ERROR",
  );
});

test("run open says what to do when the account holds too many open runs", async () => {
  stubFetch();
  const stubbed = globalThis.fetch;
  const message = "You have 100 open test runs. Close one, or wait for one to expire; a run lasts 24 hours.";
  globalThis.fetch = (async (target: unknown, init?: RequestInit) => {
    if (init?.method === "POST" && new URL(String(target)).pathname === `${ROOT}/${mock}/runs`) {
      return Response.json({ code: "CONFLICT", message, details: { code: "MOCK_RUN_LIMIT", limit: 100 } }, { status: 409 });
    }
    return stubbed(target as never, init);
  }) as typeof fetch;
  await assert.rejects(run(["run", "open"], ["--mock", "markets (mock)"]), (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.match(error.message, /You have 100 open test runs\. Close one, or wait for one to expire/);
    return true;
  });
});
