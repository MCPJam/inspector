import assert from "node:assert/strict";
import test from "node:test";
import { MCP_TASKS_CHECK_IDS } from "@mcpjam/sdk";
import { Command } from "commander";
import {
  buildTasksConformanceConfig,
  registerTasksCommands,
  tasksConformanceExitCode,
} from "../src/commands/tasks.js";
import { CliError } from "../src/lib/output.js";

test("buildTasksConformanceConfig rejects unknown categories and check ids", () => {
  assert.throws(
    () =>
      buildTasksConformanceConfig({
        url: "https://example.com/mcp",
        category: ["dispatch", "bogus"],
      }),
    (error) =>
      error instanceof CliError && error.message.includes("Unknown category")
  );

  assert.throws(
    () =>
      buildTasksConformanceConfig({
        url: "https://example.com/mcp",
        checkId: ["tasks-inline-result", "bogus"],
      }),
    (error) =>
      error instanceof CliError && error.message.includes("Unknown check id")
  );
});

test("buildTasksConformanceConfig runs a renamed check id under its current name", () => {
  const config = buildTasksConformanceConfig({
    url: "https://example.com/mcp",
    checkId: ["tasks-input-required-update-completes"],
  });
  assert.deepEqual(config.checkIds, ["tasks-update-ack-shape"]);
});

test("buildTasksConformanceConfig expands categories into check ids", () => {
  const config = buildTasksConformanceConfig({
    url: "https://example.com/mcp",
    category: ["dispatch"],
  });

  assert.deepEqual(config.checkIds, [
    "tasks-wire-resolvable",
    "tasks-declaration-hygiene",
  ]);
});

test("buildTasksConformanceConfig maps the undeclared-capability checks to their categories", () => {
  const creation = buildTasksConformanceConfig({
    url: "https://example.com/mcp",
    category: ["creation"],
  });
  assert.deepEqual(creation.checkIds, [
    "tasks-result-type-discipline",
    "tasks-undeclared-creation-refused",
  ]);

  const lifecycle = buildTasksConformanceConfig({
    url: "https://example.com/mcp",
    category: ["lifecycle"],
  });
  assert.deepEqual(lifecycle.checkIds, [
    "tasks-ttl-shape",
    "tasks-inline-result",
    "tasks-mcp-name-routing",
    "tasks-undeclared-capability-rejected",
    "tasks-invalid-task-id-rejected",
    "tasks-status-payload-shape",
    "tasks-cancel-ack-shape",
    "tasks-update-ack-shape",
    "tasks-ttl-integer-shape",
    "tasks-undeclared-capability-names-requirements",
  ]);
});

test("every tasks check id is reachable through some category", () => {
  const config = buildTasksConformanceConfig({
    url: "https://example.com/mcp",
    category: ["dispatch", "creation", "lifecycle"],
  });

  assert.deepEqual(
    [...(config.checkIds ?? [])].sort(),
    [...MCP_TASKS_CHECK_IDS].sort()
  );
});

test("buildTasksConformanceConfig lets explicit check ids override categories", () => {
  const config = buildTasksConformanceConfig({
    url: "https://example.com/mcp",
    category: ["lifecycle"],
    checkId: ["tasks-inline-result"],
  });

  assert.deepEqual(config.checkIds, ["tasks-inline-result"]);
});

test("buildTasksConformanceConfig passes advice ids through as readinessIds", () => {
  const all = buildTasksConformanceConfig({ url: "https://example.com/mcp" });
  assert.equal("readinessIds" in all, false);

  const config = buildTasksConformanceConfig({
    url: "https://example.com/mcp",
    adviceId: ["tasks-readiness-failed-status-message"],
  });
  assert.deepEqual(config.readinessIds, [
    "tasks-readiness-failed-status-message",
  ]);
});

test("tasks conformance threads repeated --advice-id into readinessIds", async () => {
  const program = new Command();
  program.exitOverride();
  registerTasksCommands(program);
  const conformance = program.commands
    .find((c) => c.name() === "tasks")
    ?.commands.find((c) => c.name() === "conformance");
  assert.ok(conformance, "tasks conformance should be registered");
  let captured: ReturnType<typeof buildTasksConformanceConfig> | undefined;
  // Replace the network-running action so only option parsing is exercised.
  conformance.action((options) => {
    captured = buildTasksConformanceConfig(options);
  });

  await program.parseAsync(
    [
      "tasks",
      "conformance",
      "--url",
      "https://example.com/mcp",
      "--advice-id",
      "tasks-readiness-failed-status-message",
      "--advice-id",
      "tasks-readiness-unknown-task-id-mutations",
    ],
    { from: "user" }
  );

  assert.deepEqual(captured?.readinessIds, [
    "tasks-readiness-failed-status-message",
    "tasks-readiness-unknown-task-id-mutations",
  ]);
});

test("buildTasksConformanceConfig rejects unknown advice ids, and another suite's", () => {
  for (const adviceId of [["bogus"], ["readiness-log-level-filtering"], [""]]) {
    assert.throws(
      () =>
        buildTasksConformanceConfig({
          url: "https://example.com/mcp",
          adviceId,
        }),
      (error) =>
        error instanceof CliError && error.message.includes("advice id")
    );
  }
});

test("tasksConformanceExitCode separates a violation from a run that established nothing", () => {
  assert.equal(tasksConformanceExitCode({ passed: true, outcome: "passed" }), 0);
  assert.equal(tasksConformanceExitCode({ passed: false, outcome: "failed" }), 1);
  // An incomplete run is NOT a pass and NOT a spec violation: its own code, and
  // never 2 (reserved for usage errors).
  assert.equal(
    tasksConformanceExitCode({ passed: false, outcome: "incomplete" }),
    3,
  );
});

test("tasksConformanceExitCode falls back to passed for a result with no outcome", () => {
  assert.equal(tasksConformanceExitCode({ passed: true }), 0);
  assert.equal(tasksConformanceExitCode({ passed: false }), 1);
});

test("buildTasksConformanceConfig forwards the tool probe options", () => {
  const config = buildTasksConformanceConfig({
    url: "https://example.com/mcp",
    toolName: "long_job",
    toolArgs: '{"seconds":1}',
    pollTimeout: 5_000,
  });

  assert.equal(config.toolName, "long_job");
  assert.deepEqual(config.toolArguments, { seconds: 1 });
  assert.equal(config.pollTimeoutMs, 5_000);
});

test("buildTasksConformanceConfig forwards --input-responses", () => {
  // The gated Tasks checks are unreachable without this: an input-gated task
  // parks forever, and the checks that depend on it report `could-not-run`. A
  // flag that parsed but never reached the config would look exactly like a
  // server that does not implement the seam.
  const config = buildTasksConformanceConfig({
    url: "https://example.com/mcp",
    inputResponses: '{"name":{"content":{"answer":"Luca"}}}',
  });

  assert.deepEqual(config.inputResponses, {
    name: { content: { answer: "Luca" } },
  });
});

test("buildTasksConformanceConfig omits inputResponses when the flag is absent", () => {
  const config = buildTasksConformanceConfig({
    url: "https://example.com/mcp",
  });

  assert.equal("inputResponses" in config, false);
});

test("buildTasksConformanceConfig rejects a malformed --input-responses", () => {
  assert.throws(
    () =>
      buildTasksConformanceConfig({
        url: "https://example.com/mcp",
        inputResponses: "not json",
      }),
    (error) =>
      error instanceof CliError && error.message.includes("--input-responses")
  );
});
