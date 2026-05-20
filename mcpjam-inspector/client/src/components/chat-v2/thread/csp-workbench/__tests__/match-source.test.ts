/**
 * Unit tests for matchesSourceExpression — the helper the classifier
 * leans on. Each row of the source-expression spec gets a fixture so
 * regressions are caught before the UI confidently recommends the
 * wrong patch.
 */

import { describe, it, expect } from "vitest";
import {
  matchesSourceExpression,
  originAllowedByAny,
  extractOrigin,
} from "../match-source";

describe("matchesSourceExpression — exact origins", () => {
  it("matches identical scheme + host + default port", () => {
    expect(
      matchesSourceExpression(
        "https://api.example.com/v1/x",
        "https://api.example.com",
      ),
    ).toBe(true);
  });

  it("does NOT match different host", () => {
    expect(
      matchesSourceExpression("https://api.example.com", "https://example.com"),
    ).toBe(false);
  });

  it("does NOT match different scheme", () => {
    expect(
      matchesSourceExpression("http://api.example.com", "https://api.example.com"),
    ).toBe(false);
  });

  it("is case-insensitive on host", () => {
    expect(
      matchesSourceExpression(
        "https://API.example.com/path",
        "https://api.EXAMPLE.com",
      ),
    ).toBe(true);
  });
});

describe("matchesSourceExpression — wildcard host", () => {
  it("matches single subdomain", () => {
    expect(
      matchesSourceExpression(
        "https://api.example.com",
        "https://*.example.com",
      ),
    ).toBe(true);
  });

  it("matches deeper subdomain", () => {
    expect(
      matchesSourceExpression(
        "https://x.y.example.com",
        "https://*.example.com",
      ),
    ).toBe(true);
  });

  it("does NOT match bare apex (per CSP spec)", () => {
    expect(
      matchesSourceExpression("https://example.com", "https://*.example.com"),
    ).toBe(false);
  });

  it("bare * matches any host", () => {
    expect(matchesSourceExpression("https://anything.example", "*")).toBe(true);
  });
});

describe("matchesSourceExpression — scheme-only and scheme-literal", () => {
  it("scheme-only matches any host on that scheme", () => {
    expect(matchesSourceExpression("https://api.example.com", "https:")).toBe(
      true,
    );
    expect(matchesSourceExpression("http://api.example.com", "https:")).toBe(
      false,
    );
  });

  it("data: scheme literal matches data URIs", () => {
    expect(matchesSourceExpression("data:text/plain,hi", "data:")).toBe(true);
  });

  it("blob: scheme literal matches blob URLs", () => {
    expect(matchesSourceExpression("blob:https://x.com/abc", "blob:")).toBe(
      true,
    );
  });
});

describe("matchesSourceExpression — keywords", () => {
  it("'self' does not match any URL origin", () => {
    expect(
      matchesSourceExpression("https://api.example.com", "'self'"),
    ).toBe(false);
  });

  it("'unsafe-inline' does not match any URL origin", () => {
    expect(
      matchesSourceExpression("https://api.example.com", "'unsafe-inline'"),
    ).toBe(false);
  });

  it("nonces and hashes do not match URL origins", () => {
    expect(
      matchesSourceExpression("https://api.example.com", "'nonce-abc123'"),
    ).toBe(false);
    expect(
      matchesSourceExpression(
        "https://api.example.com",
        "'sha256-XXXXXXXXX'",
      ),
    ).toBe(false);
  });

  it("'none' does not match anything", () => {
    expect(matchesSourceExpression("https://api.example.com", "'none'")).toBe(
      false,
    );
  });
});

describe("matchesSourceExpression — port handling", () => {
  it("explicit port must match", () => {
    expect(
      matchesSourceExpression(
        "https://api.example.com:8443/x",
        "https://api.example.com:8443",
      ),
    ).toBe(true);
    expect(
      matchesSourceExpression(
        "https://api.example.com:8443",
        "https://api.example.com:443",
      ),
    ).toBe(false);
  });

  it("default port treated as default", () => {
    expect(
      matchesSourceExpression(
        "https://api.example.com",
        "https://api.example.com:443",
      ),
    ).toBe(true);
  });

  it("port wildcard matches any port", () => {
    expect(
      matchesSourceExpression(
        "https://api.example.com:9999",
        "https://api.example.com:*",
      ),
    ).toBe(true);
  });
});

describe("matchesSourceExpression — path is ignored beyond host", () => {
  it("path on the URL doesn't break the match", () => {
    expect(
      matchesSourceExpression(
        "https://api.example.com/very/deep/path?q=1",
        "https://api.example.com",
      ),
    ).toBe(true);
  });

  it("path on the expression is stripped before matching", () => {
    expect(
      matchesSourceExpression(
        "https://api.example.com/v1/x",
        "https://api.example.com/v1/",
      ),
    ).toBe(true);
  });
});

describe("matchesSourceExpression — malformed inputs", () => {
  it("returns false on empty expression", () => {
    expect(matchesSourceExpression("https://api.example.com", "")).toBe(false);
  });

  it("returns false on empty URL", () => {
    expect(matchesSourceExpression("", "https://api.example.com")).toBe(false);
  });

  it("returns false on garbage URL", () => {
    expect(
      matchesSourceExpression("not-a-url", "https://api.example.com"),
    ).toBe(false);
  });

  it("returns false on keyword-like blockedUri tokens", () => {
    expect(matchesSourceExpression("inline", "https://api.example.com")).toBe(
      false,
    );
    expect(matchesSourceExpression("eval", "https://api.example.com")).toBe(
      false,
    );
  });
});

describe("originAllowedByAny", () => {
  it("returns true when any expression matches", () => {
    expect(
      originAllowedByAny("https://api.example.com", [
        "https://other.com",
        "https://*.example.com",
      ]),
    ).toBe(true);
  });

  it("returns false on empty list", () => {
    expect(originAllowedByAny("https://api.example.com", [])).toBe(false);
    expect(originAllowedByAny("https://api.example.com", undefined)).toBe(false);
  });
});

describe("extractOrigin", () => {
  it("extracts origin from URL with path", () => {
    expect(extractOrigin("https://api.example.com/v1/x?a=1")).toBe(
      "https://api.example.com",
    );
  });

  it("keeps non-default port", () => {
    expect(extractOrigin("https://api.example.com:8443/x")).toBe(
      "https://api.example.com:8443",
    );
  });

  it("drops default port", () => {
    expect(extractOrigin("https://api.example.com:443/x")).toBe(
      "https://api.example.com",
    );
  });

  it("returns null for keyword tokens", () => {
    expect(extractOrigin("inline")).toBeNull();
    expect(extractOrigin("eval")).toBeNull();
    expect(extractOrigin("")).toBeNull();
  });
});
