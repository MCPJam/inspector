import assert from "node:assert/strict";
import test from "node:test";
import { buildXaaConfig, redactXaaResult } from "../src/commands/xaa.js";
import { CliError } from "../src/lib/output.js";
import type { XaaFlowResult } from "@mcpjam/sdk";

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

test("buildXaaConfig maps optional fields and the global timeout", () => {
  const config = buildXaaConfig(
    {
      ...base,
      authzServerIssuer: "https://auth.example.com",
      tokenEndpoint: "https://auth.example.com/oauth/token",
      email: "u@example.com",
      clientSecret: "secret-1",
      tokenEndpointAuthMethod: "client_secret_basic",
      scopes: "read:tools write:tools",
      httpsOnly: true,
    },
    12_345
  );

  assert.equal(config.authzServerIssuer, "https://auth.example.com");
  assert.equal(config.tokenEndpoint, "https://auth.example.com/oauth/token");
  assert.equal(config.email, "u@example.com");
  assert.equal(config.clientSecret, "secret-1");
  assert.equal(config.tokenEndpointAuthMethod, "client_secret_basic");
  assert.equal(config.scope, "read:tools write:tools");
  assert.equal(config.timeoutMs, 12_345);
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
      error instanceof CliError && /Invalid server URL/.test(error.message)
  );
});

test("buildXaaConfig rejects an invalid issuer base URL", () => {
  assert.throws(
    () => buildXaaConfig({ ...base, issuerBaseUrl: "nope" }),
    (error: unknown) =>
      error instanceof CliError && /Invalid issuer base URL/.test(error.message)
  );
});

test("buildXaaConfig rejects an invalid authorization server issuer", () => {
  assert.throws(
    () => buildXaaConfig({ ...base, authzServerIssuer: "bad" }),
    (error: unknown) =>
      error instanceof CliError &&
      /Invalid authorization server issuer/.test(error.message)
  );
});

test("buildXaaConfig rejects an invalid token endpoint", () => {
  assert.throws(
    () => buildXaaConfig({ ...base, tokenEndpoint: "bad" }),
    (error: unknown) =>
      error instanceof CliError && /Invalid token endpoint/.test(error.message)
  );
});

test("buildXaaConfig rejects a blank subject", () => {
  assert.throws(
    () => buildXaaConfig({ ...base, sub: "   " }),
    (error: unknown) =>
      error instanceof CliError && /--sub must not be empty/.test(error.message)
  );
});

test("redactXaaResult masks the ID-JAG token and issued bearer tokens", () => {
  const result = {
    completed: true,
    issuer: "https://issuer.example.com/api/mcp/xaa",
    idJag: {
      token: "eyJraWQ.secret.signature",
      claims: { sub: "user-1", aud: "https://auth.example.com" },
      verified: true,
    },
    redemption: {
      status: 200,
      tokenIssued: true,
      body: {
        access_token: "at-super-secret",
        refresh_token: "rt-super-secret",
        id_token: "idt-super-secret",
        token_type: "Bearer",
        expires_in: 300,
        // A nested/reflected secret the recursive redactor must also catch.
        extra: { access_token: "nested-secret" },
        // The AS reflecting the raw ID-JAG back under non-secret field names.
        assertion: "eyJraWQ.secret.signature",
        error_description: "invalid assertion eyJraWQ.secret.signature",
      },
    },
    mcp: { status: 200, ok: true },
    steps: [],
  } as unknown as XaaFlowResult;

  const redacted = redactXaaResult(result);

  assert.equal(redacted.idJag?.token, "[REDACTED]");
  // Decoded claims stay visible for inspection.
  assert.deepEqual(redacted.idJag?.claims, {
    sub: "user-1",
    aud: "https://auth.example.com",
  });
  const body = redacted.redemption?.body as Record<string, unknown>;
  assert.equal(body.access_token, "[REDACTED]");
  assert.equal(body.refresh_token, "[REDACTED]");
  assert.equal(body.id_token, "[REDACTED]");
  assert.equal(
    (body.extra as Record<string, unknown>).access_token,
    "[REDACTED]"
  );
  // A reflected raw ID-JAG is scrubbed even under non-secret field names.
  assert.equal(body.assertion, "[REDACTED]");
  assert.equal(body.error_description, "invalid assertion [REDACTED]");
  assert.equal(body.token_type, "Bearer");
  assert.equal(body.expires_in, 300);
  // The original result is not mutated.
  assert.equal(result.idJag?.token, "eyJraWQ.secret.signature");
  assert.equal(
    (result.redemption?.body as Record<string, unknown>).access_token,
    "at-super-secret"
  );
});

test("buildXaaConfig rejects a blank client id", () => {
  assert.throws(
    () => buildXaaConfig({ ...base, clientId: "   " }),
    (error: unknown) =>
      error instanceof CliError &&
      /--client-id must not be empty/.test(error.message)
  );
});

test("buildXaaConfig rejects a non-positive timeout", () => {
  assert.throws(
    () => buildXaaConfig({ ...base }, 0),
    (error: unknown) =>
      error instanceof CliError &&
      /--timeout must be a positive/.test(error.message)
  );
});

test("buildXaaConfig requires a secret for confidential client auth", () => {
  assert.throws(
    () =>
      buildXaaConfig({
        ...base,
        tokenEndpointAuthMethod: "client_secret_basic",
      }),
    (error: unknown) =>
      error instanceof CliError && /requires --client-secret/.test(error.message),
  );
});
