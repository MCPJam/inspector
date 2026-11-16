import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";
import { main } from "../src/index.js";
import {
  recordCommandOutcome,
  resetCommandOutcome,
  resolveCommandOutcome,
} from "../src/lib/command-outcome.js";
import { recordLocalTestOutcome } from "../src/lib/local-test-exit-code.js";
import { setProcessExitCode } from "../src/lib/output.js";
import { exitInterrupted, initTelemetry } from "../src/lib/telemetry.js";
import {
  captureProcessOutput,
  cleanTelemetryEnv,
  createRecordingClient,
  createStatePath,
  type CapturedEvent,
} from "./support/telemetry-harness.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";
// Nothing listens on port 1, so these runs fail fast and stay on the machine.
const DEAD_URL = "http://127.0.0.1:1/mcp";

async function runMain(
  argv: string[],
): Promise<{ exitCode: number; events: CapturedEvent[] }> {
  const statePath = await createStatePath();
  const recorder = createRecordingClient();
  const run = await captureProcessOutput(() =>
    main(["node", "mcpjam", ...argv], {
      telemetry: {
        statePath,
        env: cleanTelemetryEnv(),
        createId: () => UUID_A,
        createClient: recorder.createClient,
      },
    }),
  );
  return {
    exitCode: run.result.exitCode,
    events: recorder.events.filter((event) => event.event === "cli_command"),
  };
}

test("a failing result reported through setProcessExitCode is check_failed", async () => {
  const { exitCode, events } = await runMain([
    "--format",
    "json",
    "server",
    "probe",
    "--url",
    DEAD_URL,
  ]);

  assert.equal(exitCode, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].properties.command, "server probe");
  assert.equal(events[0].properties.outcome, "check_failed");
  assert.equal(events[0].properties.success, false);
  assert.equal("error_code" in events[0].properties, false);
});

test("a thrown error is error and keeps its error code", async () => {
  const { exitCode, events } = await runMain([
    "--format",
    "json",
    "tools",
    "list",
    "--url",
    DEAD_URL,
  ]);

  assert.equal(exitCode, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].properties.outcome, "error");
  assert.equal(events[0].properties.error_code, "NETWORK_ERROR");
});

test("parse errors are usage_error with the registered command path only", async () => {
  const secret = "https://secret.example/mcp";
  const cases: Array<[string[], string]> = [
    [["srver", "probe", "--url", secret], "(unknown)"],
    [["tools", "cal", "--url", secret], "tools"],
    [["server", "probe", "--bogus-flag"], "server probe"],
    [["--format", "json", "tools"], "tools"],
    // A required value is consumed even when it starts with "-", as commander does.
    [["--format", "--timeout", "server", "telemetry"], "server"],
    // The scan stops at the first operand commander rejects.
    [["not-a-command", "server"], "(unknown)"],
    [["tools", "cal", "server"], "tools"],
  ];

  for (const [argv, command] of cases) {
    const { exitCode, events } = await runMain(argv);
    const label = argv.join(" ");

    assert.equal(exitCode, 2, label);
    assert.equal(events.length, 1, label);
    assert.equal(events[0].properties.command, command, label);
    assert.equal(events[0].properties.outcome, "usage_error", label);
    assert.equal(events[0].properties.error_code, "USAGE_ERROR", label);
    const payload = JSON.stringify(events[0]);
    for (const token of ["srver", "cal", "bogus", "secret"]) {
      assert.doesNotMatch(payload, new RegExp(token), label);
    }
  }
});

test("an invalid option value thrown before the action runs is usage_error", async () => {
  for (const argv of [
    ["--timeout", "0", "server", "probe", "--url", DEAD_URL],
    ["server", "probe", "--timeout", "0", "--url", DEAD_URL],
    // An option's value that happens to name a command is not the command.
    ["--format", "telemetry", "--timeout", "0", "server", "probe", "--url", DEAD_URL],
  ]) {
    const { exitCode, events } = await runMain(argv);
    const label = argv.join(" ");

    assert.equal(exitCode, 2, label);
    assert.equal(events.length, 1, label);
    assert.equal(events[0].properties.command, "server probe", label);
    assert.equal(events[0].properties.outcome, "usage_error", label);
    assert.equal(events[0].properties.error_code, "USAGE_ERROR", label);
  }
});

