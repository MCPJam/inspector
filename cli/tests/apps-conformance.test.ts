import assert from "node:assert/strict";
import test from "node:test";
import { buildAppsConformanceConfig } from "../src/commands/apps";
import { CliError } from "../src/lib/output";

test("buildAppsConformanceConfig rejects unknown categories and check ids", () => {
  assert.throws(
    () =>
      buildAppsConformanceConfig({
        url: "https://example.com/mcp",
        category: ["tools", "bogus"],
      }),
    (error) =>
      error instanceof CliError &&
      error.message.includes("Unknown category"),
  );

  assert.throws(
    () =>
      buildAppsConformanceConfig({
        url: "https://example.com/mcp",
        checkId: ["ui-tools-present", "bogus"],
      }),
    (error) =>
      error instanceof CliError &&
      error.message.includes("Unknown check id"),
  );
});

test("buildAppsConformanceConfig expands categories into check ids", () => {
  const config = buildAppsConformanceConfig({
    url: "https://example.com/mcp",
    category: ["tools"],
  });

  assert.deepEqual(config.checkIds, [
    "ui-tools-present",
    "ui-tool-metadata-valid",
    "ui-tool-input-schema-valid",
  ]);
});

test("buildAppsConformanceConfig lets explicit check ids override categories", () => {
  const config = buildAppsConformanceConfig({
    url: "https://example.com/mcp",
    category: ["resources"],
    checkId: ["ui-tools-present"],
  });

  assert.deepEqual(config.checkIds, ["ui-tools-present"]);
});
