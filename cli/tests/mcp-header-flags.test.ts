import assert from "node:assert/strict";
import test from "node:test";
import { parseMcpHeaderOption } from "../src/commands/tools.js";
import { CliError } from "../src/lib/output.js";

/**
 * `--mcp-header Name=Value` exists to send a DELIBERATELY WRONG mirrored
 * header, so its parser has to be exact: a value silently dropped or mangled
 * would make the resulting -32020 mean something other than what was asked.
 */
test("parseMcpHeaderOption returns undefined for no flags", () => {
  assert.equal(parseMcpHeaderOption(undefined), undefined);
  assert.equal(parseMcpHeaderOption([]), undefined);
});

test("parseMcpHeaderOption splits on the FIRST '=' only", () => {
  // A mirrored value can itself contain '=' (base64 padding, a query string).
  assert.deepEqual(parseMcpHeaderOption(["Mcp-Param-Q=a=b=c"]), {
    "Mcp-Param-Q": "a=b=c",
  });
});

test("parseMcpHeaderOption keeps a value containing ':' intact", () => {
  // The reason this flag is `Name=Value` and not `Key: Value` like --header.
  assert.deepEqual(parseMcpHeaderOption(["Mcp-Param-Uri=https://x.test/a"]), {
    "Mcp-Param-Uri": "https://x.test/a",
  });
});

test("parseMcpHeaderOption preserves an empty value", () => {
  // "send this header with an empty value" is a real probe, not a mistake.
  assert.deepEqual(parseMcpHeaderOption(["Mcp-Param-Region="]), {
    "Mcp-Param-Region": "",
  });
});

test("parseMcpHeaderOption is last-wins on a repeated name", () => {
  assert.deepEqual(
    parseMcpHeaderOption(["Mcp-Param-Region=us", "Mcp-Param-Region=eu"]),
    { "Mcp-Param-Region": "eu" },
  );
});

test("parseMcpHeaderOption rejects a value with no '='", () => {
  assert.throws(() => parseMcpHeaderOption(["Mcp-Param-Region"]), CliError);
});

test("parseMcpHeaderOption rejects an empty header name", () => {
  assert.throws(() => parseMcpHeaderOption(["=value"]), CliError);
  assert.throws(() => parseMcpHeaderOption(["  =value"]), CliError);
});
