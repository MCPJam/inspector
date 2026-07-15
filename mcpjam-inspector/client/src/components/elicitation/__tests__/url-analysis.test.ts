import { describe, expect, it } from "vitest";
import {
  analyzeElicitationUrl,
  splitUrlForDisplay,
} from "../url-analysis";

describe("analyzeElicitationUrl", () => {
  it("accepts a plain https url with no warnings", () => {
    const result = analyzeElicitationUrl("https://example.com/connect?x=1");
    expect(result.blocked).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.parsed?.host).toBe("example.com");
  });

  it("blocks schemes that are not a web page", () => {
    // Handing any of these to window.open is dangerous, and none is a
    // legitimate "go here and finish this" target.
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<h1>hi</h1>",
      "file:///etc/passwd",
    ]) {
      expect(analyzeElicitationUrl(url).blocked).toBe(true);
    }
  });

  it("blocks an unparseable url", () => {
    const result = analyzeElicitationUrl("not a url at all");
    expect(result.blocked).toBe(true);
    expect(result.parsed).toBeNull();
  });

  it("warns on punycode, whether sent as ascii or as unicode glyphs", () => {
    // Both spellings must trip the warning: a server can send either, and the
    // URL parser normalizes unicode INTO the xn-- form.
    for (const url of [
      "https://xn--80ak6aa92e.com/login",
      "https://\u0430pple.com/login", // Cyrillic а — looks exactly like "apple.com"
    ]) {
      const result = analyzeElicitationUrl(url);
      expect(result.blocked).toBe(false);
      expect(result.warnings).toContain("punycode");
      // We render the ascii form: it's the non-spoofable representation.
      expect(result.parsed?.hostname.startsWith("xn--")).toBe(true);
    }
  });

  it("warns on http", () => {
    expect(analyzeElicitationUrl("http://example.com").warnings).toContain(
      "insecure-scheme",
    );
  });

  it("warns on embedded credentials", () => {
    // https://example.com@evil.test reads as "example.com" at a glance.
    const result = analyzeElicitationUrl("https://example.com@evil.test/x");
    expect(result.warnings).toContain("embedded-credentials");
    expect(result.parsed?.host).toBe("evil.test");
  });

  it("warns on a raw IP host", () => {
    expect(analyzeElicitationUrl("https://192.168.1.1/x").warnings).toContain(
      "ip-host",
    );
  });

  it("does not flag a hostname that merely contains 'xn--' mid-label", () => {
    expect(
      analyzeElicitationUrl("https://myxn--thing.com/x").warnings,
    ).not.toContain("punycode");
  });
});

describe("splitUrlForDisplay", () => {
  it("isolates the host so it can be emphasized against the rest", () => {
    const parsed = new URL("https://evil.test/login?next=https://example.com");
    expect(splitUrlForDisplay(parsed)).toEqual({
      origin: "https://",
      host: "evil.test",
      rest: "/login?next=https://example.com",
    });
  });
});