test("parse errors honor --no-telemetry and skip telemetry commands", async () => {
  for (const argv of [
    ["--no-telemetry", "srver"],
    ["srver", "--no-telemetry"],
    ["telemetry", "bogus"],
  ]) {
    const { events } = await runMain(argv);
    assert.equal(events.length, 0, argv.join(" "));
  }
});

test("a usage error a command caught and printed itself stays usage_error", () => {
  const savedExitCode = process.exitCode;
  try {
    resetCommandOutcome();
    setProcessExitCode(2);
    recordCommandOutcome("error", "USAGE_ERROR");
    assert.deepEqual(resolveCommandOutcome(2), {
      outcome: "usage_error",
      errorCode: "USAGE_ERROR",
    });
  } finally {
    resetCommandOutcome();
    process.exitCode = savedExitCode;
  }
});

test("mcpjam test counts only a failed verdict as check_failed", () => {
  const savedExitCode = process.exitCode;
  const outcomeFor = (exitCode: number) => {
    resetCommandOutcome();
    setProcessExitCode(exitCode);
    recordLocalTestOutcome(exitCode);
    return resolveCommandOutcome(exitCode);
  };
  try {
    assert.deepEqual(outcomeFor(0), { outcome: "ok" });
    assert.deepEqual(outcomeFor(1), { outcome: "check_failed" });
    assert.deepEqual(outcomeFor(3), { outcome: "error", errorCode: "AUTH_FAILED" });
    assert.deepEqual(outcomeFor(4), { outcome: "error", errorCode: "UNKNOWN_ERROR" });
    assert.deepEqual(outcomeFor(5), { outcome: "error", errorCode: "UNKNOWN_ERROR" });

    resetCommandOutcome();
    recordCommandOutcome("interrupted");
    setProcessExitCode(4);
    recordLocalTestOutcome(4);
    assert.deepEqual(resolveCommandOutcome(4), { outcome: "interrupted" });
  } finally {
    resetCommandOutcome();
    process.exitCode = savedExitCode;
  }
});

test("interrupted wins over any outcome reported after the signal", () => {
  try {
    resetCommandOutcome();
    recordCommandOutcome("check_failed");
    assert.deepEqual(resolveCommandOutcome(1), { outcome: "check_failed" });

    recordCommandOutcome("interrupted");
    recordCommandOutcome("check_failed");
    recordCommandOutcome("error", "TIMEOUT");
    assert.deepEqual(resolveCommandOutcome(0), { outcome: "interrupted" });
    assert.deepEqual(resolveCommandOutcome(1, "TUNNEL_CLOSED"), {
      outcome: "interrupted",
    });

    resetCommandOutcome();
    recordCommandOutcome("check_failed");
    recordCommandOutcome("error", "TIMEOUT");
    assert.deepEqual(resolveCommandOutcome(4), {
      outcome: "error",
      errorCode: "TIMEOUT",
    });

    resetCommandOutcome();
    assert.deepEqual(resolveCommandOutcome(1), {
      outcome: "error",
      errorCode: "UNKNOWN_ERROR",
    });
  } finally {
    resetCommandOutcome();
  }
});

test("a forced quit sends one interrupted event with exit code 130, then exits", async () => {
  const statePath = await createStatePath();
  const recorder = createRecordingClient();
  const program = new Command().name("mcpjam").exitOverride();
  initTelemetry(program, "0.0.0-test", {
    statePath,
    env: cleanTelemetryEnv(),
    createId: () => UUID_A,
    createClient: recorder.createClient,
  });
  const exits: number[] = [];
  program.command("tunnel").action(async () => {
    // The second Ctrl+C, then a third while the first exit is flushing.
    await exitInterrupted((code) => exits.push(code));
    await exitInterrupted((code) => exits.push(code));
  });

  try {
    await program.parseAsync(["node", "mcpjam", "tunnel"]);
  } finally {
    resetCommandOutcome();
  }

  assert.deepEqual(exits, [130, 130]);
  assert.equal(recorder.events.length, 1);
  assert.equal(recorder.events[0].properties.command, "tunnel");
  assert.equal(recorder.events[0].properties.outcome, "interrupted");
  assert.equal(recorder.events[0].properties.exit_code, 130);
  assert.equal("error_code" in recorder.events[0].properties, false);
  assert.equal(recorder.flushes(), 1);
});
