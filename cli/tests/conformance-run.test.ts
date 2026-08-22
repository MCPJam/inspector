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

test("a single-suite command does not publish just because a key is exported", async () => {
  // These commands were local-only before conformance history existed, and an
  // exported MCPJAM_API_KEY is not a decision to publish a staging result into
  // a project's shared history. Only an explicit flag is.
  const { maybeUploadSingleSuite } = await import(
    "../src/lib/conformance-upload.js"
  );
  const originalKey = process.env.MCPJAM_API_KEY;
  const originalFetch = globalThis.fetch;
  let called = false;
  process.env.MCPJAM_API_KEY = "sk_test";
  globalThis.fetch = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;
  try {
    await maybeUploadSingleSuite({
      suiteKind: "protocol",
      result: { passed: true, outcome: "passed", checks: [] },
      serverUrl: "https://mcp.example/mcp",
      command: new Command(),
    });
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.MCPJAM_API_KEY;
    else process.env.MCPJAM_API_KEY = originalKey;
  }
});
