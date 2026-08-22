/**
 * The `mcpjam cloud` namespace: account-bound commands live only under
 * `cloud`, and the frozen local surface stays at the root.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { FROZEN_LOCAL_COMMANDS } from "./local-contract.test.js";
import { runCli } from "./support/cli-run.js";
import { parseHelpCommandNames } from "./support/help.js";

const MOVED_CLOUD_GROUPS = [
  "login",
  "logout",
  "whoami",
  "status",
  "link",
  "organizations",
  "projects",
  "eval",
  "sessions",
  "hosts",
  "environments",
  "journeys",
  "scenarios",
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

  const root = parseHelpCommandNames(run.stdout);
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
  const names = parseHelpCommandNames(run.stdout);
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

test("root help groups local testing, Cloud, and CLI commands", async () => {
  const run = await runCli(["--help"]);
  assert.equal(run.exitCode, 0, run.stderr);
  assert.match(run.stdout, /Local MCP testing:/);
  assert.match(run.stdout, /MCPJam Cloud:/);
  assert.match(run.stdout, /CLI:/);
});

test("cloud help groups account, workspace, eval, and swarms commands", async () => {
  const run = await runCli(["cloud", "--help"]);
  assert.equal(run.exitCode, 0, run.stderr);
  assert.match(run.stdout, /Account:/);
  assert.match(run.stdout, /Workspace:/);
  assert.match(run.stdout, /Eval and environments:/);
  assert.match(run.stdout, /Swarms and user testing:/);
});

test("cloud images validate help names the Cloud image linter", async () => {
  const run = await runCli(["cloud", "images", "validate", "--help"]);
  assert.equal(run.exitCode, 0, run.stderr);
  assert.match(run.stdout, /MCPJam Cloud image linter/);
});

test("cloud capabilities moved under projects; chat-sessions is gone", async () => {
  const capabilities = await runCli([
    "--format",
    "json",
    "cloud",
    "capabilities",
  ]);
  assert.equal(capabilities.exitCode, 2);
  assert.match(capabilities.stderr, /unknown command 'capabilities'/);

  const nested = await runCli(["cloud", "projects", "capabilities", "--help"]);
  assert.equal(nested.exitCode, 0, nested.stderr);
  assert.match(nested.stdout, /Usage: mcpjam cloud projects capabilities/);

  const chatSessions = await runCli([
    "--format",
    "json",
    "cloud",
    "chat-sessions",
  ]);
  assert.equal(chatSessions.exitCode, 2);
  assert.match(chatSessions.stderr, /unknown command 'chat-sessions'/);

  const list = await runCli(["cloud", "sessions", "list", "--help"]);
  assert.equal(list.exitCode, 0, list.stderr);
  assert.match(list.stdout, /Usage: mcpjam cloud sessions list/);
});

test("projects server alias is gone; servers remains", async () => {
  const alias = await runCli([
    "--format",
    "json",
    "cloud",
    "projects",
    "server",
  ]);
  assert.equal(alias.exitCode, 2);
  assert.match(alias.stderr, /unknown command 'server'/);

  const canonical = await runCli(["cloud", "projects", "servers", "--help"]);
  assert.equal(canonical.exitCode, 0, canonical.stderr);
  assert.match(canonical.stdout, /Usage: mcpjam cloud projects servers/);
});

test("mcpjam cloud login --help is the Cloud account login", async () => {
  const run = await runCli(["cloud", "login", "--help"]);
  assert.equal(run.exitCode, 0, run.stderr);
  assert.match(run.stdout, /Usage: mcpjam cloud login/);
  assert.match(run.stdout, /Log in to MCPJam Cloud/);
});

