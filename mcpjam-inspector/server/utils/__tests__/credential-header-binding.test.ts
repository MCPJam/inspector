import { describe, expect, it, vi } from "vitest";
import {
  bindCredentialHeaders,
  bindingForAuthorizedHeaders,
  boundOriginsFromReveal,
  credentialOrigin,
} from "../credential-header-binding.js";

type Hop = { url: string; method: string; headers: Headers; body: unknown };

/**
 * A fake upstream: `routes` maps a URL to the response it answers with; any
 * other URL answers 200. Records every hop the wrapper dials.
 */
function upstream(routes: Record<string, () => Response>) {
  const hops: Hop[] = [];
  const fetchMock = vi.fn(async (input: any, init?: RequestInit) => {
    const url = String(input);
    hops.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body,
    });
    expect(init?.redirect).toBe("manual");
    return routes[url]?.() ?? new Response("ok", { status: 200 });
  });
  return { hops, fetchMock: fetchMock as unknown as typeof fetch };
}

function redirect(status: number, location: string) {
  return () => new Response(null, { status, headers: { Location: location } });
}

const binding = {
  headerNames: ["x-api-key", "Authorization"],
  boundOrigins: ["https://owner.example.com"],
};

describe("credentialOrigin", () => {
  it("reduces to scheme + host + non-default port", () => {
    expect(credentialOrigin("https://Owner.Example.com:443/mcp?q=1")).toBe(
      "https://owner.example.com",
    );
    expect(credentialOrigin("http://owner.example.com:8080/x")).toBe(
      "http://owner.example.com:8080",
    );
  });

  it("strips a trailing dot so one host is one origin", () => {
    expect(credentialOrigin("https://owner.example.com./mcp")).toBe(
      "https://owner.example.com",
    );
  });

  it("refuses what cannot be an http(s) origin", () => {
    expect(credentialOrigin("file:///etc/passwd")).toBeNull();
    expect(credentialOrigin("not a url")).toBeNull();
    expect(credentialOrigin("")).toBeNull();
    expect(credentialOrigin(undefined)).toBeNull();
  });
});

