import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import {
  OAuthConformanceTest,
  RENAMED_MCP_TASKS_CHECK_IDS,
  RETIRED_MCP_CHECK_IDS,
} from "@mcpjam/sdk";
import { Command } from "commander";
import {
  buildConformanceRunInput,
  buildOAuthConfig,
  normalizeConformanceRunSuites,
  registerConformanceRunCommand,
  serverTargetOptions,
  type CompositeConformanceOptions,
  type ConformanceRunInput,
} from "../src/commands/conformance-run.js";
import {
  buildConfig,
  registerProtocolCommands,
  type ProtocolConformanceOptions,
} from "../src/commands/conformance.js";
import {
  buildTasksConformanceConfig,
  registerTasksCommands,
  type TasksConformanceOptions,
} from "../src/commands/tasks.js";
import { CliError } from "../src/lib/output.js";
import { parseServerConfig } from "../src/lib/server-config.js";
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

test("conformance run --suite oauth runs the OAuth negative checks", () => {
  const config = buildOAuthConfig(
    { url: "https://example.com/mcp" },
    {
      oauthStrategy: "client_credentials",
      clientId: "client",
      clientSecret: "secret",
    },
  );

  assert.equal(config.oauthConformanceChecks, true);
  assert.equal(config.allowPrivateNetwork, true);
  // The SDK validates in the constructor: a config it rejects never reaches
  // a single check, and the run reports no OAuth result at all.
  assert.doesNotThrow(() => new OAuthConformanceTest(config));
});

