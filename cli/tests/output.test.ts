import assert from "node:assert/strict";
import test from "node:test";
import {
  CliError,
  detectOutputFormatFromArgv,
  parseOutputFormat,
  resolveOutputFormat,
} from "../src/lib/output.js";

test("resolveOutputFormat defaults to human on TTY and json otherwise", () => {
  assert.equal(resolveOutputFormat(undefined, true), "human");
  assert.equal(resolveOutputFormat(undefined, false), "json");
  assert.equal(resolveOutputFormat("json", true), "json");
  assert.equal(resolveOutputFormat("human", false), "human");
});

test("detectOutputFormatFromArgv respects explicit flags and TTY defaults", () => {
  assert.equal(
    detectOutputFormatFromArgv(["node", "cli"], true),
    "human",
  );
  assert.equal(
    detectOutputFormatFromArgv(["node", "cli"], false),
    "json",
  );
  assert.equal(
    detectOutputFormatFromArgv(["node", "cli", "--format", "human"], false),
    "human",
  );
  assert.equal(
    detectOutputFormatFromArgv(["node", "cli", "--format=json"], true),
    "json",
  );
});

test("parseOutputFormat keeps reporter formats out of --format", () => {
  assert.throws(
    () => parseOutputFormat("junit-xml"),
    (error) =>
      error instanceof CliError &&
      error.message.includes("Use --reporter junit-xml"),
  );
  assert.throws(
    () => parseOutputFormat("json-summary"),
    (error) =>
      error instanceof CliError &&
      error.message.includes("Use --reporter json-summary"),
  );
});