describe("bindCredentialHeaders", () => {
  it("attaches the stored headers to a bound origin", async () => {
    const { hops, fetchMock } = upstream({});
    const bound = bindCredentialHeaders(fetchMock, binding);

    await bound("https://owner.example.com/mcp", {
      headers: { "x-api-key": "k", "content-type": "application/json" },
    });

    expect(hops[0]!.headers.get("x-api-key")).toBe("k");
  });

  it("strips them on a request to an origin that is not bound", async () => {
    const { hops, fetchMock } = upstream({});
    const bound = bindCredentialHeaders(fetchMock, binding);

    await bound("https://elsewhere.example/mcp", {
      headers: { "x-api-key": "k", accept: "text/event-stream" },
    });

    expect(hops[0]!.headers.get("x-api-key")).toBeNull();
    // Only the credential's own headers go; the rest of the request is intact.
    expect(hops[0]!.headers.get("accept")).toBe("text/event-stream");
  });

  it("drops them at a cross-origin redirect hop and keeps following", async () => {
    const { hops, fetchMock } = upstream({
      "https://owner.example.com/mcp": redirect(
        307,
        "https://collector.example/steal",
      ),
    });
    const bound = bindCredentialHeaders(fetchMock, binding);

    const response = await bound("https://owner.example.com/mcp", {
      method: "POST",
      body: "{}",
      headers: { "x-api-key": "k", authorization: "Bearer t" },
    });

    expect(response.status).toBe(200);
    expect(hops.map((hop) => hop.url)).toEqual([
      "https://owner.example.com/mcp",
      "https://collector.example/steal",
    ]);
    expect(hops[1]!.headers.get("x-api-key")).toBeNull();
    expect(hops[1]!.headers.get("authorization")).toBeNull();
    // 307 preserves the method and body.
    expect(hops[1]!.method).toBe("POST");
    expect(hops[1]!.body).toBe("{}");
  });

  it("re-attaches them only on hops at a bound origin", async () => {
    // The headers are re-derived from the ORIGINAL request each hop, so a
    // chain that bounces out and back re-attaches them only on the bound hop.
    const { hops, fetchMock } = upstream({
      "https://owner.example.com/mcp": redirect(302, "https://hop.example/a"),
      "https://hop.example/a": redirect(302, "https://owner.example.com/final"),
    });
    const bound = bindCredentialHeaders(fetchMock, binding);

    await bound("https://owner.example.com/mcp", {
      headers: { "x-api-key": "k" },
    });

    expect(hops.map((hop) => hop.headers.get("x-api-key"))).toEqual([
      "k",
      null,
      "k",
    ]);
  });

  it("drops a bearer that is not a stored header when a redirect crosses origins", async () => {
    // An OAuth or XAA bearer rides the same connection as the stored headers
    // but is not one of them; Fetch would drop it at a cross-origin redirect,
    // and following redirects here must not lose that.
    const { hops, fetchMock } = upstream({
      "https://owner.example.com/mcp": redirect(
        307,
        "https://collector.example/steal",
      ),
      "https://collector.example/steal": redirect(
        307,
        "https://owner.example.com/back",
      ),
    });
    const bound = bindCredentialHeaders(fetchMock, {
      headerNames: ["x-api-key"],
      boundOrigins: ["https://owner.example.com"],
    });

    await bound("https://owner.example.com/mcp", {
      headers: {
        "x-api-key": "k",
        authorization: "Bearer oauth-token",
        cookie: "session=1",
      },
    });

    expect(hops.map((hop) => hop.headers.get("authorization"))).toEqual([
      "Bearer oauth-token",
      null,
      // Once dropped it stays dropped, as in Fetch.
      null,
    ]);
    expect(hops[1]!.headers.get("cookie")).toBeNull();
    expect(hops[2]!.headers.get("x-api-key")).toBe("k");
  });

  it("keeps a bearer across a same-origin redirect", async () => {
    const { hops, fetchMock } = upstream({
      "https://owner.example.com/a": redirect(307, "/b"),
    });
    const bound = bindCredentialHeaders(fetchMock, binding);

    await bound("https://owner.example.com/a", {
      headers: { "x-api-key": "k", authorization: "Bearer t" },
    });

    expect(hops[1]!.url).toBe("https://owner.example.com/b");
    expect(hops[1]!.headers.get("authorization")).toBe("Bearer t");
  });

  it("applies Fetch's method rewrite on 303 and on a POST 302", async () => {
    const { hops, fetchMock } = upstream({
      "https://owner.example.com/a": redirect(
        303,
        "https://owner.example.com/b",
      ),
    });
    const bound = bindCredentialHeaders(fetchMock, binding);

    await bound("https://owner.example.com/a", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json", "x-api-key": "k" },
    });

    expect(hops[1]!.method).toBe("GET");
    expect(hops[1]!.body).toBeUndefined();
    expect(hops[1]!.headers.get("content-type")).toBeNull();
    expect(hops[1]!.headers.get("x-api-key")).toBe("k");
  });

  it("honors a caller's manual redirect mode with a single checked request", async () => {
    const calls: RequestInit[] = [];
    const inner = vi.fn(async (_input: any, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(null, {
        status: 302,
        headers: { Location: "https://collector.example/" },
      });
    }) as unknown as typeof fetch;
    const bound = bindCredentialHeaders(inner, binding);

    const response = await bound("https://owner.example.com/mcp", {
      redirect: "manual",
      headers: { "x-api-key": "k" },
    });

    expect(response.status).toBe(302);
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0]!.headers).get("x-api-key")).toBe("k");
  });

  it("gives up on an endless redirect chain", async () => {
    const inner = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://owner.example.com/loop" },
        }),
    ) as unknown as typeof fetch;
    const bound = bindCredentialHeaders(inner, binding);

    await expect(bound("https://owner.example.com/loop")).rejects.toThrow(
      /Too many redirects/,
    );
  });

  it("attaches nowhere when the backend bound no origin", async () => {
    const { hops, fetchMock } = upstream({});
    const bound = bindCredentialHeaders(fetchMock, {
      headerNames: ["x-api-key"],
      boundOrigins: [],
    });

    await bound("https://owner.example.com/mcp", {
      headers: { "x-api-key": "k" },
    });

    expect(hops[0]!.headers.get("x-api-key")).toBeNull();
  });

  it("is the underlying fetch when there are no credential headers", () => {
    const inner = vi.fn() as unknown as typeof fetch;
    expect(
      bindCredentialHeaders(inner, { headerNames: [], boundOrigins: [] }),
    ).toBe(inner);
  });
});

describe("boundOriginsFromReveal", () => {
  it("reads the broker's boundOrigins", () => {
    expect(
      boundOriginsFromReveal({
        boundOrigins: ["https://a.example", 7, "https://b.example"],
      }),
    ).toEqual(["https://a.example", "https://b.example"]);
  });

  it("falls back to the legacy single origin", () => {
    expect(
      boundOriginsFromReveal({ secretsBoundOrigin: "https://a.example/" }),
    ).toEqual(["https://a.example"]);
  });

  it("is empty — attach nowhere — when neither is present", () => {
    expect(boundOriginsFromReveal({})).toEqual([]);
    expect(boundOriginsFromReveal({ secretsBoundOrigin: "ftp://x" })).toEqual(
      [],
    );
  });
});

describe("bindingForAuthorizedHeaders", () => {
  it("holds inline headers to the server's own origin", () => {
    expect(
      bindingForAuthorizedHeaders({
        url: "https://owner.example.com/mcp",
        headers: { "x-api-key": "k", empty: "" },
      }),
    ).toEqual({
      headerNames: ["x-api-key"],
      boundOrigins: ["https://owner.example.com"],
    });
  });

  it("prefers the origin the authorize response recorded", () => {
    expect(
      bindingForAuthorizedHeaders({
        url: "https://moved.example.com/mcp",
        headers: { "x-api-key": "k" },
        secretsBoundOrigin: "https://owner.example.com",
      }),
    ).toEqual({
      headerNames: ["x-api-key"],
      boundOrigins: ["https://owner.example.com"],
    });
  });

  it("is null when there is nothing to bind", () => {
    expect(
      bindingForAuthorizedHeaders({ url: "https://a.example", headers: {} }),
    ).toBeNull();
  });
});
