import assert from "node:assert/strict";
import test from "node:test";
import { OAuthProxyError } from "../../mcpjam-inspector/server/utils/oauth-proxy";
import {
  mapOAuthProxyError,
  parseProxyBody,
} from "../src/commands/oauth";
import { CliError } from "../src/lib/output";

test("parseProxyBody parses JSON values and preserves raw strings", () => {
  assert.deepEqual(parseProxyBody('{"client_id":"abc"}'), {
    client_id: "abc",
  });
  assert.equal(parseProxyBody("grant_type=client_credentials"), "grant_type=client_credentials");
  assert.equal(parseProxyBody(undefined), undefined);
});

test("mapOAuthProxyError converts status codes to CLI error codes", () => {
  const error = mapOAuthProxyError(
    new OAuthProxyError(504, "Timed out talking to upstream"),
  );

  assert.ok(error instanceof CliError);
  assert.equal(error.code, "TIMEOUT");
  assert.equal(error.message, "Timed out talking to upstream");
});
