import { describe, expect, it, vi } from "vitest";
import { probeMcpServer } from "@mcpjam/sdk";
import { createGuardedFetch } from "../hosted-egress-guard.js";

// The hosted doctor route dials the probe through `createGuardedFetch`. The
// SDK's own guard classifies IP literals, but it cannot resolve DNS — the probe
// is exported from the worker entry, which must stay free of `node:dns`. So the
// case where a target names a hostname that ANSWERS with a private address is
// closed here or nowhere. These tests exercise the two pieces together, which
// is the seam the route depends on.
describe("hosted doctor probe egress", () => {
  const serverUrl = "https://mcp.example.com/mcp";

  const challenge = (resourceMetadata: string) =>
    new Response(null, {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadata}"`,
      },
    });

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  it("refuses a metadata hostname that resolves to a private address", async () => {
    // Passes the SDK's literal-IP guard: it is a public-looking name on a
    // different origin, and nothing in the URL reveals where it points.
    const pointer = "https://metadata.attacker.test/prm";
    const baseFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === serverUrl) return challenge(pointer);
      return json({ SECRET: "internal-credentials" });
    }) as unknown as typeof fetch;

    const result = await probeMcpServer({
      url: serverUrl,
      fetchFn: createGuardedFetch({
        hosted: true,
        baseFetch,
        resolver: async (hostname) =>
          hostname === "metadata.attacker.test"
            ? ["10.0.0.5"]
            : ["93.184.216.34"],
      }),
    });

    expect(result.oauth.discoveryError).toBeDefined();
    expect(result.oauth.resourceMetadata).toBeUndefined();
    // The request was never dialed, so nothing about the internal host is
    // recorded — not a response, not a body.
    const dialled = (
      baseFetch as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.map((call) => String(call[0]));
    expect(dialled).not.toContain(pointer);
    const attempt = result.transport.attempts.find(
      (entry) => entry.name === "resource_metadata",
    );
    expect(attempt?.response).toBeUndefined();
  });

  it("refuses a metadata redirect whose Location resolves to a private address", async () => {
    const pointer = "https://metadata.example.test/prm";
    const redirectTarget = "https://internal.attacker.test/prm";
    let internalBodyRead = false;
    // Emulates a real fetch: when the caller asks to follow redirects it does,
    // reporting the landing URL. Without that, the mock never follows anything
    // and the test would pass with no guard in place at all.
    const baseFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === serverUrl) return challenge(pointer);
        if (url === pointer) {
          if (init?.redirect === "manual") {
            return new Response(null, {
              status: 302,
              headers: { Location: redirectTarget },
            });
          }
          const followed = json({ SECRET: "internal-credentials" });
          const readText = followed.text.bind(followed);
          Object.defineProperty(followed, "text", {
            value: async () => {
              internalBodyRead = true;
              return readText();
            },
          });
          Object.defineProperty(followed, "url", { value: redirectTarget });
          return followed;
        }
        return json({ SECRET: "internal-credentials" });
      },
    ) as unknown as typeof fetch;

    const result = await probeMcpServer({
      url: serverUrl,
      fetchFn: createGuardedFetch({
        hosted: true,
        baseFetch,
        resolver: async (hostname) =>
          hostname === "internal.attacker.test"
            ? ["169.254.169.254"]
            : ["93.184.216.34"],
      }),
    });

    expect(result.oauth.discoveryError).toBeDefined();
    // The assertion that actually discriminates. The guard forces `redirect:
    // "manual"` underneath, inspects the Location, and refuses before dialing
    // it — so the internal document is never fetched, let alone read. Without
    // the guard the probe follows the 302 itself and consumes the body, since
    // the SDK's literal-IP check cannot tell that this hostname is internal.
    expect(internalBodyRead).toBe(false);
    expect(result.oauth.resourceMetadata).toBeUndefined();
  });

  it("leaves loopback and LAN probing untouched outside hosted mode", async () => {
    for (const localUrl of [
      "http://localhost:3000/mcp",
      "http://192.168.1.5:3000/mcp",
    ]) {
      const origin = new URL(localUrl).origin;
      const pointer = `${origin}/.well-known/oauth-protected-resource/mcp`;
      const baseFetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === localUrl) return challenge(pointer);
        if (url === pointer) {
          return json({ resource: localUrl, authorization_servers: [origin] });
        }
        if (url.startsWith(origin)) {
          return json({
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            response_types_supported: ["code"],
          });
        }
        return new Response(JSON.stringify({ error: "unexpected" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;

      const result = await probeMcpServer({
        url: localUrl,
        // hosted: false is what a developer's machine gets; the guard is the
        // identity function there and must not touch local probing.
        fetchFn: createGuardedFetch({ hosted: false, baseFetch }),
      });

      expect(result.status).toBe("oauth_required");
      expect(result.oauth.resourceMetadata).toBeDefined();
      expect(result.oauth.discoveryError).toBeUndefined();
    }
  });
});
