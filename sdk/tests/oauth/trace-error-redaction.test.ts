/**
 * The one error-string redactor, owned by the SDK.
 *
 * These cases arrived with the OAuth debugger's `sanitizeStepError`, which is
 * now `sanitizeTraceErrorMessage` here: the client's copy became a re-export
 * so the inspector and the SDK cannot drift on what counts as a secret in
 * free-form text. The SDK's own previous implementation was a naive subset that
 * mangled "Bearer token is expired"; that case is pinned below.
 */

import { sanitizeTraceErrorMessage } from "../../src/oauth/state-machines/trace-redaction.js";

describe("sanitizeTraceErrorMessage", () => {
  it("strips userinfo out of URLs the server under test echoed back", () => {
    // error_description is whatever the server chose to return, and the
    // debugger is routinely pointed at half-built servers.
    expect(
      sanitizeTraceErrorMessage("failed: https://user:s3cret@example.test/token"),
    ).toBe("failed: https://[redacted]@example.test/token");
  });

  it("redacts userinfo through the LAST @ of the authority", () => {
    // `@` is legal inside a password, so browser URL parsing treats
    // `user:secret@part` as the whole userinfo here. Stopping at the first
    // `@` would report half of it.
    const out = sanitizeTraceErrorMessage("POST https://user:secret@part@example.test/token");
    expect(out).not.toContain("part");
    expect(out).toBe("POST https://[redacted]@example.test/token");
  });

  it("redacts bare user:pass@host with no scheme", () => {
    expect(sanitizeTraceErrorMessage("connect failed for admin:hunter2@example.test")).toBe(
      "connect failed for [redacted]@example.test",
    );
  });

  it("redacts credential query parameters by name", () => {
    const out = sanitizeTraceErrorMessage(
      "POST /token?client_secret=abc123&code=xyz789&grant_type=authorization_code failed",
    );
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("xyz789");
    // The parameter NAME is the diagnostic and is preserved; so is anything
    // that is not credential-shaped.
    expect(out).toContain("client_secret=[redacted]");
    expect(out).toContain("grant_type=authorization_code");
  });

  it("redacts Authorization bearer and basic values", () => {
    expect(
      sanitizeTraceErrorMessage("upstream said: Authorization: Bearer eyJhbGciOi.J9.sig"),
    ).toContain("Bearer [redacted]");
    expect(sanitizeTraceErrorMessage("Authorization: Basic dXNlcjpwYXNz")).toContain(
      "Basic [redacted]",
    );
  });

  it("redacts JSON credential fields", () => {
    const out = sanitizeTraceErrorMessage('{"client_secret": "s3cret", "iss": "https://a.test"}');
    expect(out).not.toContain("s3cret");
    expect(out).toContain('"client_secret": "[redacted]"');
    expect(out).toContain("https://a.test");
  });

  it("redacts vendor-prefixed JSON credential fields", () => {
    const out = sanitizeTraceErrorMessage(
      '{"user_access_token":"vendor-secret","error":"invalid_token"}',
    );
    expect(out).not.toContain("vendor-secret");
    expect(out).toContain('"user_access_token":"[redacted]"');
    expect(out).toContain('"error":"invalid_token"');
  });

  it("keeps an escaped quote inside a JSON credential value redacted", () => {
    // `[^"]*` would treat the escaped quote as the end of the string and
    // leave the secret's tail in the report.
    const out = sanitizeTraceErrorMessage(String.raw`{"client_secret":"abc\"def"}`);
    expect(out).not.toContain("def");
    expect(out).toContain('"client_secret":"[redacted]"');
  });

  it("keeps the diagnostic word after a bare Bearer/basic mention", () => {
    // "Bearer token is expired" is a real, common error_description. A naive
    // `bearer\s+\w+` redactor eats the word that says WHAT went wrong.
    expect(sanitizeTraceErrorMessage("Bearer token is expired")).toBe(
      "Bearer token is expired",
    );
    expect(sanitizeTraceErrorMessage("the basic flow worked")).toBe(
      "the basic flow worked",
    );
    // …but a credential-shaped value is still redacted without a header.
    expect(sanitizeTraceErrorMessage("got Bearer eyJhbGciOi.J9.sig back")).toContain(
      "Bearer [redacted]",
    );
  });

  it("does not emit a raw credential prefix when the input cap splits one", () => {
    // A long redactable run SHRINKS under redaction, pulling content from
    // beyond the 500-char report bound into view — so a JSON secret left
    // unterminated by the 4000-char scan bound really can surface.
    const out = sanitizeTraceErrorMessage(
      `access_token=${"A".repeat(3960)}{"client_secret":"SUPERSECRETVALUE"}`,
    );
    expect(out).not.toContain("SUPERSECR");
    expect(out).toContain("access_token=[redacted]");
    expect(out).toContain('"client_secret":"[redacted]');
  });

  it("redacts a truncated JSON credential that contains an escaped quote", () => {
    // The tail guard has to be escape-aware too: `[^"]*$` stops at the
    // escaped quote, and the long redactable prefix shrinks enough to pull
    // the exposed suffix inside the 500-char report.
    const out = sanitizeTraceErrorMessage(
      `access_token=${"A".repeat(3960)}` +
        String.raw`{"client_secret":"abc\"SUPERSECRET"}`,
    );
    expect(out).not.toContain("SUPE");
    expect(out).toContain('"client_secret":"[redacted]');
  });

  it("caps pathological lengths", () => {
    expect(sanitizeTraceErrorMessage("x".repeat(5000))).toHaveLength(500);
  });

  it("leaves an ordinary message alone", () => {
    expect(sanitizeTraceErrorMessage("token exchange failed: 401")).toBe(
      "token exchange failed: 401",
    );
  });

  it("redacts colon-delimited credential fields", () => {
    // An `error_description` is prose, not a query string, so a server that
    // echoes request context back writes `access_token: <value>` at least as
    // often as `access_token=<value>`. Redacting only the `=` form leaves the
    // credential in persisted traces and copied error details.
    for (const input of [
      "rejected: access_token: SUPERSECRETVALUE",
      "client_secret = SUPERSECRETVALUE",
      "clientSecret: SUPERSECRETVALUE",
      'access_token: "SUPERSECRETVALUE"',
      "user_refresh_token: SUPERSECRETVALUE",
    ]) {
      expect(sanitizeTraceErrorMessage(input), input).not.toContain(
        "SUPERSECRETVALUE",
      );
    }
  });

  it("keeps ambiguous names readable after a colon", () => {
    // The colon form is restricted to names that can only be credentials.
    // `code`, `token` and `state` are ordinary English in an error string,
    // and `status code: 401` must not become `status code: [redacted]`.
    expect(sanitizeTraceErrorMessage("status code: 401")).toBe(
      "status code: 401",
    );
    expect(sanitizeTraceErrorMessage("state: mismatched")).toBe(
      "state: mismatched",
    );
  });

  it("redacts short opaque bearer and basic credentials", () => {
    // `Basic dXNlcjpwYXNz` is a valid credential and carries no base64url
    // punctuation, so a rule keyed on punctuation-or-length misses it.
    expect(sanitizeTraceErrorMessage("got Basic dXNlcjpwYXNz back")).toBe(
      "got Basic [redacted] back",
    );
    expect(sanitizeTraceErrorMessage("sent Bearer YWJjZGVm")).toBe(
      "sent Bearer [redacted]",
    );
    // Still not at the cost of the diagnostic vocabulary.
    expect(sanitizeTraceErrorMessage("Bearer token is expired.")).toBe(
      "Bearer token is expired.",
    );
  });
});
