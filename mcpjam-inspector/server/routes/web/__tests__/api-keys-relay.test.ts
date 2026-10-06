import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebTestApp } from "./helpers/test-app.js";
import {
  resolveHostedApiOrigin,
  shouldRelayApiKeys,
} from "../../../services/api-keys-relay.js";

// The relay runs before bearer auth, so none of the verification machinery
// (AuthKit JWT, Convex identity) may be reached on this path.
vi.mock("../../../services/authkit-jwt.js", () => ({
  verifyAuthKitToken: vi.fn(() => {
    throw new Error("relay must not verify the token locally");
  }),
  AuthKitConfigError: class extends Error {},
}));

describe("shouldRelayApiKeys", () => {
  it("relays a local build missing either secret", () => {
    expect(shouldRelayApiKeys({}, false)).toBe(true);
    expect(shouldRelayApiKeys({ WORKOS_API_KEY: "k" }, false)).toBe(true);
    expect(shouldRelayApiKeys({ INSPECTOR_SERVICE_TOKEN: "t" }, false)).toBe(
      true,
    );
  });
  it("handles keys itself when both secrets are present", () => {
    expect(
      shouldRelayApiKeys(
        { WORKOS_API_KEY: "k", INSPECTOR_SERVICE_TOKEN: "t" },
        false,
      ),
    ).toBe(false);
  });
  it("never relays from a hosted deployment", () => {
    expect(shouldRelayApiKeys({}, true)).toBe(false);
  });
});

describe("resolveHostedApiOrigin", () => {
  it("defaults to the hosted app", () => {
    expect(resolveHostedApiOrigin({})).toBe("https://app.mcpjam.com");
  });
  it("accepts https and loopback http origins", () => {
    expect(
      resolveHostedApiOrigin({ MCPJAM_HOSTED_API_URL: "https://x.example/" }),
    ).toBe("https://x.example");
    expect(
      resolveHostedApiOrigin({
        MCPJAM_HOSTED_API_URL: "http://localhost:6274",
      }),
    ).toBe("http://localhost:6274");
  });
  it("refuses plain http to a remote host, paths and credentials", () => {
    for (const bad of [
      "http://evil.example",
      "https://x.example/api",
      "https://user:pw@x.example",
      "not a url",
    ]) {
      expect(() =>
        resolveHostedApiOrigin({ MCPJAM_HOSTED_API_URL: bad }),
      ).toThrow();
    }
  });
});

describe("api-keys relay (local build)", () => {
  const { app } = createWebTestApp();

  beforeEach(() => {
    vi.stubEnv("WORKOS_API_KEY", "");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");
    vi.stubEnv("MCPJAM_HOSTED_API_URL", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("forwards a mint to the hosted app with only the caller's bearer", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ value: "sk_once", id: "k1" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.request("/api/web/api-keys?x=1", {
      method: "POST",
      headers: {
        Authorization: "Bearer session-jwt",
        "Content-Type": "application/json",
        Cookie: "secret=1",
      },
      body: JSON.stringify({ name: "n", organizationId: "org-1" }),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ value: "sk_once", id: "k1" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://app.mcpjam.com/api/web/api-keys?x=1");
    const sent = new Headers(init!.headers);
    expect(sent.get("authorization")).toBe("Bearer session-jwt");
    expect(sent.get("cookie")).toBeNull();
    expect(init!.redirect).toBe("manual");
    expect(Buffer.from(init!.body as ArrayBuffer).toString()).toContain(
      "org-1",
    );
  });

  it("passes upstream errors through unchanged", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ code: "FORBIDDEN", message: "no" }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    const response = await app.request("/api/web/api-keys", {
      headers: { Authorization: "Bearer session-jwt" },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: "FORBIDDEN", message: "no" });
  });

  it("still rejects sk_ keys before relaying", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await app.request("/api/web/api-keys", {
      headers: { Authorization: "Bearer sk_abc" },
    });
    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 502 when the hosted app is unreachable and 502 on redirects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("fetch failed"))),
    );
    let response = await app.request("/api/web/api-keys", {
      headers: { Authorization: "Bearer session-jwt" },
    });
    expect(response.status).toBe(502);

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { Location: "https://evil.example" },
          }),
      ),
    );
    response = await app.request("/api/web/api-keys", {
      headers: { Authorization: "Bearer session-jwt" },
    });
    expect(response.status).toBe(502);
  });
});
