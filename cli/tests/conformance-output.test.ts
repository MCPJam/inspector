import assert from "node:assert/strict";
import test from "node:test";
import {
  renderConformanceReportJUnitXml,
  toConformanceReport,
  type MCPAppsConformanceResult,
  type MCPConformanceResult,
} from "@mcpjam/sdk";
import {
  parseConformanceOutputFormat,
  renderConformanceResult,
  resolveConformanceOutputFormat,
} from "../src/lib/conformance-output.js";
import { CliError } from "../src/lib/output.js";

function createProtocolResult(): MCPConformanceResult {
  return {
    passed: false,
    serverUrl: "https://mcp.example.com/mcp",
    checks: [
      {
        id: "ping",
        category: "core",
        title: "Ping",
        description: "Ping the server",
        status: "failed",
        durationMs: 12,
        error: {
          message: "Server returned 500",
        },
      },
      {
        id: "tools-list",
        category: "tools",
        title: "Tools List",
        description: "List tools",
        status: "skipped",
        durationMs: 0,
      },
    ],
    summary: "0/2 checks passed, 1 failed, 1 skipped",
    durationMs: 24,
    categorySummary: {
      core: { total: 1, passed: 0, failed: 1, skipped: 0 },
      protocol: { total: 0, passed: 0, failed: 0, skipped: 0 },
      tools: { total: 1, passed: 0, failed: 0, skipped: 1 },
      prompts: { total: 0, passed: 0, failed: 0, skipped: 0 },
      resources: { total: 0, passed: 0, failed: 0, skipped: 0 },
      security: { total: 0, passed: 0, failed: 0, skipped: 0 },
      transport: { total: 0, passed: 0, failed: 0, skipped: 0 },
    },
  };
}

function createAppsResult(): MCPAppsConformanceResult {
  return {
    passed: true,
    target: "node mock-server.js",
    checks: [
      {
        id: "ui-tools-present",
        category: "tools",
        title: "UI Tools Present",
        description: "At least one UI tool exists.",
        status: "passed",
        durationMs: 5,
      },
    ],
    summary: "1/1 checks passed, 0 failed, 0 skipped",
    durationMs: 5,
    categorySummary: {
      tools: { total: 1, passed: 1, failed: 0, skipped: 0 },
      resources: { total: 0, passed: 0, failed: 0, skipped: 0 },
    },
    discovery: {
      toolCount: 1,
      uiToolCount: 1,
      listedResourceCount: 1,
      listedUiResourceCount: 1,
      checkedUiResourceCount: 1,
    },
  };
}

test("resolveConformanceOutputFormat defaults to human on TTY and json otherwise", () => {
  assert.equal(resolveConformanceOutputFormat(undefined, true), "human");
  assert.equal(resolveConformanceOutputFormat(undefined, false), "json");
  assert.equal(resolveConformanceOutputFormat("junit-xml", true), "junit-xml");
});

test("parseConformanceOutputFormat rejects unsupported formats", () => {
  assert.throws(
    () => parseConformanceOutputFormat("yaml"),
    (error) =>
      error instanceof CliError && error.message.includes("Invalid output format"),
  );
});

test("renderConformanceResult uses byte-identical JUnit XML from the shared SDK helper", () => {
  const result = createProtocolResult();

  assert.equal(
    renderConformanceResult(result, "junit-xml"),
    renderConformanceReportJUnitXml(toConformanceReport(result)),
  );
});

test("renderConformanceResult preserves human and json output for apps results", () => {
  const result = createAppsResult();

  assert.equal(renderConformanceResult(result, "human"), JSON.stringify(result, null, 2));
  assert.equal(renderConformanceResult(result, "json"), JSON.stringify(result));
});
