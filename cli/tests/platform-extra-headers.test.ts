/**
 * `--api-header` / `MCPJAM_API_HEADERS` — the flag that lets the CLI reach a
 * deployment behind Cloudflare Access, a WAF, or a corporate proxy.
 *
 * The parsing tests matter less than the refusals. A header flag that can set
 * `authorization` is a way to smuggle a credential past the per-deployment
 * token rules in `platform-client`, and one that accepts a line break is header
 * injection. Both are rejected here, by name, so the failure teaches.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { CliError } from "../src/lib/output.js";
import { resolvePlatformExtraHeaders } from "../src/lib/platform-client.js";

const rejects = (
  fn: () => unknown,
  contains: string,
  message: string
): void => {
  assert.throws(
    fn,
    (error: unknown) => {
      assert.ok(error instanceof CliError, `${message}: not a CliError`);
      assert.match(String((error as CliError).message), new RegExp(contains));
      return true;
    },
    message
  );
};

test("parses repeatable flags into lower-cased names", () => {
  assert.deepEqual(
    resolvePlatformExtraHeaders(
      { apiHeader: ["CF-Access-Client-Id: abc", "CF-Access-Client-Secret: xyz"] },
      {}
    ),
    { "cf-access-client-id": "abc", "cf-access-client-secret": "xyz" }
  );
});

test("splits on the FIRST colon so values may contain colons", () => {
  assert.deepEqual(
    resolvePlatformExtraHeaders(
      { apiHeader: ["X-Origin: https://staging.example.com:8443/path"] },
      {}
    ),
    { "x-origin": "https://staging.example.com:8443/path" }
  );
});

test("reads MCPJAM_API_HEADERS, one header per line, ignoring blanks", () => {
  assert.deepEqual(
    resolvePlatformExtraHeaders(
      {},
      { MCPJAM_API_HEADERS: "CF-Access-Client-Id: abc\n\nX-Extra: 1\n" }
    ),
    { "cf-access-client-id": "abc", "x-extra": "1" }
  );
});

test("combines env and flag, and the flag wins a collision", () => {
  // CI supplies the machine credential through the environment; a developer
  // adds one more header on the command line. Needing both is the normal case.
  assert.deepEqual(
    resolvePlatformExtraHeaders(
      { apiHeader: ["X-Shared: from-flag", "X-Only-Flag: 1"] },
      { MCPJAM_API_HEADERS: "X-Shared: from-env\nX-Only-Env: 1" }
    ),
    { "x-shared": "from-flag", "x-only-flag": "1", "x-only-env": "1" }
  );
});

test("is undefined when neither source supplies anything", () => {
  assert.equal(resolvePlatformExtraHeaders({}, {}), undefined);
  assert.equal(
    resolvePlatformExtraHeaders({ apiHeader: [] }, { MCPJAM_API_HEADERS: "  " }),
    undefined
  );
});

test("refuses to set the credential, in any casing, from either source", () => {
  for (const name of ["authorization", "Authorization", "AUTHORIZATION"]) {
    rejects(
      () => resolvePlatformExtraHeaders({ apiHeader: [`${name}: Bearer sk_x`] }, {}),
      "cannot set",
      `flag accepted ${name}`
    );
    rejects(
      () =>
        resolvePlatformExtraHeaders({}, { MCPJAM_API_HEADERS: `${name}: Bearer sk_x` }),
      "cannot set",
      `env accepted ${name}`
    );
  }
});

test("refuses the other headers the client derives for itself", () => {
  for (const name of ["Idempotency-Key", "Content-Type"]) {
    rejects(
      () => resolvePlatformExtraHeaders({ apiHeader: [`${name}: x`] }, {}),
      "cannot set",
      `accepted ${name}`
    );
  }
});

test("refuses a line break in a value (header injection)", () => {
  rejects(
    () =>
      resolvePlatformExtraHeaders(
        { apiHeader: ["X-A: one\r\nAuthorization: Bearer sk_x"] },
        {}
      ),
    "line break",
    "accepted CRLF"
  );
});

test("refuses malformed headers with a message naming the source", () => {
  rejects(
    () => resolvePlatformExtraHeaders({ apiHeader: ["no-colon-here"] }, {}),
    "--api-header",
    "accepted a header with no colon"
  );
  rejects(
    () => resolvePlatformExtraHeaders({}, { MCPJAM_API_HEADERS: "bad header: v" }),
    "MCPJAM_API_HEADERS",
    "accepted a space in the name"
  );
  rejects(
    () => resolvePlatformExtraHeaders({ apiHeader: ["X-Empty:   "] }, {}),
    "empty value",
    "accepted an empty value"
  );
  rejects(
    () => resolvePlatformExtraHeaders({ apiHeader: [": novalue"] }, {}),
    "Name: value",
    "accepted an empty name"
  );
});
