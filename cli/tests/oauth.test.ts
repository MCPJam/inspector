import assert from "node:assert/strict";
import test from "node:test";
import { buildOAuthConformanceConfig } from "../src/commands/oauth";
import { CliError } from "../src/lib/output";

test("buildOAuthConformanceConfig defaults to headless auth", () => {
  const config = buildOAuthConformanceConfig({
    url: "https://example.com/mcp",
    protocolVersion: "2025-11-25",
    registration: "cimd",
  });

  assert.equal(config.auth?.mode, "headless");
  assert.equal(config.registrationStrategy, "cimd");
});

test("buildOAuthConformanceConfig maps preregistered client settings", () => {
  const config = buildOAuthConformanceConfig({
    url: "https://example.com/mcp",
    protocolVersion: "2025-06-18",
    registration: "preregistered",
    authMode: "interactive",
    clientId: "client-id",
    clientSecret: "client-secret",
    header: ["X-Test: 1"],
  });

  assert.equal(config.auth?.mode, "interactive");
  assert.deepEqual(config.client?.preregistered, {
    clientId: "client-id",
    clientSecret: "client-secret",
  });
  assert.deepEqual(config.customHeaders, {
    "X-Test": "1",
  });
});

test("buildOAuthConformanceConfig maps redirectUrl when provided", () => {
  const config = buildOAuthConformanceConfig({
    url: "https://example.com/mcp",
    protocolVersion: "2025-11-25",
    registration: "dcr",
    redirectUrl: "https://app.example.com/oauth/callback",
  });

  assert.equal(config.redirectUrl, "https://app.example.com/oauth/callback");
});

test("buildOAuthConformanceConfig allows DCR client_credentials without explicit creds", () => {
  const config = buildOAuthConformanceConfig({
    url: "https://example.com/mcp",
    protocolVersion: "2025-06-18",
    registration: "dcr",
    authMode: "client_credentials",
  });

  if (config.auth?.mode !== "client_credentials") {
    assert.fail("Expected client_credentials auth mode");
  }

  assert.equal(config.auth.clientId, "__dynamic_registration_client__");
  assert.equal(config.auth.clientSecret, "__dynamic_registration_secret__");
});

test("buildOAuthConformanceConfig adds verification when --verify-tools is set", () => {
  const config = buildOAuthConformanceConfig({
    url: "https://example.com/mcp",
    protocolVersion: "2025-11-25",
    registration: "cimd",
    verifyTools: true,
  });

  assert.equal(config.verification?.listTools, true);
  assert.equal(config.verification?.callTool, undefined);
});

test("buildOAuthConformanceConfig adds callTool when --verify-call-tool is set", () => {
  const config = buildOAuthConformanceConfig({
    url: "https://example.com/mcp",
    protocolVersion: "2025-06-18",
    registration: "dcr",
    verifyCallTool: "execute_sql",
  });

  assert.equal(config.verification?.listTools, true);
  assert.deepEqual(config.verification?.callTool, { name: "execute_sql" });
});

test("buildOAuthConformanceConfig omits verification when flags not set", () => {
  const config = buildOAuthConformanceConfig({
    url: "https://example.com/mcp",
    protocolVersion: "2025-11-25",
    registration: "cimd",
  });

  assert.equal(config.verification, undefined);
});

test("buildOAuthConformanceConfig rejects unsupported combinations", () => {
  assert.throws(
    () =>
      buildOAuthConformanceConfig({
        url: "https://example.com/mcp",
        protocolVersion: "2025-06-18",
        registration: "cimd",
      }),
    (error) =>
      error instanceof CliError &&
      error.message.includes("CIMD registration is not supported"),
  );

  assert.throws(
    () =>
      buildOAuthConformanceConfig({
        url: "https://example.com/mcp",
        protocolVersion: "2025-11-25",
        registration: "cimd",
        authMode: "client_credentials",
      }),
    (error) =>
      error instanceof CliError &&
      error.message.includes("--auth-mode client_credentials cannot be used with --registration cimd") &&
      error.message.includes("only works with --auth-mode headless or --auth-mode interactive") &&
      error.message.includes("use --registration dcr or --registration preregistered"),
  );

  assert.throws(
    () =>
      buildOAuthConformanceConfig({
        url: "https://example.com/mcp",
        protocolVersion: "2025-11-25",
        registration: "preregistered",
        authMode: "client_credentials",
        clientId: "client-id",
      }),
    (error) =>
      error instanceof CliError &&
      error.message.includes("--client-secret is required"),
  );
});

test("buildOAuthConformanceConfig rejects an invalid redirectUrl", () => {
  assert.throws(
    () =>
      buildOAuthConformanceConfig({
        url: "https://example.com/mcp",
        protocolVersion: "2025-06-18",
        registration: "dcr",
        redirectUrl: "not-a-url",
      }),
    (error) =>
      error instanceof CliError &&
      error.message.includes("Invalid redirect URL"),
  );
});
