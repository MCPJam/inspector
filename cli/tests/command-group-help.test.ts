/**
 * A command group run without a subcommand (`mcpjam cloud`) shows that group's
 * help and exits 2. It used to print `{"error":{"message":"(outputHelp)"}}`
 * and no help, because `main` silences Commander's `writeErr`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "./support/cli-run.js";
import { parseHelpCommandNames } from "./support/help.js";

function parseError(stderr: string): {
  error: { code: string; message: string; details?: unknown };
} {
  return JSON.parse(stderr);
}

test("cloud without a subcommand shows its help in human format", async () => {
  const run = await runCli(["cloud", "--format", "human"]);
  assert.equal(run.exitCode, 2);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /^Usage: mcpjam cloud /);
  const names = parseHelpCommandNames(run.stderr);
  assert.ok(names.includes("login"), run.stderr);
  assert.ok(names.includes("projects"), run.stderr);
  assert.doesNotMatch(run.stderr, /outputHelp/);
});

test("cloud without a subcommand is a usage error naming it in JSON", async () => {
  const run = await runCli(["--format", "json", "cloud"]);
  assert.equal(run.exitCode, 2);
  assert.equal(run.stdout, "");
  assert.deepEqual(parseError(run.stderr), {
    error: {
      code: "USAGE_ERROR",
      message:
        "`mcpjam cloud` needs a command. Run `mcpjam cloud --help` to list them.",
    },
  });
});

test("a nested group without a subcommand names the full command", async () => {
  const human = await runCli(["cloud", "projects", "--format", "human"]);
  assert.equal(human.exitCode, 2);
  assert.match(human.stderr, /^Usage: mcpjam cloud projects /);

  const json = await runCli(["cloud", "projects", "--format", "json"]);
  assert.equal(json.exitCode, 2);
  assert.equal(json.stdout, "");
  assert.match(
    parseError(json.stderr).error.message,
    /^`mcpjam cloud projects` needs a command\. Run `mcpjam cloud projects --help`/,
  );
});

test("asking for a group's help still succeeds on stdout", async () => {
  for (const argv of [
    ["cloud", "--help"],
    ["help", "cloud"],
  ]) {
    const run = await runCli(argv);
    assert.equal(run.exitCode, 0, `${argv.join(" ")}: ${run.stderr}`);
    assert.equal(run.stderr, "", argv.join(" "));
    assert.match(run.stdout, /^Usage: mcpjam cloud /, argv.join(" "));
  }
});

test("an unknown option keeps its usage error and shows no help", async () => {
  const expected = {
    error: { code: "USAGE_ERROR", message: "error: unknown option '--bogus'" },
  };

  const json = await runCli(["--format", "json", "cloud", "--bogus"]);
  assert.equal(json.exitCode, 2);
  assert.equal(json.stdout, "");
  assert.equal(json.stderr, `${JSON.stringify(expected)}\n`);

  const human = await runCli(["--format", "human", "cloud", "--bogus"]);
  assert.equal(human.exitCode, 2);
  assert.equal(human.stdout, "");
  assert.equal(human.stderr, `${JSON.stringify(expected, null, 2)}\n`);
});
