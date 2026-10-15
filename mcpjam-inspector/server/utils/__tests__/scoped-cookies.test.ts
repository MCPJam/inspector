import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_SCOPED_NAMESPACES,
  SCOPED_COOKIE_BYTE_BUDGET,
  WORKOS_SCOPED_COOKIE_MAX_AGE_S,
  parseScopedCookieMeta,
  planScopedCookieHeaders,
  scopedCookieName,
  sealScopedCookie,
  unsealScopedCookie,
  type ScopedCookieKind,
} from "../scoped-cookies.js";
import {
  computeLocalSessionNamespace,
  resolveBrowserPort,
  resolveLocalSessionNamespace,
} from "../local-session-namespace.js";

const SECRET = "machine-local-secret";
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 1);

function ns(i: number): string {
  return computeLocalSessionNamespace({
    browserPort: 5173 + i,
    backendIdentity: "https://backend.convex.site",
    workosClientId: "client_dev",
    guestAuthorityId: "hosted:https://app.mcpjam.com",
  }).id;
}

/**
 * Realistic sizes: a WorkOS refresh token is a short opaque string, but leave
 * room for a much longer one; an upstream guest cookie is 32 random bytes in
 * base64url (43 chars).
 */
function realisticPayload(kind: ScopedCookieKind, size: "typical" | "large") {
  if (kind === "workos") {
    return {
      refreshToken: randomBytes(size === "typical" ? 24 : 600).toString(
        "base64url",
      ),
    };
  }
  return { upstream: randomBytes(32).toString("base64url") };
}

function sealed(
  kind: ScopedCookieKind,
  nsId: string,
  issuedAtMs: number,
  size: "typical" | "large" = "typical",
  lifetimeMs = 30 * DAY,
): string {
  return sealScopedCookie({
    kind,
    nsId,
    payload: realisticPayload(kind, size),
    issuedAtMs,
    expiresAtMs: issuedAtMs + lifetimeMs,
    secret: SECRET,
  });
}

