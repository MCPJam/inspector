import assert from "node:assert/strict";
import test from "node:test";
import {
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
            headers: { Authorization: "Bearer request-token" },
          },
          response: {
            status: 200,
            statusText: "OK",
            headers: { "content-type": "text/html" },
            body: {
              access_token: "nested-access-token",
              refresh_token: "nested-refresh-token",
              id_token: "nested-id-token",
            },
          },
          duration: 10,
        },
        httpAttempts: [
          {
            step: "token_request",
            timestamp: 0,
            request: {
              method: "POST",
              url: "https://auth.example.com/token",
              headers: { Authorization: "Bearer attempt-token" },
              body: {
                code: "authorization-code",
                client_secret: "attempt-client-secret",
              },
            },
            response: {
              status: 200,
              statusText: "OK",
              headers: { "content-type": "application/json" },
              body: {
                access_token: "attempt-access-token",
                refresh_token: "attempt-refresh-token",
                id_token: "attempt-id-token",
              },
            },
          },
        ],
        error: {
          message:
            "Headless authorization requires auto-consent. The authorization endpoint returned a 200 response instead of redirecting back with a code.",
          details: "Authorization: Bearer error-token access_token=error-token",
        },
      },
    ],
    summary:
      "OAuth conformance failed at received_authorization_code: Headless authorization requires auto-consent.",
    durationMs: 40,
    credentials: {
      accessToken: "result-access-token",
      refreshToken: "result-refresh-token",
      clientId: "client-id",
      clientSecret: "result-client-secret",
      tokenType: "bearer",
      expiresIn: 3600,
    },
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

test("parseOAuthOutputFormat rejects reporter formats as unsupported raw output", () => {
  assert.throws(
    () => parseOAuthOutputFormat("junit-xml"),
    (error) =>
      error instanceof CliError &&
      error.message.includes('Use "json" or "human"'),
  );
  assert.throws(
    () => parseOAuthOutputFormat("json-summary"),
    (error) =>
      error instanceof CliError &&
      error.message.includes('Use "json" or "human"'),
  );
});

test("renderOAuthConformanceResult redacts sensitive human output", () => {
  const result = createSingleResult();
  const output = renderOAuthConformanceResult(result, "human");

  assert.match(output, /OAuth conformance: FAILED/);
  assert.match(output, /\[REDACTED\]/);
  assert.doesNotMatch(
    output,
    /result-access-token|result-refresh-token|result-client-secret|nested-access-token|nested-refresh-token|nested-id-token|attempt-access-token|attempt-refresh-token|attempt-id-token|attempt-client-secret|error-token/,
  );
});

test("renderOAuthConformanceResult redacts sensitive JSON output", () => {
  const result = createSingleResult();
  const output = renderOAuthConformanceResult(result, "json");
  const payload = JSON.parse(output);

  assert.equal(payload.credentials.accessToken, "[REDACTED]");
  assert.equal(payload.credentials.refreshToken, "[REDACTED]");
  assert.equal(payload.credentials.clientSecret, "[REDACTED]");
  assert.equal(payload.credentials.clientId, "client-id");
  assert.equal(payload.credentials.tokenType, "bearer");
  assert.equal(payload.steps[0].http.request.headers.Authorization, "[REDACTED]");
  assert.equal(payload.steps[0].http.response.body.access_token, "[REDACTED]");
  assert.equal(payload.steps[0].httpAttempts[0].request.body.code, "[REDACTED]");
  assert.equal(
    payload.steps[0].httpAttempts[0].response.body.refresh_token,
    "[REDACTED]",
  );
  assert.doesNotMatch(
    output,
    /result-access-token|result-refresh-token|nested-access-token|attempt-access-token|attempt-refresh-token|attempt-client-secret|error-token/,
  );
});

test("renderOAuthConformanceResult marks credentials saved to file", () => {
  const result = createSingleResult();
  const output = renderOAuthConformanceResult(result, "json", {
    credentialsFilePath: "/tmp/credentials.json",
  });
  const payload = JSON.parse(output);

  assert.equal(payload.credentials.accessToken, "[SAVED_TO_FILE]");
  assert.equal(payload.credentials.refreshToken, "[SAVED_TO_FILE]");
  assert.equal(payload.credentials.clientSecret, "[SAVED_TO_FILE]");
  assert.equal(payload.credentials.clientId, "client-id");
  assert.equal(payload.credentialsFile, "/tmp/credentials.json");
  assert.equal(payload.steps[0].http.response.body.access_token, "[REDACTED]");
});

test("renderOAuthConformanceSuiteResult redacts sensitive human output", () => {
  const result = createSuiteResult();
  const output = renderOAuthConformanceSuiteResult(result, "human");

  assert.match(output, /OAuth conformance suite: FAILED/);
  assert.match(output, /\[REDACTED\]/);
  assert.doesNotMatch(
    output,
    /result-access-token|result-refresh-token|result-client-secret|nested-access-token|nested-refresh-token|nested-id-token|attempt-access-token|attempt-refresh-token|attempt-id-token|attempt-client-secret|error-token/,
  );
});

test("renderOAuthConformanceSuiteResult redacts sensitive JSON output", () => {
  const result = createSuiteResult();
  const output = renderOAuthConformanceSuiteResult(result, "json");
  const payload = JSON.parse(output);

  assert.equal(payload.results[0].credentials.accessToken, "[REDACTED]");
  assert.equal(
    payload.results[0].steps[0].httpAttempts[0].request.headers.Authorization,
    "[REDACTED]",
  );
  assert.doesNotMatch(output, /result-access-token|attempt-access-token/);
});

test("renderOAuthConformanceSuiteResult marks selected flow credentials saved", () => {
  const result = createSuiteResult();
  const output = renderOAuthConformanceSuiteResult(result, "json", {
    credentialsFilePath: "/tmp/suite-credentials.json",
    credentialsResultIndex: 0,
  });
  const payload = JSON.parse(output);

  assert.equal(payload.credentialsFile, "/tmp/suite-credentials.json");
  assert.equal(payload.results[0].credentialsFile, "/tmp/suite-credentials.json");
  assert.equal(payload.results[0].credentials.accessToken, "[SAVED_TO_FILE]");
  assert.equal(payload.results[0].credentials.clientSecret, "[SAVED_TO_FILE]");
});
