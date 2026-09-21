import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Command, CommanderError } from "commander";
import { registerScenariosCommands } from "../src/commands/scenarios.js";
import { addPlatformOptions } from "../src/lib/platform-command.js";

/**
 * `mcpjam cloud scenarios publish` — the create-time override flags.
 *
 * What these pin: `--mode` is validated against the enum LOCALLY, so a typo is
 * a usage error and not a server round trip; and the accepted flags reach the
 * PUT body verbatim, in the one call that both creates the scenario and sets
 * who may open it.
 */

function buildProgram(): Command {
  const program = new Command()
    .name("mcpjam")
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: () => {} });
  const cloud = program.command("cloud");
  addPlatformOptions(cloud);
  registerScenariosCommands(cloud);
  return program;
}

const realFetch = globalThis.fetch;
const realWrite = process.stdout.write;
afterEach(() => {
  globalThis.fetch = realFetch;
  process.stdout.write = realWrite;
});

test("publish rejects a mode outside the enum without any request", async () => {
  const calls: unknown[] = [];
  globalThis.fetch = (async (...args: unknown[]) => {
    calls.push(args);
    throw new Error("unreachable");
  }) as typeof fetch;

  await assert.rejects(
    buildProgram().parseAsync(
      [
        "cloud",
        "scenarios",
        "publish",
        "--environment",
        "env-1",
        "--mode",
        "everyone",
        "--api-key",
        "sk_test",
      ],
      { from: "user" }
    ),
    (error: unknown) => {
      assert.ok(error instanceof CommanderError);
      assert.match(
        error.message,
        /project_members, invited_only, anyone_with_link/
      );
      return true;
    }
  );
  assert.equal(calls.length, 0);
});

test("publish forwards --name, --description and --mode in the PUT body", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (target: unknown, init?: RequestInit) => {
    const url = String(target);
    requests.push({ url, init });
    if (/\/projects(\?|$)/.test(url)) {
      return Response.json({
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
      });
    }
    if (url.includes("/scenario")) {
      return Response.json(
        {
          id: "scenario-1",
          environmentId: "env-1",
          name: "Beta run",
          mode: "invited_only",
          accessVersion: 1,
          link: "https://app.mcpjam.com/s/beta?t=abc",
          created: true,
        },
        { status: 201 }
      );
    }
    return Response.json(
      { code: "NOT_FOUND", message: `No route for ${url}` },
      { status: 404 }
    );
  }) as typeof fetch;
  // The command prints the result; keep the test runner's output clean.
  process.stdout.write = (() => true) as typeof process.stdout.write;

  await buildProgram().parseAsync(
    [
      "cloud",
      "scenarios",
      "publish",
      "--environment",
      "env-1",
      "--name",
      "Beta run",
      "--description",
      "Invited testers only",
      "--mode",
      "invited_only",
      "--api-key",
      "sk_test",
    ],
    { from: "user" }
  );

  const put = requests.find((request) => request.url.includes("/scenario"));
  assert.ok(put, "expected a PUT to the scenario route");
  assert.equal(put.init?.method, "PUT");
  assert.match(
    put.url,
    /\/projects\/project-1\/environments\/env-1\/scenario$/
  );
  assert.deepEqual(JSON.parse(String(put.init?.body)), {
    name: "Beta run",
    description: "Invited testers only",
    mode: "invited_only",
  });
});
