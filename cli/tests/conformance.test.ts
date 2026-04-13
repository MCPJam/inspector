import assert from "node:assert/strict";
import test from "node:test";
import { buildConfig } from "../src/commands/conformance";
import { CliError } from "../src/lib/output";

test("buildConfig rejects non-http URLs", () => {
  assert.throws(
    () =>
      buildConfig({
        url: "file:///tmp/mcp.sock",
      }),
    (error) =>
      error instanceof CliError &&
      error.message.includes("Invalid URL scheme"),
  );
});

test("buildConfig rejects unknown categories and check ids", () => {
  assert.throws(
    () =>
      buildConfig({
        url: "https://example.com/mcp",
        category: ["core", "bogus"],
      }),
    (error) =>
      error instanceof CliError &&
      error.message.includes("Unknown category"),
  );

  assert.throws(
    () =>
      buildConfig({
        url: "https://example.com/mcp",
        checkId: ["ping", "bogus"],
      }),
    (error) =>
      error instanceof CliError &&
      error.message.includes("Unknown check id"),
  );
});

test("buildConfig preserves validated conformance filters", () => {
  const config = buildConfig({
    url: "https://example.com/mcp",
    category: ["core"],
    checkId: ["ping"],
  });

  assert.deepEqual(config.categories, ["core"]);
  assert.deepEqual(config.checkIds, ["ping"]);
});