/** A browser cookie jar: apply Set-Cookie lists, render Cookie headers. */
class Jar {
  readonly cookies = new Map<string, string>();
  apply(setCookies: string[]): void {
    for (const header of setCookies) {
      const [nameValue, ...attributes] = header.split(";").map((p) => p.trim());
      const eq = nameValue!.indexOf("=");
      const name = nameValue!.slice(0, eq);
      const value = nameValue!.slice(eq + 1);
      if (!value || attributes.some((a) => /^max-age=0$/i.test(a))) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }
  header(): string {
    return [...this.cookies].map(([n, v]) => `${n}=${v}`).join("; ");
  }
  namespaces(): Set<string> {
    return new Set(
      [...this.cookies.keys()]
        .map((name) => /^mcpjam_(?:wos|gst)_([0-9a-f]{12})$/.exec(name)?.[1])
        .filter((id): id is string => Boolean(id)),
    );
  }
  scopedBytes(): number {
    let bytes = 0;
    for (const [name, value] of this.cookies) {
      if (/^mcpjam_(?:wos|gst)_/.test(name)) {
        bytes += name.length + 1 + value.length + 2;
      }
    }
    return bytes;
  }
}

/** One instance answering one request from `snapshot`. */
function respond(
  snapshot: string,
  nsId: string,
  kind: ScopedCookieKind,
  nowMs: number,
  size: "typical" | "large" = "typical",
): string[] {
  return planScopedCookieHeaders({
    cookieHeader: snapshot,
    nsId,
    writes: [
      {
        kind,
        value: sealed(kind, nsId, nowMs, size),
        maxAgeSeconds: WORKOS_SCOPED_COOKIE_MAX_AGE_S,
      },
    ],
    nowMs,
    secure: false,
  }).setCookies;
}

describe("sealing", () => {
  it("opens only as the exact (kind, namespace) it was written for", () => {
    const a = ns(1);
    const b = ns(2);
    const value = sealScopedCookie({
      kind: "workos",
      nsId: a,
      payload: { refreshToken: "rt" },
      issuedAtMs: NOW,
      expiresAtMs: NOW + DAY,
      secret: SECRET,
    });
    const open = (kind: ScopedCookieKind, nsId: string, v = value) =>
      unsealScopedCookie({ kind, nsId, value: v, nowMs: NOW, secret: SECRET });

    expect(open("workos", a)).toEqual({ refreshToken: "rt" });
    expect(open("workos", b)).toBeNull();
    expect(open("guest", a)).toBeNull();
    expect(
      unsealScopedCookie({
        kind: "workos",
        nsId: a,
        value,
        nowMs: NOW,
        secret: "another-machine",
      }),
    ).toBeNull();
  });

  it("binds the clear-text timestamps: editing them breaks the seal", () => {
    const a = ns(1);
    const value = sealed("workos", a, NOW);
    const parts = value.split(".");
    parts[2] = Math.floor((NOW + 365 * DAY) / 1000).toString(36);
    expect(
      unsealScopedCookie({
        kind: "workos",
        nsId: a,
        value: parts.join("."),
        nowMs: NOW,
        secret: SECRET,
      }),
    ).toBeNull();
  });

  it("refuses an expired value and exposes metadata without decrypting", () => {
    const a = ns(1);
    const value = sealed("guest", a, NOW, "typical", DAY);
    expect(parseScopedCookieMeta(value)).toEqual({
      issuedAtMs: NOW,
      expiresAtMs: NOW + DAY,
    });
    expect(
      unsealScopedCookie({
        kind: "guest",
        nsId: a,
        value,
        nowMs: NOW + DAY + 1,
        secret: SECRET,
      }),
    ).toBeNull();
  });

  it("refuses a truncated auth tag", () => {
    const a = ns(1);
    const parts = sealed("workos", a, NOW).split(".");
    parts[4] = Buffer.from(parts[4]!, "base64url")
      .subarray(0, 4)
      .toString("base64url");
    expect(
      unsealScopedCookie({
        kind: "workos",
        nsId: a,
        value: parts.join("."),
        nowMs: NOW,
        secret: SECRET,
      }),
    ).toBeNull();
  });

  it("raises a cookie-secret failure instead of reading it as no session", () => {
    const value = sealed("workos", ns(1), NOW);
    const dir = mkdtempSync(path.join(os.tmpdir(), "scoped-cookie-secret-"));
    const blocker = path.join(dir, "not-a-directory");
    writeFileSync(blocker, "");
    vi.stubEnv("MCPJAM_WORKOS_SESSION_SECRET", "");
    vi.stubEnv("GUEST_JWT_KEY_DIR", path.join(blocker, "secrets"));
    try {
      expect(() =>
        unsealScopedCookie({
          kind: "workos",
          nsId: ns(1),
          value,
          nowMs: NOW,
        }),
      ).toThrow();
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("namespace", () => {
  it("differs by browser port, backend, WorkOS client, and guest authority", () => {
    const base = {
      browserPort: 5173,
      backendIdentity: "https://a.convex.site",
      workosClientId: "client_a",
      guestAuthorityId: "hosted:https://app.mcpjam.com",
    };
    const id = computeLocalSessionNamespace(base).id;
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(
      computeLocalSessionNamespace({ ...base, browserPort: 5174 }).id,
    ).not.toBe(id);
    expect(
      computeLocalSessionNamespace({
        ...base,
        backendIdentity: "https://b.convex.site",
      }).id,
    ).not.toBe(id);
    expect(
      computeLocalSessionNamespace({ ...base, workosClientId: "client_b" }).id,
    ).not.toBe(id);
    expect(
      computeLocalSessionNamespace({
        ...base,
        guestAuthorityId: "backend:https://a.convex.site",
      }).id,
    ).not.toBe(id);
  });

  it("separates the hosted and backend guest authorities on one backend", () => {
    const shared = {
      MCPJAM_BROWSER_PORT: "5173",
      CONVEX_HTTP_URL: "https://a.convex.site",
      WORKOS_CLIENT_ID: "client_a",
    };
    const hosted = resolveLocalSessionNamespace({
      ...shared,
      MCPJAM_GUEST_AUTHORITY: "hosted",
      MCPJAM_GUEST_AUTHORITY_ORIGIN: "https://a.convex.site",
    });
    const backend = resolveLocalSessionNamespace({
      ...shared,
      MCPJAM_GUEST_AUTHORITY: "backend",
      MCPJAM_GUEST_SESSION_SHARED_SECRET: "backend-secret",
    });
    expect(hosted.guestAuthorityId).toBe("hosted:https://a.convex.site");
    expect(backend.guestAuthorityId).toBe("backend:https://a.convex.site");
    expect(hosted.id).not.toBe(backend.id);
  });

  it("still names a namespace when the guest authority is misconfigured", () => {
    const resolved = resolveLocalSessionNamespace({
      MCPJAM_BROWSER_PORT: "5173",
      MCPJAM_GUEST_AUTHORITY: "backend",
    });
    expect(resolved.guestAuthorityId).toBe("unconfigured");
    expect(resolved.id).toMatch(/^[0-9a-f]{12}$/);
  });

  it("takes the browser port from configuration only", () => {
    expect(resolveBrowserPort({ MCPJAM_BROWSER_PORT: "7000" })).toBe(7000);
    expect(
      resolveBrowserPort({ NODE_ENV: "development", CLIENT_PORT: "5176" }),
    ).toBe(5176);
    expect(resolveBrowserPort({ NODE_ENV: "development" })).toBe(5173);
    expect(
      resolveBrowserPort({ NODE_ENV: "production", SERVER_PORT: "41234" }),
    ).toBe(41234);
    expect(resolveBrowserPort({ NODE_ENV: "production" })).toBe(6274);
    expect(
      resolveBrowserPort({ MCPJAM_BROWSER_PORT: "99999", SERVER_PORT: "7001" }),
    ).toBe(7001);
  });
});

describe("budgets", () => {
  it("keeps at most eight namespaces, evicting the least recently used", () => {
    const jar = new Jar();
    for (let i = 0; i < MAX_SCOPED_NAMESPACES; i += 1) {
      jar.apply(respond(jar.header(), ns(i), "workos", NOW + i * 1000));
    }
    expect(jar.namespaces().size).toBe(MAX_SCOPED_NAMESPACES);

    const plan = planScopedCookieHeaders({
      cookieHeader: jar.header(),
      nsId: ns(100),
      writes: [
        {
          kind: "workos",
          value: sealed("workos", ns(100), NOW + DAY),
          maxAgeSeconds: 60,
        },
      ],
      nowMs: NOW + DAY,
      secure: false,
    });
    expect(plan.prunedNamespaces).toEqual([ns(0)]);
    jar.apply(plan.setCookies);
    expect(jar.namespaces().size).toBe(MAX_SCOPED_NAMESPACES);
    expect(jar.namespaces().has(ns(0))).toBe(false);
    expect(jar.namespaces().has(ns(100))).toBe(true);
  });

  it("prunes expired namespaces first, regardless of count", () => {
    const jar = new Jar();
    jar.cookies.set(
      scopedCookieName("guest", ns(1)),
      sealed("guest", ns(1), NOW - 10 * DAY, "typical", DAY),
    );
    jar.cookies.set(
      scopedCookieName("workos", ns(2)),
      sealed("workos", ns(2), NOW),
    );
    jar.cookies.set(scopedCookieName("workos", ns(3)), "not-a-sealed-value");
    jar.apply(respond(jar.header(), ns(4), "workos", NOW));
    expect([...jar.namespaces()].sort()).toEqual([ns(2), ns(4)].sort());
  });

  it("holds the 6 KiB byte budget with realistic and oversized tokens", () => {
    const jar = new Jar();
    for (let i = 0; i < 20; i += 1) {
      const kind: ScopedCookieKind = i % 2 === 0 ? "workos" : "guest";
      jar.apply(respond(jar.header(), ns(i), kind, NOW + i * 1000, "large"));
      expect(jar.scopedBytes()).toBeLessThanOrEqual(SCOPED_COOKIE_BYTE_BUDGET);
      expect(jar.namespaces().size).toBeLessThanOrEqual(MAX_SCOPED_NAMESPACES);
      // The responder's own session always survives its own response.
      expect(jar.namespaces().has(ns(i))).toBe(true);
    }
  });

  it("never prunes anything when well within both budgets", () => {
    const jar = new Jar();
    jar.apply(respond("", ns(1), "workos", NOW));
    jar.apply(respond(jar.header(), ns(1), "guest", NOW));
    const plan = planScopedCookieHeaders({
      cookieHeader: jar.header(),
      nsId: ns(2),
      writes: [
        {
          kind: "workos",
          value: sealed("workos", ns(2), NOW),
          maxAgeSeconds: 60,
        },
      ],
      nowMs: NOW,
      secure: false,
    });
    expect(plan.prunedNamespaces).toEqual([]);
    expect(plan.setCookies).toHaveLength(1);
  });

  it("deleting this namespace's cookie never touches another's", () => {
    const jar = new Jar();
    jar.apply(respond("", ns(1), "workos", NOW));
    jar.apply(respond(jar.header(), ns(2), "workos", NOW));
    const plan = planScopedCookieHeaders({
      cookieHeader: jar.header(),
      nsId: ns(1),
      writes: [{ kind: "workos", value: null }],
      nowMs: NOW,
      secure: false,
    });
    jar.apply(plan.setCookies);
    expect([...jar.namespaces()]).toEqual([ns(2)]);
  });
});

describe("concurrent responses", () => {
  it("two instances logging in from one snapshot both survive, in either order", () => {
    for (const order of [
      [0, 1],
      [1, 0],
    ]) {
      const jar = new Jar();
      // Six stale namespaces already in the browser.
      for (let i = 10; i < 16; i += 1) {
        jar.apply(respond(jar.header(), ns(i), "workos", NOW - DAY + i));
      }
      const snapshot = jar.header();
      const responses = [
        respond(snapshot, ns(1), "workos", NOW),
        respond(snapshot, ns(2), "workos", NOW + 1),
      ];
      for (const i of order) jar.apply(responses[i]!);
      expect(jar.namespaces().has(ns(1))).toBe(true);
      expect(jar.namespaces().has(ns(2))).toBe(true);
      expect(jar.namespaces().size).toBeLessThanOrEqual(MAX_SCOPED_NAMESPACES);
    }
  });

  it("concurrent login and refresh at the namespace limit evict only stale namespaces", () => {
    const jar = new Jar();
    // Seven namespaces; ns(1) is active (fresh), the rest are stale.
    for (let i = 10; i < 16; i += 1) {
      jar.apply(respond(jar.header(), ns(i), "workos", NOW - 2 * DAY + i));
    }
    jar.apply(respond(jar.header(), ns(1), "workos", NOW - 60_000));
    expect(jar.namespaces().size).toBe(7);

    const snapshot = jar.header();
    const refreshActive = respond(snapshot, ns(1), "workos", NOW);
    const loginNew = respond(snapshot, ns(2), "workos", NOW + 1);
    const loginAnother = respond(snapshot, ns(3), "workos", NOW + 2);
    for (const response of [loginNew, refreshActive, loginAnother]) {
      jar.apply(response);
    }
    // No response evicted a concurrently active namespace.
    expect(jar.namespaces().has(ns(1))).toBe(true);
    expect(jar.namespaces().has(ns(2))).toBe(true);
    expect(jar.namespaces().has(ns(3))).toBe(true);
    // Each response planned against a snapshot holding 7 namespaces, so two
    // simultaneous NEW namespaces can overshoot the bound by one until the
    // next response from any instance — which prunes the stalest.
    expect(jar.namespaces().size).toBeLessThanOrEqual(
      MAX_SCOPED_NAMESPACES + 1,
    );

    jar.apply(respond(jar.header(), ns(1), "guest", NOW + 10));
    expect(jar.namespaces().size).toBeLessThanOrEqual(MAX_SCOPED_NAMESPACES);
    for (const active of [ns(1), ns(2), ns(3)]) {
      expect(jar.namespaces().has(active)).toBe(true);
    }
    expect(jar.scopedBytes()).toBeLessThanOrEqual(SCOPED_COOKIE_BYTE_BUDGET);
  });

  it("each response writes only its own namespace", () => {
    const jar = new Jar();
    for (let i = 0; i < 12; i += 1) {
      const headers = respond(jar.header(), ns(i), "guest", NOW + i);
      const written = headers.filter((h) => !/Max-Age=0/.test(h));
      expect(written).toHaveLength(1);
      expect(
        written[0]!.startsWith(`${scopedCookieName("guest", ns(i))}=`),
      ).toBe(true);
      jar.apply(headers);
    }
  });
});
