/**
 * The `mcpjam cloud` namespace: account-bound commands live only under
 * `cloud`, and the frozen local surface stays at the root.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { FROZEN_LOCAL_COMMANDS } from "./local-contract.test.js";
import { runCli } from "./support/cli-run.js";

function parseCommandNames(help: string): string[] {
  const marker = "\nCommands:\n";
  const start = help.indexOf(marker);
  if (start === -1) {
    return [];
  }
  const names: string[] = [];
  for (const line of help.slice(start + marker.length).split("\n")) {
    const match = line.match(
      /^  ([a-z][\w|-]*)(?: \[options\])?(?: \[[^\]]+\])?\s{2,}/
    );
    if (!match) {
      continue;
    }
    const name = match[1].split("|")[0];
    if (name !== "help") {
      names.push(name);
    }
  }
  return names;
}

const MOVED_CLOUD_GROUPS = [
  "login",
  "logout",
  "whoami",
  "status",
  "link",
  "organizations",
  "projects",
  "eval",
  "chat-sessions",
  "sessions",
  "hosts",
  "environments",
  "journeys",
  "scenarios",
  "capabilities",
  "personas",
  "swarms",
  "user-testing",
  "images",
  "tunnel",
] as const;

test("root help names local and cloud modes", async () => {
  const run = await runCli(["--help"]);
  assert.equal(run.exitCode, 0, run.stderr);
  assert.match(run.stdout, /locally/);
  assert.match(run.stdout, /mcpjam cloud/);

  const root = parseCommandNames(run.stdout);
  for (const name of FROZEN_LOCAL_COMMANDS) {
    assert.ok(
      root.includes(name),
      `frozen local command missing from root: ${name}`
    );
  }
  assert.ok(root.includes("cloud"), "root help must list the cloud command");
  for (const name of MOVED_CLOUD_GROUPS) {
    assert.ok(
      !root.includes(name),
      `account-bound command still at root: ${name}`
    );
  }
});

test("old account-bound root paths are unknown commands", async () => {
  const run = await runCli(["--format", "json", "login"]);
  assert.equal(run.exitCode, 2);
  assert.equal(run.stdout, "");
  const payload = JSON.parse(run.stderr) as {
    error?: { code?: string; message?: string };
  };
  assert.equal(payload.error?.code, "USAGE_ERROR");
  assert.match(payload.error?.message ?? "", /unknown command 'login'/);
});

test("cloud --help lists the moved account-bound groups", async () => {
  const run = await runCli(["cloud", "--help"]);
  assert.equal(run.exitCode, 0, run.stderr);
  const names = parseCommandNames(run.stdout);
  for (const name of MOVED_CLOUD_GROUPS) {
    assert.ok(names.includes(name), `cloud help missing ${name}`);
  }
  for (const name of FROZEN_LOCAL_COMMANDS) {
    assert.ok(
      !names.includes(name),
      `local command listed under cloud: ${name}`
    );
  }
});

test("mcpjam cloud login --help is the Cloud account login", async () => {
  const run = await runCli(["cloud", "login", "--help"]);
  assert.equal(run.exitCode, 0, run.stderr);
  assert.match(run.stdout, /Usage: mcpjam cloud login/);
  assert.match(run.stdout, /Log in to MCPJam/);
});
