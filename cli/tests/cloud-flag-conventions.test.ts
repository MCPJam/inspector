/**
 * Cloud flag spelling and Commander placeholder conventions.
 *
 * `--org` is the ID-only organization filter. Tunnel registers a server with
 * `--server`; `--id` remains a hidden alias. Placeholders that accept a name
 * or an id are `<id-or-name>`, never camelCase or `name-or-id`.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runCli } from "./support/cli-run.js";

const COMMANDS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/commands"
);

const CLOUD_COMMAND_FILES = [
  "auth.ts",
  "cloud.ts",
  "cloud-link.ts",
  "environments.ts",
  "eval.ts",
  "hosts.ts",
  "images.ts",
  "journeys.ts",
  "organizations.ts",
  "projects.ts",
  "registry.ts",
  "scenarios.ts",
  "sessions.ts",
  "swarms.ts",
  "tunnel.ts",
  "user-testing.ts",
] as const;

test("Cloud command sources follow flag and placeholder conventions", () => {
  const listed = new Set<string>(CLOUD_COMMAND_FILES);
  for (const file of readdirSync(COMMANDS_DIR)) {
    if (!file.endsWith(".ts")) continue;
    if (file === "readiness.ts") continue;
    if (
      [
        "apps.ts",
        "compat.ts",
        "conformance.ts",
        "conformance-run.ts",
        "inspector.ts",
        "mcp.ts",
        "oauth.ts",
        "prompts.ts",
        "resources.ts",
        "server.ts",
        "subscriptions.ts",
        "tasks.ts",
        "telemetry.ts",
        "tools.ts",
        "xaa.ts",
      ].includes(file)
    ) {
      continue;
    }
    assert.ok(
      listed.has(file),
      `Cloud command file ${file} is not in CLOUD_COMMAND_FILES`
    );
  }

  for (const file of CLOUD_COMMAND_FILES) {
    const source = readFileSync(path.join(COMMANDS_DIR, file), "utf8");
    assert.doesNotMatch(
      source,
      /--organization-id/,
      `${file} still declares --organization-id; use --org`
    );
    assert.doesNotMatch(
      source,
      /<idOrName>/,
      `${file} uses camelCase <idOrName>; use <id-or-name>`
    );
    assert.doesNotMatch(
      source,
      /<name-or-id/,
      `${file} uses <name-or-id>; use <id-or-name>`
    );
  }
});

test("projects list and create help show --org, not --organization-id", async () => {
  const list = await runCli(["cloud", "projects", "list", "--help"]);
  assert.equal(list.exitCode, 0, list.stderr);
  assert.match(list.stdout, /--org <id>/);
  assert.doesNotMatch(list.stdout, /--organization-id/);

  const create = await runCli(["cloud", "projects", "create", "--help"]);
  assert.equal(create.exitCode, 0, create.stderr);
  assert.match(create.stdout, /--org <id>/);
  assert.doesNotMatch(create.stdout, /--organization-id/);
});

test("projects list --organization-id is an unknown option", async () => {
  const run = await runCli([
    "--format",
    "json",
    "cloud",
    "projects",
    "list",
    "--organization-id",
    "org-1",
  ]);
  assert.equal(run.exitCode, 2);
  assert.match(run.stderr, /unknown option '--organization-id'/i);
});

test("tunnel help shows --server and hides --id", async () => {
  const run = await runCli(["cloud", "tunnel", "--help"]);
  assert.equal(run.exitCode, 0, run.stderr);
  assert.match(run.stdout, /--server <name>/);
  assert.doesNotMatch(run.stdout, /--id <name>/);
  assert.doesNotMatch(run.stdout, /--id,/);
});
