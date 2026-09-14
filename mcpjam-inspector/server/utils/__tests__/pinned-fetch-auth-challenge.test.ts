import { afterEach, describe, expect, it, vi } from "vitest";
import { createStreamingPinnedFetch } from "../pinned-fetch.js";

/**
 * The challenge observer is the one place the `WWW-Authenticate` header is
 * seen. It fires on 401/403 only, hands over the PARSED summary, and never
 * turns a response into a failure.
 */
describe("createStreamingPinnedFetch onAuthChallenge", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  it("reports a parsed 401 challenge and stays silent on a 200", async () => {
    const seen: unknown[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/ok")) return new Response("ok", { status: 200 });
      return new Response("nope", {
        status: 401,
        headers: {
          "www-authenticate":
            'Bearer error="invalid_token", scope="read", resource_metadata="https://api.example.com/.well-known/oauth-protected-resource"',
          "content-type": "application/json",
        },
      });
    }) as typeof fetch;
    const fetchWithHook = createStreamingPinnedFetch({
      hosted: false,
      onAuthChallenge: (event) => seen.push(event),
    });
    const ok = await fetchWithHook("https://api.example.com/ok");
    expect(ok.status).toBe(200);
    const denied = await fetchWithHook("https://api.example.com/mcp");
    expect(denied.status).toBe(401);
    expect(seen).toEqual([
      {
        url: "https://api.example.com/mcp",
        status: 401,
        challenge: {
          scheme: "bearer",
          error: "invalid_token",
          scopes: ["read"],
          resourceMetadataHost: "api.example.com",
          bodyKind: "json",
        },
      },
    ]);
    // The raw header is not in the event in any form.
    expect(JSON.stringify(seen)).not.toContain("well-known");
  });

  it("reports an HTML 403 with no challenge, and a throwing observer cannot break the fetch", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("<html>denied</html>", {
          status: 403,
          headers: { "content-type": "text/html" },
        }),
    ) as typeof fetch;
    const seen: unknown[] = [];
    const fetchWithHook = createStreamingPinnedFetch({
      hosted: false,
      onAuthChallenge: (event) => {
        seen.push(event);
        throw new Error("observer bug");
      },
    });
    const response = await fetchWithHook("https://api.example.com/mcp");
    expect(response.status).toBe(403);
    expect(seen).toEqual([
      {
        url: "https://api.example.com/mcp",
        status: 403,
        challenge: { scheme: "none", bodyKind: "html" },
      },
    ]);
  });
});
