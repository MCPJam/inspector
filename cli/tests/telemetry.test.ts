import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { main } from "../src/index.js";
import {
  getTelemetryStatus,
  readTelemetryState,
  setTelemetryEnabled,
  type TelemetryClient,
  type TelemetryOptions,
} from "../src/lib/telemetry.js";

const require = createRequire(import.meta.url);
const CLI_VERSION: string = require("../package.json").version;

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

type CapturedEvent = Parameters<TelemetryClient["capture"]>[0];

async function createStatePath(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-telemetry-"));
  return path.join(directory, "telemetry.json");
}

function cleanTelemetryEnv(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "DO_NOT_TRACK",
    "MCPJAM_TELEMETRY_DISABLED",
    "MCPJAM_TELEMETRY_DEBUG",
    "CI",
    "GITHUB_ACTIONS",
    "GITLAB_CI",
    "CIRCLECI",
    "BUILDKITE",
    "JENKINS_URL",
    "JENKINS_HOME",
    "VERCEL",
    "NETLIFY",
  ]) {
    delete env[key];
  }
  return { ...env, ...overrides };
}

function createRecordingClient(): {
  events: CapturedEvent[];
  createClient: () => TelemetryClient;
  flushes: () => number;
} {
  const events: CapturedEvent[] = [];
  let flushCount = 0;

  return {
    events,
    createClient: () => ({
      capture(event) {
        events.push(event);
      },
      async flush() {
        flushCount += 1;
      },
    }),
    flushes: () => flushCount,
  };
}

async function captureProcessOutput<T>(
  fn: () => Promise<T>,
): Promise<{
  result: T;
  stdout: string;
  stderr: string;
}> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const originalExitCode = process.exitCode;
  let stdout = "";
  let stderr = "";

  process.exitCode = undefined;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  try {
    const result = await fn();
    return {
      result,
      stdout,
      stderr,
    };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    process.exitCode = originalExitCode;
  }
}

test("telemetry state creates, reuses, disables, enables, and replaces invalid state", async () => {
  const statePath = await createStatePath();
  const env = cleanTelemetryEnv();

  assert.deepEqual(getTelemetryStatus({ statePath, env }), {
    enabled: true,
    installId: null,
    installIdCreated: false,
    stateFile: statePath,
    debugMode: false,
    disableReason: null,
  });

  const disabled = setTelemetryEnabled(false, {
    statePath,
    env,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.installId, undefined);

  const enabled = setTelemetryEnabled(true, {
    statePath,
    env,
    createId: () => UUID_A,
    now: () => new Date("2026-01-01T00:00:01.000Z"),
  });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.installId, UUID_A);

  const disabledAgain = setTelemetryEnabled(false, {
    statePath,
    env,
    createId: () => UUID_B,
  });
  assert.equal(disabledAgain.installId, UUID_A);

  await writeFile(
    statePath,
    '{"version":1,"enabled":true,"installId":"not-a-uuid","createdAt":"x","updatedAt":"x"}\n',
    "utf8",
  );
  const replaced = setTelemetryEnabled(true, {
    statePath,
    env,
    createId: () => UUID_B,
  });
  assert.equal(replaced.installId, UUID_B);
});

test("telemetry opt-outs prevent client creation and state creation", async () => {
  for (const scenario of [
    {
      name: "flag",
      argv: ["node", "mcpjam", "--no-telemetry", "server", "probe", "--url", "not-a-url"],
      env: cleanTelemetryEnv(),
    },
    {
      name: "DO_NOT_TRACK",
      argv: ["node", "mcpjam", "server", "probe", "--url", "not-a-url"],
      env: cleanTelemetryEnv({ DO_NOT_TRACK: "1" }),
    },
    {
      name: "MCPJAM_TELEMETRY_DISABLED",
      argv: ["node", "mcpjam", "server", "probe", "--url", "not-a-url"],
      env: cleanTelemetryEnv({ MCPJAM_TELEMETRY_DISABLED: "1" }),
    },
  ]) {
    const statePath = await createStatePath();
    let clientCreated = false;

    const run = await captureProcessOutput(() =>
      main(scenario.argv, {
        telemetry: {
          statePath,
          env: scenario.env,
          createClient() {
            clientCreated = true;
            throw new Error(`client created for ${scenario.name}`);
          },
        },
      }),
    );

    assert.equal(run.result.exitCode, 2);
    assert.equal(clientCreated, false);
    assert.equal(readTelemetryState({ statePath, env: scenario.env }), null);
  }
});

