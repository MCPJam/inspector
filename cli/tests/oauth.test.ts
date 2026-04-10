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
        registration: "preregistered",
        authMode: "client_credentials",
        clientId: "client-id",
      }),
    (error) =>
      error instanceof CliError &&
      error.message.includes("--client-secret is required"),
  );
});
