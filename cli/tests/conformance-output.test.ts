import assert from "node:assert/strict";
import test from "node:test";
import {
  renderConformanceReportJson,
  renderConformanceReportJUnitXml,
  toConformanceReport,
  type MCPAppsConformanceResult,
  type MCPConformanceResult,
} from "@mcpjam/sdk";
import {
  parseConformanceOutputFormat,
  renderConformanceForCli,
  renderConformanceReporterResult,
  renderConformanceResult,
  resolveConformanceOutputFormat,
  resolveConformanceOutputFormatForCli,
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
});

test("parseConformanceOutputFormat rejects unsupported formats", () => {
  assert.throws(
    () => parseConformanceOutputFormat("yaml"),
    (error) =>
      error instanceof CliError && error.message.includes("Invalid output format"),
  );
  assert.throws(
    () => parseConformanceOutputFormat("junit-xml"),
    (error) =>
      error instanceof CliError &&
      error.message.includes("Use --reporter junit-xml"),
  );
  assert.throws(
    () => parseConformanceOutputFormat("json-summary"),
    (error) =>
      error instanceof CliError &&
      error.message.includes("Use --reporter json-summary"),
  );
});

test("resolveConformanceOutputFormatForCli validates format before reporter output", () => {
  assert.equal(
    resolveConformanceOutputFormatForCli("json", false, "junit-xml"),
    "json",
  );
  assert.equal(
    resolveConformanceOutputFormatForCli("junit-xml", false, "junit-xml"),
    "json",
  );
  assert.equal(
    resolveConformanceOutputFormatForCli("json-summary", false, "junit-xml"),
    "json",
  );
  assert.throws(
    () => resolveConformanceOutputFormatForCli("typo", false, "junit-xml"),
    (error) =>
      error instanceof CliError && error.message.includes("Invalid output format"),
  );
});

test("renderConformanceReporterResult emits conformance reporter output", () => {
  const result = createProtocolResult();

  assert.equal(
    renderConformanceReporterResult(result, "junit-xml"),
    renderConformanceReportJUnitXml(toConformanceReport(result)),
  );
  assert.equal(
    renderConformanceReporterResult(result, "json-summary"),
    JSON.stringify(renderConformanceReportJson(toConformanceReport(result))),
  );
  assert.equal(
    renderConformanceForCli(result, "junit-xml", "json"),
    renderConformanceReportJUnitXml(toConformanceReport(result)),
  );
});

test("renderConformanceResult preserves human and json output for apps results", () => {
  const result = createAppsResult();

  assert.equal(renderConformanceResult(result, "human"), JSON.stringify(result, null, 2));
  assert.equal(renderConformanceResult(result, "json"), JSON.stringify(result));
});
