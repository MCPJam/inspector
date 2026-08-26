import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { Command } from "commander";
import {
  normalizeConformanceRunSuites,
  registerConformanceRunCommand,
} from "../src/commands/conformance-run.js";
import { CliError } from "../src/lib/output.js";
import { main } from "../src/index.js";

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

// `--reporter html` is invalid for `conformance run` regardless of what the
// suite would find — so it must be rejected before the suite runs, not
// after. A version of this check placed after `runConformance` would let an
// option the command ultimately refuses still issue real requests first.
test("conformance run rejects --reporter html before making any request", async () => {
  let requestCount = 0;
  const server: Server = createServer((_req, res) => {
    requestCount += 1;
    res.statusCode = 404;
    res.end("not used");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture server has no address");
  }

  const originalWrite = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  try {
    const result = await main(
      [
        "node",
        "mcpjam",
        "conformance",
        "run",
        "--url",
        `http://127.0.0.1:${address.port}/mcp`,
        "--reporter",
        "html",
      ],
      { telemetry: { env: { ...process.env, MCPJAM_TELEMETRY_DISABLED: "1" } } },
    );

    assert.equal(result.exitCode, 2);
    assert.match(stderr, /html\\?" reporter is not available/);
    assert.equal(requestCount, 0);
  } finally {
    process.stderr.write = originalWrite;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
