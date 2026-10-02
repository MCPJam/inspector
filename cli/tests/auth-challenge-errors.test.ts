/**
 * A server's sign-in challenge is classified before any message regex runs:
 * the challenge's `error_description` is the server's prose, and prose that
 * says "connect" must not turn a sign-in request into SERVER_UNREACHABLE.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { InsufficientScopeError } from "@modelcontextprotocol/client";
import { parseChallengeHeader } from "@mcpjam/sdk";
import { authChallengeHint, normalizeCliError } from "../src/lib/output.js";

function http401(header: string | undefined, message = "Error POSTing to endpoint (HTTP 401)") {
  return Object.assign(new Error(message), {
    status: 401,
    data: { status: 401, authChallenge: parseChallengeHeader(header) },
  });
}

test("a 401 challenge is AUTH_REQUIRED, with the challenge and a sign-in hint", () => {
  const error = normalizeCliError(
    http401(
      'Bearer error="invalid_token", resource_metadata="https://orders.example/.well-known/oauth-protected-resource/mcp", scope="orders:read"',
    ),
  );
  assert.equal(error.code, "AUTH_REQUIRED");
  assert.equal(error.exitCode, 1);
  const details = error.details as {
    challenge: { requiredScope?: string; resourceMetadataUrl?: string };
    hint: string;
  };
  assert.equal(details.challenge.requiredScope, "orders:read");
  assert.match(details.hint, /mcpjam oauth login --url <server-url> --scopes "orders:read"/);
});

test("prose that says 'connect' does not become SERVER_UNREACHABLE", () => {
  const error = normalizeCliError(
    http401(
      'Bearer error_description="Please connect your account"',
      "Error POSTing to endpoint (HTTP 401): Please connect your account",
    ),
  );
  assert.equal(error.code, "AUTH_REQUIRED");
});

test("a headerless 401 is still AUTH_REQUIRED", () => {
  const error = normalizeCliError(http401(undefined));
  assert.equal(error.code, "AUTH_REQUIRED");
  assert.equal(
    (error.details as { challenge: { facets: { challengeHeader: string } } })
      .challenge.facets.challengeHeader,
    "none",
  );
});

test("a 403 insufficient_scope step-up is INSUFFICIENT_SCOPE", () => {
  const error = normalizeCliError(
    new InsufficientScopeError({ requiredScope: "orders:write" } as never),
  );
  assert.equal(error.code, "INSUFFICIENT_SCOPE");
  assert.match(
    (error.details as { hint: string }).hint,
    /--scopes "orders:write"/,
  );
});

test("an unrelated 401 (not an MCP client error) is not told to run oauth login", () => {
  const error = normalizeCliError(
    Object.assign(new Error("MCPJam API answered HTTP 401"), { status: 401 }),
  );
  assert.equal(error.code, "INTERNAL_ERROR");
});

test("an MCP client auth failure without a challenge is AUTH_REQUIRED", () => {
  const error = normalizeCliError(
    Object.assign(new Error("Authentication failed"), {
      name: "MCPAuthError",
      statusCode: 401,
    }),
  );
  assert.equal(error.code, "AUTH_REQUIRED");
});

test("the sign-in hint never quotes a scope that could expand in a shell", () => {
  assert.match(
    authChallengeHint({ requiredScope: "orders:read profile" }),
    /--scopes "orders:read profile"/,
  );
  const hint = authChallengeHint({ requiredScope: 'x"; $(touch /tmp/pwned) "' });
  assert.match(hint, /--scopes "<scopes>"/);
  assert.doesNotMatch(hint, /\$\(/);
});
