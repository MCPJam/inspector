/**
 * Classifying a declared `_meta.ui.domain` against the origin MCPJam serves.
 *
 * The stakes are in the copy this drives: a mismatch tells a developer their
 * API-key or OAuth allowlist will not match requests from MCPJam. Calling a
 * match a mismatch (or vice versa) sends them to edit the wrong allowlist.
 */
import { describe, it, expect } from "vitest";
import { classifyDeclaredDomain } from "../origin-finding";

const ORIGIN = "https://sandbox.mcpjam.com";

describe("classifyDeclaredDomain", () => {
  it("returns nothing when the server declared no domain", () => {
    // The overwhelmingly common case — the card must not render.
    expect(classifyDeclaredDomain(undefined, ORIGIN)).toBeNull();
    expect(classifyDeclaredDomain(null, ORIGIN)).toBeNull();
    expect(classifyDeclaredDomain("", ORIGIN)).toBeNull();
  });

  it("matches a declaration equal to the served host", () => {
    expect(classifyDeclaredDomain("sandbox.mcpjam.com", ORIGIN)).toBe("match");
  });

  it("compares hosts case-insensitively and ignores surrounding space", () => {
    expect(classifyDeclaredDomain("  Sandbox.McpJam.Com  ", ORIGIN)).toBe(
      "match",
    );
  });

  it("reports a mismatch for another host's domain", () => {
    // The normal state for a server already shipping to Claude or ChatGPT.
    expect(
      classifyDeclaredDomain("abc123def456.claudemcpcontent.com", ORIGIN),
    ).toBe("mismatch");
    expect(
      classifyDeclaredDomain("my-app.web-sandbox.oaiusercontent.com", ORIGIN),
    ).toBe("mismatch");
  });

  it("does not treat a suffix as a match", () => {
    expect(classifyDeclaredDomain("evil-sandbox.mcpjam.com", ORIGIN)).toBe(
      "mismatch",
    );
    expect(classifyDeclaredDomain("mcpjam.com", ORIGIN)).toBe("mismatch");
  });

  it("flags anything that is not a bare hostname", () => {
    // The mistakes that actually get made: a URL, a path, a port.
    expect(classifyDeclaredDomain("https://sandbox.mcpjam.com", ORIGIN)).toBe(
      "malformed",
    );
    expect(classifyDeclaredDomain("sandbox.mcpjam.com/widget", ORIGIN)).toBe(
      "malformed",
    );
    expect(classifyDeclaredDomain("sandbox.mcpjam.com:443", ORIGIN)).toBe(
      "malformed",
    );
    expect(classifyDeclaredDomain("*.mcpjam.com", ORIGIN)).toBe("malformed");
  });

  it("checks the shape before the comparison", () => {
    // A malformed value is malformed regardless of what we serve, and saying
    // "does not match" would send the developer to fix the wrong thing.
    expect(
      classifyDeclaredDomain("https://sandbox.mcpjam.com", undefined),
    ).toBe("malformed");
  });

  it("treats an unknown assigned origin as a mismatch, not a match", () => {
    // Before the proxy reports its mount there is nothing to match against;
    // claiming a match would be an unearned reassurance.
    expect(classifyDeclaredDomain("sandbox.mcpjam.com", undefined)).toBe(
      "mismatch",
    );
    expect(classifyDeclaredDomain("sandbox.mcpjam.com", "not-a-url")).toBe(
      "mismatch",
    );
  });
});
