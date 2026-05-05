import { describe, it, expect } from "vitest";
import { getClientIp } from "../client-ip.js";
import { canonicalizeClientIp } from "../guest-spend-ip.js";

function makeCtx(headers: Record<string, string>) {
  return {
    req: {
      header: (name: string) => headers[name.toLowerCase()],
    },
  } as any;
}

describe("getClientIp", () => {
  it("prefers cf-connecting-ip over x-real-ip and x-forwarded-for", () => {
    const ctx = makeCtx({
      "cf-connecting-ip": "1.2.3.4",
      "x-real-ip": "5.6.7.8",
      "x-forwarded-for": "9.10.11.12, 13.14.15.16",
    });
    expect(getClientIp(ctx)).toBe("1.2.3.4");
  });

  it("falls back to x-real-ip when cf-connecting-ip is absent", () => {
    const ctx = makeCtx({
      "x-real-ip": "5.6.7.8",
      "x-forwarded-for": "9.10.11.12",
    });
    expect(getClientIp(ctx)).toBe("5.6.7.8");
  });

  it("falls back to first x-forwarded-for entry when nothing else is set", () => {
    const ctx = makeCtx({
      "x-forwarded-for": "9.10.11.12, 13.14.15.16",
    });
    expect(getClientIp(ctx)).toBe("9.10.11.12");
  });

  it("returns null when no headers are present", () => {
    expect(getClientIp(makeCtx({}))).toBe(null);
  });

  it("trims whitespace", () => {
    const ctx = makeCtx({ "cf-connecting-ip": "  1.2.3.4  " });
    expect(getClientIp(ctx)).toBe("1.2.3.4");
  });
});

describe("canonicalizeClientIp", () => {
  it("collapses ::ffff:1.2.3.4 to 1.2.3.4 (mapped-v4)", () => {
    expect(canonicalizeClientIp("::ffff:1.2.3.4")).toBe("1.2.3.4");
  });

  it("preserves plain IPv4", () => {
    expect(canonicalizeClientIp("203.0.113.10")).toBe("203.0.113.10");
  });

  it("strips brackets and lowercases plain IPv6", () => {
    const out = canonicalizeClientIp("::1");
    expect(out).toBe("::1");
  });

  it("lowercases mixed-case IPv6", () => {
    const out = canonicalizeClientIp("2001:DB8::1");
    expect(out?.toLowerCase()).toBe(out);
    expect(out).toContain("2001:db8");
  });

  it("hashes the same client identically whether seen as IPv4 or IPv4-mapped IPv6", () => {
    expect(canonicalizeClientIp("1.2.3.4")).toBe(
      canonicalizeClientIp("::ffff:1.2.3.4")
    );
  });

  it("returns null for non-IP strings", () => {
    expect(canonicalizeClientIp("not-an-ip")).toBe(null);
    expect(canonicalizeClientIp("")).toBe(null);
  });

  it("trims whitespace before canonicalization", () => {
    expect(canonicalizeClientIp("  1.2.3.4  ")).toBe("1.2.3.4");
  });
});