test("conformance run --suite oauth keeps the client_credentials client out of the server config", () => {
  const options = {
    url: "https://example.com/mcp",
    oauthStrategy: "client_credentials",
    clientId: "client",
    clientSecret: "secret",
  };

  assert.doesNotThrow(() =>
    parseServerConfig(serverTargetOptions(options, ["oauth"])),
  );
  // Without the OAuth suite they are still a refresh-token login, and
  // `--refresh-token` is still required.
  assert.throws(
    () => parseServerConfig(serverTargetOptions(options, ["protocol"])),
    (error) =>
      error instanceof CliError && error.message.includes("--refresh-token"),
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

const TARGET = "https://example.com/mcp";

/** Parse `path` (e.g. `tasks conformance`) without running its action. */
function parseCommand(
  register: (program: Command) => void,
  path: string[],
  argv: string[],
): { options: Record<string, unknown>; command: Command } {
  const program = new Command();
  program.exitOverride();
  register(program);
  let leaf: Command | undefined = program;
  for (const name of path) {
    leaf = leaf?.commands.find((c) => c.name() === name);
  }
  assert.ok(leaf);
  let captured: { options: Record<string, unknown>; command: Command } | undefined;
  leaf.action((options: Record<string, unknown>, command: Command) => {
    captured = { options, command };
  });
  program.parse([...path, ...argv], { from: "user" });
  assert.ok(captured);
  return captured;
}

/** What `conformance run` hands `runConformance` for these flags. */
function runInput(argv: string[]): ConformanceRunInput {
  const { options, command } = parseCommand(
    registerConformanceRunCommand,
    ["conformance", "run"],
    ["--url", TARGET, ...argv],
  );
  const runOptions = options as CompositeConformanceOptions;
  const suites = normalizeConformanceRunSuites(runOptions.suite);
  return buildConformanceRunInput(
    parseServerConfig(serverTargetOptions(runOptions, suites)),
    suites,
    runOptions,
    command,
  );
}

function isUsageError(message: string) {
  return (error: unknown) =>
    error instanceof CliError &&
    error.exitCode === 2 &&
    error.message.includes(message);
}

test("conformance run sends each --check-id and --advice-id to the suite that owns it", () => {
  const input = runInput([
    ...["--suite", "protocol", "--suite", "apps"],
    ...["--suite", "tasks", "--suite", "oauth"],
    ...["--check-id", "ping", "--check-id", "ui-tools-present"],
    ...["--check-id", "tasks-ttl-shape"],
    ...["--advice-id", "readiness-session-termination"],
    ...["--advice-id", "tasks-readiness-failed-status-message"],
    ...["--advice-id", "readiness-oauth-iss-advertised"],
  ]);

  assert.deepEqual(input.protocol?.checkIds, ["ping"]);
  assert.deepEqual(input.protocol?.readinessIds, [
    "readiness-session-termination",
  ]);
  assert.deepEqual(input.apps, { checkIds: ["ui-tools-present"] });
  assert.deepEqual(input.tasks?.checkIds, ["tasks-ttl-shape"]);
  assert.deepEqual(input.tasks?.readinessIds, [
    "tasks-readiness-failed-status-message",
  ]);
  assert.deepEqual(input.oauthReadinessIds, ["readiness-oauth-iss-advertised"]);
});

test("conformance run runs every check of a suite no --check-id names", () => {
  const input = runInput(["--check-id", "ping"]);

  assert.deepEqual(input.protocol?.checkIds, ["ping"]);
  assert.equal(input.apps, undefined);
  assert.equal(input.tasks?.checkIds, undefined);
  assert.equal(input.tasks?.readinessIds, undefined);
});

test("conformance run sends retired and renamed ids to their suite", () => {
  const [retired] = Object.keys(RETIRED_MCP_CHECK_IDS);
  const [renamed] = Object.entries(RENAMED_MCP_TASKS_CHECK_IDS);
  assert.ok(retired && renamed);

  const input = runInput(["--check-id", retired, "--check-id", renamed[0]]);

  assert.deepEqual(input.protocol?.checkIds, [retired]);
  assert.deepEqual(input.tasks?.checkIds, [renamed[1]]);
});

test("conformance run rejects an unknown or blank id", () => {
  assert.throws(
    () => runInput(["--check-id", "not-a-check"]),
    isUsageError("Unknown check id: not-a-check"),
  );
  assert.throws(
    () => runInput(["--advice-id", "not-advice"]),
    isUsageError("Unknown advice id: not-advice. Valid advice ids:"),
  );
  assert.throws(
    () => runInput(["--advice-id", " "]),
    isUsageError("--advice-id needs an advice id."),
  );
});

test("conformance run rejects an id or flag for a suite it leaves out", () => {
  const cases: Array<[string[], string]> = [
    [
      ["--suite", "protocol", "--check-id", "tasks-ttl-shape"],
      "--check-id tasks-ttl-shape is for the tasks suite",
    ],
    [
      ["--advice-id", "readiness-oauth-iss-advertised"],
      "is for the oauth suite, which this run leaves out. Add it with --suite oauth.",
    ],
    [
      ["--suite", "apps", "--fixture-tool", "echo"],
      "--fixture-tool is for the protocol suite",
    ],
    [
      ["--suite", "apps", "--check-timeout", "5000"],
      "--check-timeout is for the protocol suite",
    ],
    [
      ["--suite", "protocol", "--tool-name", "slow_job", "--poll-timeout", "1000"],
      "--tool-name, --poll-timeout are for the tasks suite",
    ],
  ];
  for (const [argv, message] of cases) {
    assert.throws(() => runInput(argv), isUsageError(message), argv.join(" "));
  }

  // A default is not a typed flag: --poll-timeout and --fixture-tool have one.
  assert.doesNotThrow(() => runInput(["--suite", "apps"]));
});

test("conformance run gives the protocol suite the same tools as protocol conformance", () => {
  const flags = [
    ...["--check-timeout", "5000", "--fixture-tool", "echo"],
    ...["--log-probe-tool", "write_log"],
    ...["--log-filter-tool", "filter_log", "--log-filter-level", "error"],
    ...["--input-required-tool", "ask_name"],
    ...["--input-required-args", '{"field":"name"}'],
  ];
  const { options } = parseCommand(
    registerProtocolCommands,
    ["protocol", "conformance"],
    ["--url", TARGET, ...flags],
  );
  const expected: Record<string, unknown> = {
    ...buildConfig(options as unknown as ProtocolConformanceOptions),
  };
  delete expected.serverUrl;
  delete expected.accessToken;
  delete expected.customHeaders;

  assert.deepEqual(runInput(flags).protocol, expected);
});

test("conformance run gives the tasks suite the same tools as tasks conformance", () => {
  const flags = [
    ...["--tool-name", "slow_job", "--tool-args", '{"seconds":1}'],
    "--check-overrides",
    '{"tasks-cancel-ack-shape":{"toolName":"cancel_me","toolArguments":{"seconds":5}}}',
    "--input-responses",
    '{"name":{"result":{"action":"accept","content":{"name":"Ada"}}}}',
    ...["--poll-timeout", "1000"],
  ];
  const { options } = parseCommand(
    registerTasksCommands,
    ["tasks", "conformance"],
    ["--url", TARGET, ...flags],
  );

  assert.deepEqual(
    runInput(flags).tasks,
    buildTasksConformanceConfig(options as TasksConformanceOptions),
  );
});

test("conformance run pins --protocol-version for the whole run", () => {
  const input = runInput(["--protocol-version", "2026-07-28"]);

  assert.equal(input.protocolVersion, "2026-07-28");
  // `runConformance` applies the run's pin to every suite itself.
  assert.equal(input.protocol?.protocolVersion, undefined);
  assert.equal(
    (input.tasks as Record<string, unknown> | undefined)?.mcpProtocolVersion,
    undefined,
  );
  assert.throws(
    () => runInput(["--protocol-version", "1999-01-01"]),
    isUsageError("Unknown protocol version: 1999-01-01"),
  );
});

test("conformance run without the new flags sends what it sent before", () => {
  const input = runInput([]);

  assert.equal(input.protocolVersion, undefined);
  // Nothing for the protocol suite, so it keeps the SDK's check timeout.
  assert.deepEqual(input.protocol, {});
  assert.equal(input.apps, undefined);
  assert.equal(input.oauthReadinessIds, undefined);
  // The target again, plus a poll timeout equal to the SDK's own default.
  const { options } = parseCommand(
    registerTasksCommands,
    ["tasks", "conformance"],
    ["--url", TARGET],
  );
  assert.deepEqual(input.tasks, {
    ...parseServerConfig(options as TasksConformanceOptions),
    pollTimeoutMs: 30_000,
  });
});
