import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";
import {
  normalizeConformanceRunSuites,
  registerConformanceRunCommand,
} from "../src/commands/conformance-run.js";
import { CliError } from "../src/lib/output.js";

function parseConformanceRun(argv: string[]): Record<string, unknown> {
  const program = new Command();
  program.exitOverride();
  registerConformanceRunCommand(program);
  const conformance = program.commands.find((c) => c.name() === "conformance");
  assert.ok(conformance);
  const run = conformance.commands.find((c) => c.name() === "run");
  assert.ok(run);
  let captured: Record<string, unknown> | undefined;
  run.action((options) => {
    captured = options as Record<string, unknown>;
  });
  program.parse(["conformance", "run", ...argv], {
    from: "user",
  });
  assert.ok(captured);
  return captured;
}

test("conformance run defaults suites to protocol, apps, tasks", () => {
  assert.deepEqual(normalizeConformanceRunSuites(undefined), [
    "protocol",
    "apps",
    "tasks",
  ]);
  assert.deepEqual(normalizeConformanceRunSuites([]), [
    "protocol",
    "apps",
    "tasks",
  ]);
  const options = parseConformanceRun(["--url", "https://example.com/mcp"]);
  assert.deepEqual(options.suite, []);
});

test("conformance run accepts repeatable --suite", () => {
  const options = parseConformanceRun([
    "--url",
    "https://example.com/mcp",
    "--suite",
    "protocol",
    "--suite",
    "oauth",
  ]);
  assert.deepEqual(options.suite, ["protocol", "oauth"]);
  assert.deepEqual(normalizeConformanceRunSuites(["protocol", "oauth"]), [
    "protocol",
    "oauth",
  ]);
});

test("conformance run rejects an unknown suite", () => {
  assert.throws(
    () => normalizeConformanceRunSuites(["directory"]),
    (error) =>
      error instanceof CliError && error.message.includes("Unknown suite"),
  );
});