test("persisted disabled state prevents telemetry until re-enabled", async () => {
  const statePath = await createStatePath();
  const env = cleanTelemetryEnv();
  setTelemetryEnabled(false, { statePath, env });

  const recorder = createRecordingClient();
  const run = await captureProcessOutput(() =>
    main(["node", "mcpjam", "server", "probe", "--url", "not-a-url"], {
      telemetry: {
        statePath,
        env,
        createClient: recorder.createClient,
      },
    }),
  );

  assert.equal(run.result.exitCode, 2);
  assert.equal(recorder.events.length, 0);
  assert.equal(readTelemetryState({ statePath, env })?.installId, undefined);
});

test("debug mode logs sanitized payloads and does not send", async () => {
  const statePath = await createStatePath();
  const env = cleanTelemetryEnv({ MCPJAM_TELEMETRY_DEBUG: "1" });
  let clientCreated = false;

  const run = await captureProcessOutput(() =>
    main(["node", "mcpjam", "server", "probe", "--url", "not-a-url"], {
      telemetry: {
        statePath,
        env,
        createId: () => UUID_A,
        createClient() {
          clientCreated = true;
          throw new Error("debug mode should not send");
        },
      },
    }),
  );

  assert.equal(run.result.exitCode, 2);
  assert.equal(clientCreated, false);
  assert.match(run.stderr, /MCPJam telemetry debug:/);
  assert.match(run.stderr, /"event":"cli_command"/);
  assert.match(run.stderr, /"distinct_id":"11111111-1111-4111-8111-111111111111"/);
});

test("telemetry status, disable, and enable support human and JSON output", async () => {
  const statePath = await createStatePath();
  const env = cleanTelemetryEnv();
  const telemetry: TelemetryOptions = {
    statePath,
    env,
    createId: () => UUID_A,
  };

  const initialStatus = await captureProcessOutput(() =>
    main(["node", "mcpjam", "--format", "human", "telemetry", "status"], {
      telemetry,
    }),
  );
  assert.equal(initialStatus.result.exitCode, 0);
  assert.match(initialStatus.stdout, /Telemetry: enabled/);
  assert.match(initialStatus.stdout, /Install ID: not created yet/);
  assert.equal(readTelemetryState({ statePath, env }), null);

  const disabled = await captureProcessOutput(() =>
    main(["node", "mcpjam", "--format", "json", "telemetry", "disable"], {
      telemetry,
    }),
  );
  const disabledPayload = JSON.parse(disabled.stdout) as {
    telemetry: { enabled: boolean; installId: string | null; disableReason: string };
  };
  assert.equal(disabled.result.exitCode, 0);
  assert.equal(disabledPayload.telemetry.enabled, false);
  assert.equal(disabledPayload.telemetry.installId, null);
  assert.equal(disabledPayload.telemetry.disableReason, "state");

  const enabled = await captureProcessOutput(() =>
    main(["node", "mcpjam", "--format", "json", "telemetry", "enable"], {
      telemetry,
    }),
  );
  const enabledPayload = JSON.parse(enabled.stdout) as {
    telemetry: { enabled: boolean; installId: string | null; disableReason: string | null };
  };
  assert.equal(enabled.result.exitCode, 0);
  assert.equal(enabledPayload.telemetry.enabled, true);
  assert.equal(enabledPayload.telemetry.installId, UUID_A);
  assert.equal(enabledPayload.telemetry.disableReason, null);
});

test("successful command emits one allowlisted CLI event with CI tags", async () => {
  const statePath = await createStatePath();
  const recorder = createRecordingClient();

  const run = await captureProcessOutput(() =>
    main(
      [
        "node",
        "mcpjam",
        "--format",
        "json",
        "inspector",
        "stop",
        "--inspector-url",
        "http://127.0.0.1:1",
      ],
      {
        telemetry: {
          statePath,
          env: cleanTelemetryEnv({
            CI: "true",
            GITHUB_ACTIONS: "true",
            GITHUB_WORKFLOW: "sensitive-workflow",
          }),
          createId: () => UUID_A,
          createClient: recorder.createClient,
        },
      },
    ),
  );

  assert.equal(run.result.exitCode, 0, run.stderr);
  assert.equal(recorder.events.length, 1);
  assert.equal(recorder.flushes(), 1);

  const event = recorder.events[0];
  assert.equal(event.distinctId, UUID_A);
  assert.equal(event.event, "cli_command");
  assert.deepEqual(event.properties, {
    platform: "cli",
    command: "inspector stop",
    success: true,
    exit_code: 0,
    duration_ms: event.properties.duration_ms,
    cli_version: CLI_VERSION,
    os: process.platform,
    arch: process.arch,
    node_version: process.version,
    is_ci: true,
    ci_name: "github_actions",
  });
  assert.equal(typeof event.properties.duration_ms, "number");
  assert.doesNotMatch(JSON.stringify(event), /sensitive-workflow/);
});

