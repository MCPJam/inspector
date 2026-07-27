import assert from "node:assert/strict";
import test from "node:test";
import { MCP_TASKS_CHECK_IDS } from "@mcpjam/sdk";
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
