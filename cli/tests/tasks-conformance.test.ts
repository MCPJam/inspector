import assert from "node:assert/strict";
import test from "node:test";
import { buildTasksConformanceConfig } from "../src/commands/tasks.js";
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

test("buildTasksConformanceConfig lets explicit check ids override categories", () => {
  const config = buildTasksConformanceConfig({
    url: "https://example.com/mcp",
    category: ["lifecycle"],
    checkId: ["tasks-inline-result"],
  });

  assert.deepEqual(config.checkIds, ["tasks-inline-result"]);
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
