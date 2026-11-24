/**
 * `mcpjam cloud mocks`.
 *
 * What these pin: each verb sends the route and body the mock API documents,
 * a definition or patch comes from inline JSON, a file or stdin, and a flag
 * mistake is a usage error before any request.
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { Command } from "commander";
import { registerMocksCommands } from "../src/commands/mocks.js";
import { CliError } from "../src/lib/output.js";
import { addPlatformOptions } from "../src/lib/platform-command.js";
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
const server = (id: string, name: string) => ({
  id,
  projectId: PROJECT.id,
  name,
  enabled: true,
  transportType: "http",
  url: "https://mcp.example.com/mcp",
  useOAuth: false,
  hasClientSecret: false,
  createdAt: 1,
  updatedAt: 2,
});
const SAVED = { id: "mock-1", version: 1, address: "https://app.test/api/web/mock-mcp/mock-1", changes: [] };

const MOCKS = "/api/v1/projects/project-1/mock-servers";
type Captured = { method: string; path: string; query: string; body: unknown };

/** The API the commands reach: the project and server lists, and a recorded mock answer. */
function stubFetch(): Captured[] {
  const requests: Captured[] = [];
  globalThis.fetch = (async (target: unknown, init?: RequestInit) => {
    const url = new URL(String(target));
    if (url.pathname.endsWith("/projects")) return Response.json({ items: [PROJECT] });
    if (url.pathname.endsWith("/projects/project-1/servers")) {
      return Response.json({ items: [server("server-1", "markets"), server("mock-1", "markets (mock)")] });
    }
    requests.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      query: url.search,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return Response.json(SAVED);
  }) as typeof fetch;
  return requests;
}

function buildProgram(): Command {
  const program = new Command()
    .name("mcpjam")
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: () => {} });
  const cloud = program.command("cloud");
  addPlatformOptions(cloud);
  registerMocksCommands(cloud);
  return program;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function run(verb: string, args: string[]) {
  const { stdout } = await captureProcessOutput(() =>
    buildProgram().parseAsync(["cloud", "mocks", verb, "--project", "project-1", "--api-key", "sk_test", ...args], {
      from: "user",
    }),
  );
  return JSON.parse(stdout);
}

async function jsonFile(contents: string): Promise<string> {
  const file = path.join(await mkdtemp(path.join(os.tmpdir(), "mcpjam-mock-")), "definition.json");
  await writeFile(file, contents, "utf8");
  return file;
}

function usageError(pattern: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof CliError, String(error));
    assert.equal(error.code, "USAGE_ERROR");
    assert.match(error.message, pattern);
    return true;
  };
}

const DEFINITION = { tools: { echo: { description: "Say it back." } } };

test("create sends the definition from a file, with the saved server's id", async () => {
  const requests = stubFetch();
  const file = await jsonFile(JSON.stringify(DEFINITION));
  const printed = await run("create", ["--name", "m", "--server", "markets", "--definition-file", file]);

  assert.deepEqual(requests, [
    {
      method: "POST",
      path: MOCKS,
      query: "",
      body: { name: "m", serverId: "server-1", definition: DEFINITION },
    },
  ]);
  assert.equal(printed.address, SAVED.address);
});

test("create takes inline JSON and may leave the server out", async () => {
  const requests = stubFetch();
  await run("create", ["--name", "m", "--definition", "{}"]);
  assert.deepEqual(requests[0].body, { name: "m", definition: {} });
});

test("create needs exactly one definition source, and an object", async () => {
  const requests = stubFetch();
  await assert.rejects(run("create", ["--name", "m"]), usageError(/--definition/));
  await assert.rejects(
    run("create", ["--name", "m", "--definition", "{}", "--definition-file", "x.json"]),
    usageError(/only one of/),
  );
  await assert.rejects(run("create", ["--name", "m", "--definition", "[1]"]), usageError(/must be a JSON object/));
  await assert.rejects(run("create", ["--name", "m", "--definition", "nope"]), usageError(/is not JSON/));
  await assert.rejects(
    run("create", ["--name", "m", "--definition-file", "/no/such/file.json"]),
    usageError(/Could not read/),
  );
  assert.deepEqual(requests, []);
});

test("update sends a patch at the version read, by the mock's name, as a dry run", async () => {
  const requests = stubFetch();
  await run("update", [
    "--mock",
    "markets (mock)",
    "--expected-version",
    "2",
    "--patch",
    '{"tools":{"echo":null}}',
    "--dry-run",
  ]);
  assert.deepEqual(requests, [
    {
      method: "POST",
      path: `${MOCKS}/mock-1/versions`,
      query: "",
      body: { patch: { tools: { echo: null } }, expectedVersion: 2, dryRun: true },
    },
  ]);
});

test("update sends a whole definition from a file", async () => {
  const requests = stubFetch();
  const file = await jsonFile(JSON.stringify(DEFINITION));
  await run("update", ["--mock", "mock-1", "--expected-version", "1", "--definition-file", file]);
  assert.deepEqual(requests[0].body, { definition: DEFINITION, expectedVersion: 1 });
});

test("update needs one of a definition and a patch, and a version", async () => {
  const requests = stubFetch();
  await assert.rejects(run("update", ["--mock", "mock-1", "--expected-version", "1"]), usageError(/--definition/));
  await assert.rejects(
    run("update", ["--mock", "mock-1", "--expected-version", "1", "--definition", "{}", "--patch", "{}"]),
    usageError(/only one of/),
  );
  await assert.rejects(
    run("update", ["--mock", "mock-1", "--expected-version", "0", "--patch", "{}"]),
    usageError(/--expected-version must be at least 1/),
  );
  assert.deepEqual(requests, []);
});

test("get sends the version and what to compare it with", async () => {
  const requests = stubFetch();
  await run("get", ["--mock", "markets (mock)", "--version", "3", "--since", "1"]);
  assert.deepEqual(requests, [
    { method: "GET", path: `${MOCKS}/mock-1`, query: "?version=3&since=1", body: undefined },
  ]);
});
