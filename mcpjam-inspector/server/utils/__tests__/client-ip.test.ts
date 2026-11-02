import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  getClientIp,
  getAttestedClientIp,
  getSpendClientIp,
  ipRateLimitKey,
  resolveTrustedClientIpHeader,
} from "../client-ip.js";
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


describe("ipRateLimitKey", () => {
  it("keys IPv4 as it is", () => {
    expect(ipRateLimitKey("203.0.113.10")).toBe("203.0.113.10");
    expect(ipRateLimitKey("  203.0.113.10 ")).toBe("203.0.113.10");
  });

  it("keys IPv6 by its /64 prefix", () => {
    const key = ipRateLimitKey("2001:db8:1:2::1");
    expect(key).toBe("2001:db8:1:2::/64");
    for (const address of [
      "2001:db8:1:2:ffff:ffff:ffff:ffff",
      "2001:0DB8:0001:0002:0000:0000:0000:0009",
      "2001:db8:1:2:a:b:c:d",
      "2001:db8:1:2:a:b:1.2.3.4",
      "2001:db8:1:2::1%eth0",
    ]) {
      expect(ipRateLimitKey(address)).toBe(key);
    }
  });

  it("gives different /64s different keys", () => {
    expect(ipRateLimitKey("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
    expect(ipRateLimitKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipRateLimitKey("::1")).toBe("0:0:0:0::/64");
    expect(ipRateLimitKey("::")).toBe("0:0:0:0::/64");
    expect(ipRateLimitKey("fe80::1")).toBe("fe80:0:0:0::/64");
  });

  it("keys an IPv4-mapped IPv6 address as its IPv4 address", () => {
    expect(ipRateLimitKey("::ffff:203.0.113.10")).toBe("203.0.113.10");
    expect(ipRateLimitKey("::FFFF:203.0.113.10")).toBe("203.0.113.10");
    expect(ipRateLimitKey("::ffff:cb00:710a")).toBe("203.0.113.10");
    expect(ipRateLimitKey("0:0:0:0:0:ffff:cb00:710a")).toBe("203.0.113.10");
  });

  it("does not treat other embedded-IPv4 forms as IPv4", () => {
    expect(ipRateLimitKey("64:ff9b::203.0.113.10")).toBe("64:ff9b:0:0::/64");
    expect(ipRateLimitKey("::ffff:0:203.0.113.10")).toBe("0:0:0:0::/64");
  });

  it("returns anything that is not an IP address as it is", () => {
    expect(ipRateLimitKey("not-an-ip")).toBe("not-an-ip");
    expect(ipRateLimitKey("[::1]")).toBe("[::1]");
    expect(ipRateLimitKey("")).toBe("");
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

const TRUSTED_HEADER_ENV = "MCPJAM_TRUSTED_CLIENT_IP_HEADER";

// The TCP peer of a request that reached this server without the ingress.
const PEER = "192.0.2.50";

// A request whose socket `getConnInfo` can read.
function makePeerCtx(headers: Record<string, string>) {
  return Object.assign(makeCtx(headers), {
    env: {
      incoming: {
        socket: { remoteAddress: PEER, remotePort: 443, remoteFamily: "IPv4" },
      },
    },
  });
}

const READERS = [
  ["getClientIp", getClientIp],
  ["getAttestedClientIp", getAttestedClientIp],
  ["getSpendClientIp", getSpendClientIp],
] as const;

describe("MCPJAM_TRUSTED_CLIENT_IP_HEADER", () => {
  beforeEach(() => {
    vi.stubEnv("MCPJAM_EDGE_SECRET", "");
    vi.stubEnv("MCPJAM_EDGE_SECRET_PREVIOUS", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  describe.each([undefined, "", "   "])("unset (%j)", (value) => {
    beforeEach(() => vi.stubEnv(TRUSTED_HEADER_ENV, value));
    const cf = { "cf-connecting-ip": "203.0.113.1" };
    const realIp = { "x-real-ip": "203.0.113.2" };
    const xff = { "x-forwarded-for": "203.0.113.3, 203.0.113.4" };

    it("keeps the old getClientIp precedence", () => {
      const all = makePeerCtx({ ...cf, ...realIp, ...xff });
      expect(getClientIp(all)).toBe("203.0.113.1");
      expect(getClientIp(makePeerCtx({ ...realIp, ...xff }))).toBe(
        "203.0.113.2",
      );
      expect(getClientIp(makePeerCtx(xff))).toBe("203.0.113.3");
      expect(getClientIp(makePeerCtx({}))).toBe(PEER);
    });

    it("keeps the old getAttestedClientIp precedence", () => {
      const all = makePeerCtx({ ...cf, ...realIp, ...xff });
      expect(getAttestedClientIp(all)).toBe("203.0.113.1");
      expect(getAttestedClientIp(makePeerCtx(realIp))).toBeNull();
      expect(getAttestedClientIp(makePeerCtx(xff))).toBeNull();
      expect(getAttestedClientIp(makePeerCtx({}))).toBe(PEER);
    });

    it("keeps the old getSpendClientIp precedence", () => {
      const all = makePeerCtx({ ...cf, ...realIp });
      expect(getSpendClientIp(all)).toBe("203.0.113.1");
      expect(getSpendClientIp(makePeerCtx(realIp))).toBe("203.0.113.2");
      vi.stubEnv("MCPJAM_EDGE_SECRET", "configured");
      expect(getSpendClientIp(all)).toBeNull();
    });
  });

  describe("set", () => {
    beforeEach(() => vi.stubEnv(TRUSTED_HEADER_ENV, "x-real-ip"));

    // A client behind Traefik or ingress-nginx can send any cf-connecting-ip
    // and x-forwarded-for it likes; x-real-ip is what the ingress wrote.
    const spoofed = (i: number) => ({
      "cf-connecting-ip": `198.51.100.${i}`,
      "x-forwarded-for": `198.51.100.${i + 100}`,
      "x-real-ip": "203.0.113.7",
    });

    it.each(READERS)("%s ignores a spoofed cf-connecting-ip", (_, read) => {
      for (const i of [1, 2, 3]) {
        expect(read(makePeerCtx(spoofed(i)))).toBe("203.0.113.7");
      }
    });

    it.each(READERS)("%s ignores x-real-ip unless it is named", (_, read) => {
      vi.stubEnv(TRUSTED_HEADER_ENV, "  X-Operator-IP ");
      const ctx = makePeerCtx({
        ...spoofed(1),
        "x-real-ip": "198.51.100.200",
        "x-operator-ip": "203.0.113.8",
      });
      expect(read(ctx)).toBe("203.0.113.8");
    });

    it.each(READERS)("%s takes the last entry of a list", (_, read) => {
      vi.stubEnv(TRUSTED_HEADER_ENV, "x-forwarded-for");
      const ctx = makePeerCtx({
        "x-forwarded-for": "198.51.100.9, 10.0.0.1, 203.0.113.9",
      });
      expect(read(ctx)).toBe("203.0.113.9");
    });
  });

  describe("set, on a request without the header", () => {
    beforeEach(() => vi.stubEnv(TRUSTED_HEADER_ENV, "x-real-ip"));
    const cf = { "cf-connecting-ip": "198.51.100.1" };
    const xff = { "x-forwarded-for": "198.51.100.2" };

    it("getClientIp falls back to the TCP peer", () => {
      expect(getClientIp(makePeerCtx({ ...cf, ...xff }))).toBe(PEER);
      expect(getClientIp(makePeerCtx({}))).toBe(PEER);
      // No socket to read (a hand-rolled mock): nothing is left.
      expect(getClientIp(makeCtx({ ...cf, ...xff }))).toBeNull();
    });

    it("getAttestedClientIp takes the peer only with no forwarding header", () => {
      expect(getAttestedClientIp(makePeerCtx(cf))).toBeNull();
      expect(getAttestedClientIp(makePeerCtx(xff))).toBeNull();
      expect(getAttestedClientIp(makePeerCtx({}))).toBe(PEER);
    });

    it("getSpendClientIp falls back to the TCP peer", () => {
      expect(getSpendClientIp(makePeerCtx({ ...cf, ...xff }))).toBe(PEER);
    });

    it("never reads an earlier, client-written list entry", () => {
      vi.stubEnv(TRUSTED_HEADER_ENV, "x-forwarded-for");
      const ctx = makePeerCtx({ "x-forwarded-for": "198.51.100.9," });
      expect(getClientIp(ctx)).toBe(PEER);
      expect(getAttestedClientIp(ctx)).toBeNull();
      expect(getSpendClientIp(ctx)).toBe(PEER);
    });
  });

  describe("set together with an edge secret", () => {
    beforeEach(() => {
      vi.stubEnv(TRUSTED_HEADER_ENV, "x-real-ip");
      vi.stubEnv("MCPJAM_EDGE_SECRET", "current-secret");
      vi.stubEnv("MCPJAM_EDGE_SECRET_PREVIOUS", "previous-secret");
    });

    // Behind the edge, the ingress writes Cloudflare's address to x-real-ip.
    const viaEdge = (secret: string) =>
      makePeerCtx({
        "cf-connecting-ip": "203.0.113.20",
        "x-real-ip": "203.0.113.21",
        "x-mcpjam-edge-secret": secret,
      });
    const offEdge = {
      "cf-connecting-ip": "198.51.100.1",
      "x-real-ip": "203.0.113.22",
    };
    const withoutSecret = [
      makePeerCtx(offEdge),
      makePeerCtx({ ...offEdge, "x-mcpjam-edge-secret": "forged" }),
    ];

    it.each(READERS)(
      "%s keeps Cloudflare's address with the secret",
      (_, read) => {
        expect(read(viaEdge("current-secret"))).toBe("203.0.113.20");
        expect(read(viaEdge("previous-secret"))).toBe("203.0.113.20");
      },
    );

    it("getClientIp reads the named header without the secret", () => {
      for (const ctx of withoutSecret) {
        expect(getClientIp(ctx)).toBe("203.0.113.22");
      }
    });

    it("getAttestedClientIp and getSpendClientIp pool a request without the secret", () => {
      for (const ctx of withoutSecret) {
        expect(getAttestedClientIp(ctx)).toBeNull();
        expect(getSpendClientIp(ctx)).toBeNull();
      }
    });
  });
});

describe("resolveTrustedClientIpHeader", () => {
  afterEach(() => vi.unstubAllEnvs());
  const resolveHeader = (value: string | undefined) =>
    resolveTrustedClientIpHeader({ [TRUSTED_HEADER_ENV]: value });

  it.each([undefined, "", "   "])("reads %j as unset", (value) => {
    expect(resolveHeader(value)).toBeNull();
  });

  it("trims and lowercases one header name", () => {
    expect(resolveHeader("  X-Real-IP ")).toBe("x-real-ip");
  });

  it.each([
    "x-real-ip,x-forwarded-for",
    "x real ip",
    "x-real-ip:",
    "x-réal-ip",
  ])("refuses %j", (value) => {
    expect(() => resolveHeader(value)).toThrow(
      "MCPJAM_TRUSTED_CLIENT_IP_HEADER must be one HTTP header name such " +
        `as x-real-ip (got ${JSON.stringify(value)})`,
    );
  });

  it("refuses a bad value on first use, and reads a fixed one", () => {
    vi.stubEnv(TRUSTED_HEADER_ENV, "x-real-ip, x-forwarded-for");
    expect(() => getClientIp(makeCtx({}))).toThrow(TRUSTED_HEADER_ENV);
    expect(() => getAttestedClientIp(makeCtx({}))).toThrow(TRUSTED_HEADER_ENV);
    vi.stubEnv(TRUSTED_HEADER_ENV, "x-real-ip");
    const ctx = makeCtx({ "x-real-ip": "203.0.113.30" });
    expect(getClientIp(ctx)).toBe("203.0.113.30");
  });
});
