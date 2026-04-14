import assert from "node:assert/strict";
import test from "node:test";
import {
  suiteResultToJUnitXml,
  singleResultToJUnitXml,
} from "../src/lib/junit-xml.js";
import type {
  OAuthConformanceSuiteResult,
  ConformanceResult,
} from "@mcpjam/sdk";

function makeSuiteResult(
  overrides: Partial<OAuthConformanceSuiteResult> = {},
): OAuthConformanceSuiteResult {
  return {
    name: "Test Suite",
    serverUrl: "https://mcp.example.com/mcp",
    passed: true,
    results: [],
    summary: "All passed",
    durationMs: 1000,
    ...overrides,
  };
}

function makeFlowResult(
  label: string,
  passed: boolean,
  steps: ConformanceResult["steps"] = [],
): ConformanceResult & { label: string } {
  return {
    label,
    passed,
    protocolVersion: "2025-11-25",
    registrationStrategy: "cimd",
    serverUrl: "https://mcp.example.com/mcp",
    steps,
    summary: passed ? "Passed" : "Failed",
    durationMs: 500,
  };
}

test("suiteResultToJUnitXml generates valid XML structure", () => {
  const result = makeSuiteResult({
    results: [
      makeFlowResult("CIMD flow", true, [
        {
          step: "request_without_token",
          title: "Initial MCP Request",
          summary: "Send unauthenticated request",
          status: "passed",
          durationMs: 100,
          logs: [],
          httpAttempts: [],
        },
        {
          step: "complete",
          title: "Flow Complete",
          summary: "Done",
          status: "passed",
          durationMs: 50,
          logs: [],
          httpAttempts: [],
        },
      ]),
    ],
  });

  const xml = suiteResultToJUnitXml(result);

  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(xml.includes('<testsuites name="Test Suite"'));
  assert.ok(xml.includes('tests="2"'));
  assert.ok(xml.includes('failures="0"'));
  assert.ok(xml.includes('<testsuite name="CIMD flow"'));
  assert.ok(xml.includes('<testcase name="Initial MCP Request"'));
  assert.ok(xml.includes('<testcase name="Flow Complete"'));
});

test("suiteResultToJUnitXml marks failed steps with failure element", () => {
  const result = makeSuiteResult({
    passed: false,
    results: [
      makeFlowResult("DCR flow", false, [
        {
          step: "request_without_token",
          title: "Initial MCP Request",
          summary: "Send request",
          status: "failed",
          durationMs: 200,
          logs: [],
          httpAttempts: [
            {
              step: "request_without_token",
              timestamp: Date.now(),
              duration: 200,
              request: { method: "POST", url: "https://mcp.example.com/mcp", headers: {} },
              response: { status: 500, statusText: "Internal Server Error", headers: {}, body: null },
            },
          ],
          error: { message: "Server returned 500" },
        },
      ]),
    ],
  });

  const xml = suiteResultToJUnitXml(result);

  assert.ok(xml.includes('failures="1"'));
  assert.ok(xml.includes('<failure message="Server returned 500"'));
  assert.ok(xml.includes("POST https://mcp.example.com/mcp"));
});

test("suiteResultToJUnitXml marks skipped steps", () => {
  const result = makeSuiteResult({
    results: [
      makeFlowResult("CC flow", true, [
        {
          step: "generate_pkce_parameters",
          title: "Generate PKCE Parameters",
          summary: "Skipped for client_credentials",
          status: "skipped",
          durationMs: 0,
          logs: [],
          httpAttempts: [],
        },
      ]),
    ],
  });

  const xml = suiteResultToJUnitXml(result);

  assert.ok(xml.includes("<skipped/>"));
});

test("suiteResultToJUnitXml escapes XML special characters", () => {
  const result = makeSuiteResult({
    name: 'Suite with "quotes" & <brackets>',
    results: [
      makeFlowResult('Flow with <special> & "chars"', true, []),
    ],
  });

  const xml = suiteResultToJUnitXml(result);

  assert.ok(xml.includes("&amp;"));
  assert.ok(xml.includes("&lt;"));
  assert.ok(xml.includes("&gt;"));
  assert.ok(xml.includes("&quot;"));
  assert.ok(!xml.includes("<special>"));
  assert.ok(!xml.includes("<brackets>"));
});

test("singleResultToJUnitXml wraps a single result in suite format", () => {
  const result: ConformanceResult = {
    passed: true,
    protocolVersion: "2025-11-25",
    registrationStrategy: "cimd",
    serverUrl: "https://mcp.example.com/mcp",
    steps: [
      {
        step: "complete",
        title: "Flow Complete",
        summary: "Done",
        status: "passed",
        durationMs: 100,
        logs: [],
        httpAttempts: [],
      },
    ],
    summary: "Passed",
    durationMs: 1000,
  };

  const xml = singleResultToJUnitXml(result);

  assert.ok(xml.includes('<testsuites name="OAuth Conformance"'));
  assert.ok(xml.includes('<testsuite name="2025-11-25/cimd"'));
  assert.ok(xml.includes('<testcase name="Flow Complete"'));
});

test("singleResultToJUnitXml uses custom label", () => {
  const result: ConformanceResult = {
    passed: true,
    protocolVersion: "2025-06-18",
    registrationStrategy: "dcr",
    serverUrl: "https://mcp.example.com/mcp",
    steps: [],
    summary: "Passed",
    durationMs: 500,
  };

  const xml = singleResultToJUnitXml(result, "My Custom Label");
  assert.ok(xml.includes('<testsuite name="My Custom Label"'));
});
