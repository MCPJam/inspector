import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Command } from "commander";
import { registerGoalsCommands } from "../src/commands/goals.js";
import { registerSwarmAuthoringCommands } from "../src/commands/swarms.js";
import { addPlatformOptions } from "../src/lib/platform-command.js";

/**
 * The renamed flags on `cloud goals` and `cloud swarms`, pinned at the WIRE.
 *
 * Every one of these takes two spellings, and the operations they call renamed
 * their input fields underneath. That combination has one failure mode and it
 * is silent: a mapper that still forwards the old key hands the operation a
 * property it does not declare, the conditional spread means TypeScript runs
 * no excess-property check, and the CLI calls `execute` directly so Zod never
 * sees it either. The flag parses, nothing is refused, and the value is
 * dropped on the floor.
 *
 * So these assert what reached the REQUEST BODY, not that the command exited
 * zero — the only check that can tell "forwarded" from "accepted and
 * discarded" apart.
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

/** Capture every request, answering the project read and then anything else. */
function captureRequests(): { url: string; init?: RequestInit }[] {
  const requests: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (target: unknown, init?: RequestInit) => {
    const url = String(target);
    requests.push({ url, init });
    if (/\/projects(\?|$)/.test(url)) return Response.json(PROJECT_PAGE);
    return Response.json({ id: "x", projectId: "project-1" }, { status: 200 });
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

test("goals run forwards the batch id under BOTH flag spellings", async () => {
  // `launch_goal_run` renamed its input from `waveId` to `swarmRunId`. A
  // mapper still sending `waveId` would launch a run with no batch id, and
  // sibling runs of one co-launched batch would stop being linkable.
  for (const [flag, value] of [
    ["--swarm-run", "sr_1"],
    ["--wave", "sr_2"],
  ]) {
    const requests = captureRequests();
    await buildProgram().parseAsync(
      [
        "cloud",
        "goals",
        "run",
        "--goal-id",
        "goal-1",
        flag,
        value,
        "--api-key",
        "sk_test",
      ],
      { from: "user" }
    );
    const launch = requests.find((r) => r.url.includes("/runs"));
    assert.ok(launch, `${flag}: expected a launch request`);
    assert.deepEqual(JSON.parse(String(launch.init?.body)), {
      swarmRunId: value,
    });
  }
});

test("goals run refuses both batch-id spellings rather than picking one", async () => {
  const requests = captureRequests();
  await assert.rejects(
    buildProgram().parseAsync(
      [
        "cloud",
        "goals",
        "run",
        "--goal-id",
        "goal-1",
        "--swarm-run",
        "sr_1",
        "--wave",
        "sr_2",
        "--api-key",
        "sk_test",
      ],
      { from: "user" }
    ),
    (error: unknown) => {
      assert.match(String((error as Error).message), /not both/);
      return true;
    }
  );
  assert.equal(
    requests.filter((r) => r.url.includes("/runs")).length,
    0,
    "refused before any launch"
  );
});

test("swarms update forwards iterations under BOTH flag spellings", async () => {
  // `addConfigOptions` registers `--iterations` on this command, so a mapper
  // reading only `--sessions-per-target` accepts the canonical flag and
  // changes nothing — the caller is told their edit landed when it did not.
  for (const [flag, value] of [
    ["--iterations", "7"],
    ["--sessions-per-target", "9"],
  ]) {
    const requests = captureRequests();
    await buildProgram().parseAsync(
      [
        "cloud",
        "swarms",
        "update",
        "--swarm",
        "swarm-1",
        flag,
        value,
        "--max-turns",
        "12",
        "--api-key",
        "sk_test",
      ],
      { from: "user" }
    );
    const patch = requests.find((r) => r.init?.method === "PATCH");
    assert.ok(patch, `${flag}: expected a PATCH`);
    assert.deepEqual(JSON.parse(String(patch.init?.body)), {
      iterations: Number(value),
      maxTurns: 12,
    });
  }
});

test("swarms update refuses both iteration spellings", async () => {
  const requests = captureRequests();
  await assert.rejects(
    buildProgram().parseAsync(
      [
        "cloud",
        "swarms",
        "update",
        "--swarm",
        "swarm-1",
        "--iterations",
        "7",
        "--sessions-per-target",
        "9",
        "--max-turns",
        "12",
        "--api-key",
        "sk_test",
      ],
      { from: "user" }
    ),
    (error: unknown) => {
      assert.match(String((error as Error).message), /not both/);
      return true;
    }
  );
  assert.equal(
    requests.filter((r) => r.init?.method === "PATCH").length,
    0,
    "refused before any write"
  );
});
