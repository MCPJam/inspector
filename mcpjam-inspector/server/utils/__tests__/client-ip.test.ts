import { describe, it, expect, afterEach, vi } from "vitest";
import { getClientIp, getAttestedClientIp, getSpendClientIp } from "../client-ip.js";
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

  it("returns null when no headers are present and no socket info is available (test-mock context)", () => {
    expect(getClientIp(makeCtx({}))).toBe(null);
  });

  it("trims whitespace", () => {
    const ctx = makeCtx({ "cf-connecting-ip": "  1.2.3.4  " });
    expect(getClientIp(ctx)).toBe("1.2.3.4");
  });

  it("falls back to the socket peer address when no proxy headers are present (npx-style direct hit)", () => {
    // Shape that @hono/node-server's getConnInfo reads: c.env.incoming.socket.
    // Covers the `npx @mcpjam/inspector` case where the browser hits the
    // server directly with no proxy injecting forwarded-for headers.
    const ctx = {
      req: { header: (_name: string) => undefined },
      env: {
        incoming: {
          socket: { remoteAddress: "::1", remotePort: 12345, remoteFamily: "IPv6" },
        },
      },
    } as any;
    expect(getClientIp(ctx)).toBe("::1");
  });

  it("prefers proxy headers over the socket peer address when both are present", () => {
    // Hosted prod must keep using the proxy-supplied client IP even when the
    // adapter-level socket info is available — otherwise rate limiting would
    // bucket every request on the proxy's loopback address.
    const ctx = {
      req: {
        header: (name: string) =>
          ({ "cf-connecting-ip": "203.0.113.10" } as Record<string, string>)[
            name.toLowerCase()
          ],
      },
      env: {
        incoming: {
          socket: { remoteAddress: "::1", remotePort: 12345, remoteFamily: "IPv6" },
        },
      },
    } as any;
    expect(getClientIp(ctx)).toBe("203.0.113.10");
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


describe("hosted IP attestation", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("pools forged Cloudflare headers, accepts the edge secret, and supports rotation", () => {
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
    vi.stubEnv("MCPJAM_EDGE_SECRET", "current-secret");
    vi.stubEnv("MCPJAM_EDGE_SECRET_PREVIOUS", "previous-secret");
    expect(getAttestedClientIp(makeCtx({ "cf-connecting-ip": "1.2.3.4" }))).toBeNull();
    for (const secret of ["current-secret", "previous-secret"]) {
      expect(getAttestedClientIp(makeCtx({ "cf-connecting-ip": "1.2.3.4", "x-mcpjam-edge-secret": secret }))).toBe("1.2.3.4");
    }
    expect(getAttestedClientIp(makeCtx({ "cf-connecting-ip": "1.2.3.4", "x-mcpjam-edge-secret": "forged" }))).toBeNull();
  });
});


it("keeps legacy spend IP behavior until attestation is configured", () => {
  vi.stubEnv("MCPJAM_EDGE_SECRET", "");
  vi.stubEnv("MCPJAM_EDGE_SECRET_PREVIOUS", "");
  expect(getSpendClientIp(makeCtx({ "x-real-ip": "203.0.113.10" }))).toBe("203.0.113.10");
  vi.stubEnv("MCPJAM_EDGE_SECRET", "configured");
  expect(getSpendClientIp(makeCtx({ "x-real-ip": "203.0.113.10" }))).toBeNull();
  vi.unstubAllEnvs();
});
