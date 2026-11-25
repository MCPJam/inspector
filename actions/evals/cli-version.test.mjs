import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveCliVersion } from "./cli-version.mjs";
import { parseInputs, runAction } from "./run.mjs";

const env = {
  MCPJAM_API_KEY: "sk-test",
  MCPJAM_ACTION_PROJECT: "project",
  MCPJAM_ACTION_SUITE: "suite",
  MCPJAM_ACTION_IDEMPOTENCY_KEY: "test",
};

test("defaults to CLI 6 and permits explicit major lines or exact pins", () => {
  assert.equal(parseInputs(env).cliVersion, "6");
  for (const value of ["6", "7", "6.4.1", "6.5.0-rc.1"]) {
    assert.equal(
      parseInputs({ ...env, MCPJAM_ACTION_CLI_VERSION: value }).cliVersion,
      value,
    );
  }
  for (const value of [
    "latest",
    "^6",
    "6.x",
    "file:cli",
    "6;id",
    "https://example.com/cli",
  ])
    assert.throws(() =>
      parseInputs({ ...env, MCPJAM_ACTION_CLI_VERSION: value }),
    );
});

test("resolves the newest stable version numerically and requests fresh npm metadata", async () => {
  const run = async (command, args, options) => {
    assert.equal(command, "npm");
    assert.deepEqual(args, [
      "view",
      "@mcpjam/cli@6",
      "version",
      "--json",
      "--prefer-online",
    ]);
    assert.equal(options.timeout, 30_000);
    return {
      stdout: JSON.stringify([
        "6.4.9",
        "6.4.10",
        "6.4.1",
        "7.0.0",
        "6.5.0-rc.1",
      ]),
    };
  };
  assert.equal(await resolveCliVersion("6", run), "6.4.10");
  assert.equal(
    await resolveCliVersion("6", async () => ({ stdout: '"6.4.1"' })),
    "6.4.1",
  );
  assert.equal(
    await resolveCliVersion("6.4.1", () => {
      throw new Error("must not resolve pins");
    }),
    "6.4.1",
  );
  for (const stdout of ["[]", "null", '"7.0.0"', "invalid"])
    await assert.rejects(resolveCliVersion("6", async () => ({ stdout })));
});

test("registry failure prevents launching an eval and explains the next step", async () => {
  let launches = 0;
  const state = await runAction(
    env,
    async () => {
      launches++;
    },
    () => {},
    undefined,
    undefined,
    async () => {
      throw new Error("registry unavailable sk-test");
    },
  );
  assert.equal(launches, 0);
  assert.equal(state.result, "failed");
  assert.match(state.message, /resolve the CLI version.*registry access/);
  assert.ok(!state.message.includes("sk-test"));
});

test("a major line resolves once and the run and gates share its exact release", async (t) => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "eval-version-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  let resolutions = 0;
  const rows = [{ id: "run1", status: "completed", result: "passed" }];
  const invoke = async (args) => {
    calls.push(args);
    const path = args.find((arg) => arg.startsWith("--out=")).slice(6);
    if (args.includes("run")) {
      await writeFile(
        path,
        JSON.stringify({
          schemaVersion: 1,
          kind: "eval-run",
          cases: [],
          metadata: {
            runs: rows.map((row) => ({ ...row, iterationsComplete: true })),
          },
        }),
      );
      return {
        code: 0,
        stdout: JSON.stringify({
          launch: {
            outcome: "started",
            targets: [{ status: "started", runId: "run1" }],
          },
          runs: rows,
        }),
      };
    }
    await writeFile(path, '<testsuites name="gates"></testsuites>');
    return { code: 0, stdout: "" };
  };
  const result = await runAction(
    { ...env, RUNNER_TEMP: directory, MCPJAM_ACTION_GATE: "true" },
    invoke,
    () => {},
    undefined,
    undefined,
    async (selector) => {
      assert.equal(selector, "6");
      resolutions++;
      return "6.4.10";
    },
  );
  assert.equal(result.result, "passed");
  assert.equal(resolutions, 1);
  assert.equal(calls.length, 2);
  for (const args of calls) assert.ok(args.includes("@mcpjam/cli@6.4.10"));
});
