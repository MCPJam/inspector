import assert from "node:assert/strict";
import test from "node:test";
import {
  formatOAuthConformanceHuman,
  formatOAuthConformanceSuiteHuman,
  type ConformanceResult,
  type OAuthConformanceSuiteResult,
} from "@mcpjam/sdk";
import {
  renderOAuthConformanceResult,
  renderOAuthConformanceSuiteResult,
  parseOAuthOutputFormat,
  resolveOAuthOutputFormat,
} from "../src/lib/oauth-output.js";
import { CliError } from "../src/lib/output.js";

function createSingleResult(): ConformanceResult {
  return {
    passed: false,
    protocolVersion: "2025-06-18",
    registrationStrategy: "dcr",
    serverUrl: "https://mcp.example.com/mcp",
    steps: [
      {
        step: "received_authorization_code",
        title: "Authorization Code Received",
        summary:
          "Inspector validates the redirect back to the callback URL and extracts the authorization code.",
        status: "failed",
        durationMs: 10,
        logs: [],
        http: {
          step: "received_authorization_code",
          timestamp: 0,
          request: {
            method: "GET",
            url: "https://auth.example.com/authorize",
            headers: {},
          },
          response: {
            status: 200,
            statusText: "OK",
            headers: { "content-type": "text/html" },
            body: "<html><head><title>Log in</title></head><body>Sign in</body></html>",
          },
          duration: 10,
        },
        httpAttempts: [],
        error: {
          message:
            "Headless authorization requires auto-consent. The authorization endpoint returned a 200 response instead of redirecting back with a code.",
        },
      },
    ],
    summary:
      "OAuth conformance failed at received_authorization_code: Headless authorization requires auto-consent.",
    durationMs: 40,
  };
}

function createSuiteResult(): OAuthConformanceSuiteResult {
  return {
    name: "Suite",
    serverUrl: "https://mcp.example.com/mcp",
    passed: false,
    results: [
      { ...createSingleResult(), label: "headless-dcr" },
    ],
    summary: "0/1 flows passed. Failed: headless-dcr",
    durationMs: 40,
  };
}

test("resolveOAuthOutputFormat defaults to human on TTY and json otherwise", () => {
  assert.equal(resolveOAuthOutputFormat(undefined, true), "human");
  assert.equal(resolveOAuthOutputFormat(undefined, false), "json");
  assert.equal(resolveOAuthOutputFormat("json", true), "json");
  assert.equal(resolveOAuthOutputFormat("human", false), "human");
});

test("parseOAuthOutputFormat rejects junit-xml and points to reporter", () => {
  assert.throws(
    () => parseOAuthOutputFormat("junit-xml"),
    (error) =>
      error instanceof CliError &&
      error.message.includes("Use --reporter junit-xml"),
  );
});

test("renderOAuthConformanceResult uses the SDK human formatter for human output", () => {
  const result = createSingleResult();

  assert.equal(
    renderOAuthConformanceResult(result, "human"),
    formatOAuthConformanceHuman(result),
  );
});

test("renderOAuthConformanceResult preserves raw JSON output", () => {
  const result = createSingleResult();

  assert.equal(renderOAuthConformanceResult(result, "json"), JSON.stringify(result));
});

test("renderOAuthConformanceSuiteResult uses the SDK human formatter for human output", () => {
  const result = createSuiteResult();

  assert.equal(
    renderOAuthConformanceSuiteResult(result, "human"),
    formatOAuthConformanceSuiteHuman(result),
  );
});

test("renderOAuthConformanceSuiteResult preserves raw JSON output", () => {
  const result = createSuiteResult();

  assert.equal(
    renderOAuthConformanceSuiteResult(result, "json"),
    JSON.stringify(result),
  );
});
