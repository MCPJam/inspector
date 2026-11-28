import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Command } from "commander";
import { registerGoalsCommands } from "../src/commands/goals.js";
import { registerSwarmAuthoringCommands } from "../src/commands/swarms.js";
import { addPlatformOptions } from "../src/lib/platform-command.js";

/**
 * `cloud swarms status` and `cloud swarms sessions`, pinned at the request
 * they send: the swarm run in the path, and the opt-in and paging flags in
 * the query.
 */

function buildProgram(): Command {
  const program = new Command()
    .name("mcpjam")
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: () => {} });
  const cloud = program.command("cloud");
  addPlatformOptions(cloud);
  const goals = registerGoalsCommands(cloud);
  registerSwarmAuthoringCommands(cloud, goals);
  return program;
}

const PROJECT_PAGE = {
  items: [
    {
      id: "project-1",
      name: "New",
      description: null,
      icon: null,
      organizationId: "org-a",
      visibility: null,
      createdAt: 1,
      updatedAt: 2,
    },
  ],
};

/** Capture the swarm run requests, answering the project read first. */
function captureRequests(): URL[] {
  const requests: URL[] = [];
  globalThis.fetch = (async (target: unknown) => {
    const url = new URL(String(target));
    if (url.pathname.endsWith("/projects")) return Response.json(PROJECT_PAGE);
    requests.push(url);
    return Response.json(
      url.pathname.endsWith("/sessions")
        ? { items: [] }
        : { swarmRunId: "sr_1", runs: [], launch: null }
    );
  }) as typeof fetch;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  return requests;
}

const realFetch = globalThis.fetch;
const realWrite = process.stdout.write;
afterEach(() => {
  globalThis.fetch = realFetch;
  process.stdout.write = realWrite;
});

function run(args: string[]) {
  const argv = ["cloud", "swarms", ...args, "--api-key", "sk_test"];
  return buildProgram().parseAsync(argv, { from: "user" });
}

test("swarms status reads one swarm run, without launch failures unless asked", async () => {
  const requests = captureRequests();
  await run(["status", "sr_1"]);
  assert.equal(requests.length, 1);
  assert.match(
    requests[0]!.pathname,
    /\/projects\/project-1\/swarm-runs\/sr_1$/
  );
  assert.equal(requests[0]!.searchParams.has("include"), false);

  const withFailures = captureRequests();
  await run(["status", "sr_1", "--launch-failures"]);
  assert.equal(withFailures[0]!.searchParams.get("include"), "launchFailures");
});

test("swarms sessions forwards --cursor and --limit", async () => {
  const requests = captureRequests();
  await run(["sessions", "sr_1", "--cursor", "c1", "--limit", "2"]);
  assert.equal(requests.length, 1);
  assert.match(
    requests[0]!.pathname,
    /\/projects\/project-1\/swarm-runs\/sr_1\/sessions$/
  );
  assert.equal(requests[0]!.searchParams.get("cursor"), "c1");
  assert.equal(requests[0]!.searchParams.get("limit"), "2");
});

test("swarms sessions refuses a --limit out of range before any request", async () => {
  for (const limit of ["0", "201", "many"]) {
    const requests = captureRequests();
    await assert.rejects(
      run(["sessions", "sr_1", "--limit", limit]),
      /--limit/
    );
    assert.equal(requests.length, 0, `--limit ${limit} sent a request`);
  }
});
