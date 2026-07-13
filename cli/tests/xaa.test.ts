import assert from "node:assert/strict";
import test from "node:test";
import { buildXaaConfig } from "../src/commands/xaa.js";
import { CliError } from "../src/lib/output.js";

const base = {
  url: "https://mcp.example.com/mcp",
  issuerBaseUrl: "https://issuer.example.com/api/mcp",
  sub: "user-1",
  clientId: "client-1",
};

test("buildXaaConfig maps the required fields", () => {
  const config = buildXaaConfig({ ...base });

  assert.equal(config.serverUrl, "https://mcp.example.com/mcp");
  assert.equal(config.issuerBaseUrl, "https://issuer.example.com/api/mcp");
  assert.equal(config.subject, "user-1");
  assert.equal(config.clientId, "client-1");
  assert.equal(config.httpsOnly, false);
});

test("buildXaaConfig maps the optional fields when supplied", () => {
  const config = buildXaaConfig({
    ...base,
    authzServerIssuer: "https://auth.example.com",
    tokenEndpoint: "https://auth.example.com/oauth/token",
    email: "u@example.com",
    clientSecret: "secret-1",
    scopes: "read:tools write:tools",
    httpsOnly: true,
  });

  assert.equal(config.authzServerIssuer, "https://auth.example.com");
  assert.equal(config.tokenEndpoint, "https://auth.example.com/oauth/token");
  assert.equal(config.email, "u@example.com");
  assert.equal(config.clientSecret, "secret-1");
  assert.equal(config.scope, "read:tools write:tools");
  assert.equal(config.httpsOnly, true);
});

test("buildXaaConfig omits optional fields left unset", () => {
  const config = buildXaaConfig({ ...base });

  assert.equal(config.authzServerIssuer, undefined);
  assert.equal(config.tokenEndpoint, undefined);
  assert.equal(config.email, undefined);
  assert.equal(config.clientSecret, undefined);
  assert.equal(config.scope, undefined);
});

test("buildXaaConfig trims whitespace and treats blank optionals as unset", () => {
  const config = buildXaaConfig({
    ...base,
    url: "  https://mcp.example.com/mcp  ",
    sub: "  user-1  ",
    email: "   ",
    scopes: "   ",
  });

  assert.equal(config.serverUrl, "https://mcp.example.com/mcp");
  assert.equal(config.subject, "user-1");
  assert.equal(config.email, undefined);
  assert.equal(config.scope, undefined);
});

test("buildXaaConfig rejects an invalid server URL", () => {
  assert.throws(
    () => buildXaaConfig({ ...base, url: "not-a-url" }),
    (error: unknown) =>
      error instanceof CliError && /Invalid server URL/.test(error.message),
  );
});

test("buildXaaConfig rejects an invalid issuer base URL", () => {
  assert.throws(
    () => buildXaaConfig({ ...base, issuerBaseUrl: "nope" }),
    (error: unknown) =>
      error instanceof CliError && /Invalid issuer base URL/.test(error.message),
  );
});

test("buildXaaConfig rejects an invalid authorization server issuer", () => {
  assert.throws(
    () => buildXaaConfig({ ...base, authzServerIssuer: "bad" }),
    (error: unknown) =>
      error instanceof CliError &&
      /Invalid authorization server issuer/.test(error.message),
  );
});

test("buildXaaConfig rejects an invalid token endpoint", () => {
  assert.throws(
    () => buildXaaConfig({ ...base, tokenEndpoint: "bad" }),
    (error: unknown) =>
      error instanceof CliError && /Invalid token endpoint/.test(error.message),
  );
});

test("buildXaaConfig rejects a blank subject", () => {
  assert.throws(
    () => buildXaaConfig({ ...base, sub: "   " }),
    (error: unknown) =>
      error instanceof CliError && /--sub must not be empty/.test(error.message),
  );
});

test("buildXaaConfig rejects a blank client id", () => {
  assert.throws(
    () => buildXaaConfig({ ...base, clientId: "   " }),
    (error: unknown) =>
      error instanceof CliError &&
      /--client-id must not be empty/.test(error.message),
  );
});
