/**
 * What a credential looks like, and what ordinary page text looks like.
 *
 * Both halves matter equally and the second is the harder one. This runs over
 * console lines, daemon errors and network failures on their way into a
 * model's context — text nobody reads for its content — and a pattern that
 * over-matches there is not free: it puts `[redacted]` in front of a model that
 * is trying to understand why a page failed.
 */
import { describe, expect, it } from "vitest";
import {
  redactSecretShapes,
  secretParamLike,
  tokenLike,
} from "../secret-shape-redaction";

describe("redactSecretShapes", () => {
  it("redacts a Bearer token in a console line", () => {
    // The shape a page's own SDK logs when it refreshes a session.
    expect(
      redactSecretShapes(
        "GET /me 401 (Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abc)",
      ),
    ).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
  });

  it("redacts an ?api_key= inside a Playwright error", () => {
    // THE ONE THAT EARNS ITS PLACE. No key-based rule can see this: there is
    // no key, it is a substring of a sentence, and upstream errors quote whole
    // URLs as a matter of course.
    const scrubbed = redactSecretShapes(
      "page.goto: net::ERR_ABORTED at https://api.example.com/v1/me?api_key=sk-live-9f2ab3c4d5e6f7g8&page=2",
    );
    expect(scrubbed).not.toContain("sk-live-9f2ab3c4d5e6f7g8");
    expect(scrubbed).toContain("api_key=[redacted]");
    // And stops at the separator, so the rest of the URL survives — a model
    // debugging a failed request needs to see which endpoint it was.
    expect(scrubbed).toContain("https://api.example.com/v1/me");
    expect(scrubbed).toContain("page=2");
  });

  it("redacts a whole Authorization header, whatever the scheme", () => {
    // `Basic dXNlcjpwYXNz` used to lose only the word "Basic": the narrower
    // patterns nibbled at it and left the credential behind.
    const scrubbed = redactSecretShapes("Authorization: Basic dXNlcjpwYXNz");
    expect(scrubbed).not.toContain("dXNlcjpwYXNz");
  });

  it("redacts basic-auth credentials in a URL", () => {
    expect(
      redactSecretShapes("connect https://admin:hunter2@internal.test/health"),
    ).not.toContain("hunter2");
  });

  it("redacts a bare sk- key", () => {
    expect(
      redactSecretShapes("invalid key sk-proj-AAAAAAAAAAAAAAAAAAAA"),
    ).not.toContain("sk-proj-AAAAAAAAAAAAAAAAAAAA");
  });

  it("leaves ordinary page text untouched, byte for byte", () => {
    // The half that decides whether this can be ON by default. A model reading
    // a failed page has to be able to read the failure.
    for (const text of [
      "Uncaught TypeError: Cannot read properties of null (reading 'value')",
      "Failed to load resource: the server responded with a status of 404 ()",
      "net::ERR_NAME_NOT_RESOLVED at https://shop.example.com/cart?page=2&sort=price",
      "React does not recognize the `defaultValue` prop on a DOM element",
      "Sign in to your account",
      "",
    ]) {
      expect(redactSecretShapes(text)).toBe(text);
    }
  });

  it("does NOT redact an email address", () => {
    // The log scrubber does, because a log is a different artifact with
    // different rules. A model filling in a form has to see the address the
    // form is about.
    const text = "signup failed for alex@example.com";
    expect(redactSecretShapes(text)).toBe(text);
  });

  it("takes a replacement, so a caller can say what it put there", () => {
    expect(
      redactSecretShapes("?token=abc123def456", "{{secret:NAME}}"),
    ).toContain("token={{secret:NAME}}");
  });

  it("is idempotent, because two layers apply it", () => {
    // The daemon scrubs, and the server scrubs again for daemons older than
    // the daemon-side scrub. A second pass must be a no-op.
    const once = redactSecretShapes("https://x.test/?api_key=abcdef123456");
    expect(redactSecretShapes(once)).toBe(once);
  });
});

describe("the patterns are FACTORIES, not shared instances", () => {
  it("mints a fresh regex per call, so `lastIndex` cannot leak", () => {
    // Every one of these carries `g`, and a global regex is stateful: a shared
    // instance's `lastIndex` survives between calls and silently skips the
    // FIRST match of every other string it is given. Invisible in a test that
    // redacts once; catastrophic over a hundred console lines.
    const shared = tokenLike();
    expect(shared.test("Bearer aaaa")).toBe(true);
    expect(shared.test("Bearer bbbb")).toBe(false); // the bug, demonstrated
    expect(tokenLike().test("Bearer aaaa")).toBe(true);
    expect(tokenLike().test("Bearer bbbb")).toBe(true);
    expect(secretParamLike()).not.toBe(secretParamLike());
  });

  it("redacts every occurrence in one string", () => {
    const scrubbed = redactSecretShapes(
      "first ?api_key=aaaaaaaaaa then ?api_key=bbbbbbbbbb",
    );
    expect(scrubbed).not.toContain("aaaaaaaaaa");
    expect(scrubbed).not.toContain("bbbbbbbbbb");
  });

  it("redacts every line of a multi-line message", () => {
    const scrubbed = redactSecretShapes(
      ["GET /a?token=aaaaaaaaaa", "GET /b?token=bbbbbbbbbb"].join("\n"),
    );
    expect(scrubbed).not.toContain("aaaaaaaaaa");
    expect(scrubbed).not.toContain("bbbbbbbbbb");
  });
});