test("telemetry flush waits for async client captures", async () => {
  const statePath = await createStatePath();
  const events: CapturedEvent[] = [];
  let flushCount = 0;
  let flushTimeoutMs: number | undefined;

  const run = await captureProcessOutput(() =>
    main(
      [
        "node",
        "mcpjam",
        "--format",
        "json",
        "inspector",
        "stop",
        "--inspector-url",
        "http://127.0.0.1:1",
      ],
      {
        telemetry: {
          statePath,
          env: cleanTelemetryEnv(),
          createId: () => UUID_A,
          createClient: () => ({
            capture(event) {
              return new Promise<void>((resolve) => {
                setTimeout(() => {
                  events.push(event);
                  resolve();
                }, 25);
              });
            },
            async flush(timeoutMs) {
              flushCount += 1;
              flushTimeoutMs = timeoutMs;
            },
          }),
        },
      },
    ),
  );

  assert.equal(run.result.exitCode, 0, run.stderr);
  assert.equal(events.length, 1);
  assert.equal(flushCount, 1);
  assert.equal(flushTimeoutMs, 3_000);
});

test("non-CI command omits ci_name", async () => {
  const statePath = await createStatePath();
  const recorder = createRecordingClient();

  const run = await captureProcessOutput(() =>
    main(["node", "mcpjam", "server", "probe", "--url", "not-a-url"], {
      telemetry: {
        statePath,
        env: cleanTelemetryEnv(),
        createId: () => UUID_A,
        createClient: recorder.createClient,
      },
    }),
  );

  assert.equal(run.result.exitCode, 2);
  assert.equal(recorder.events.length, 1);
  assert.equal(recorder.events[0].properties.is_ci, false);
  assert.equal("ci_name" in recorder.events[0].properties, false);
});

test("action-level failures emit sanitized errors without sensitive argv values", async () => {
  const statePath = await createStatePath();
  const recorder = createRecordingClient();
  const sensitiveValues = [
    "https://secret.example/mcp",
    "secret-token",
    "Authorization: Bearer secret-header",
    "/tmp/secret-debug.json",
  ];

  const run = await captureProcessOutput(() =>
    main(
      [
        "node",
        "mcpjam",
        "--format",
        "json",
        "server",
        "probe",
        "--url",
        sensitiveValues[0],
        "--access-token",
        sensitiveValues[1],
        "--header",
        sensitiveValues[2],
        "--debug-out",
        sensitiveValues[3],
        "--protocol-version",
        "bad-version",
      ],
      {
        telemetry: {
          statePath,
          env: cleanTelemetryEnv(),
          createId: () => UUID_A,
          createClient: recorder.createClient,
        },
      },
    ),
  );

  assert.equal(run.result.exitCode, 2);
  assert.equal(recorder.events.length, 1);
  const eventText = JSON.stringify(recorder.events[0]);
  assert.equal(recorder.events[0].properties.error_code, "USAGE_ERROR");
  for (const sensitiveValue of sensitiveValues) {
    assert.doesNotMatch(eventText, new RegExp(escapeRegExp(sensitiveValue)));
  }
});

test("help, version, unknown commands, and telemetry commands emit no telemetry", async () => {
  for (const argv of [
    ["node", "mcpjam"],
    ["node", "mcpjam", "--help"],
    ["node", "mcpjam", "--version"],
    ["node", "mcpjam", "not-a-command"],
    ["node", "mcpjam", "telemetry", "status"],
    ["node", "mcpjam", "telemetry", "disable"],
    ["node", "mcpjam", "telemetry", "enable"],
  ]) {
    const statePath = await createStatePath();
    const recorder = createRecordingClient();
    const run = await captureProcessOutput(() =>
      main(argv, {
        telemetry: {
          statePath,
          env: cleanTelemetryEnv(),
          createId: () => UUID_A,
          createClient: recorder.createClient,
        },
      }),
    );

    assert.equal(recorder.events.length, 0, `${argv.join(" ")} emitted telemetry`);
    assert.ok([0, 2].includes(run.result.exitCode));
  }
});

test("capture falls back to a per-run UUID when the telemetry file cannot be written", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-telemetry-"));
  const parentFile = path.join(directory, "not-a-directory");
  await writeFile(parentFile, "x", "utf8");
  const recorder = createRecordingClient();

  const run = await captureProcessOutput(() =>
    main(["node", "mcpjam", "server", "probe", "--url", "not-a-url"], {
      telemetry: {
        statePath: path.join(parentFile, "telemetry.json"),
        env: cleanTelemetryEnv(),
        createId: () => UUID_A,
        createClient: recorder.createClient,
      },
    }),
  );

  assert.equal(run.result.exitCode, 2);
  assert.equal(recorder.events.length, 1);
  assert.equal(recorder.events[0].distinctId, UUID_A);
  await assert.rejects(readFile(path.join(parentFile, "telemetry.json"), "utf8"));
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
