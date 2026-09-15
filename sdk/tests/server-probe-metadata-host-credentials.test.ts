import { probeMcpServer } from "../src/server-probe.js";

/**
 * Issue #5000: stored headers must not travel to hosts the TARGET named.
 *
 * OAuth discovery dials the address in the server's own `WWW-Authenticate`
 * challenge. `removeAuthorizationHeader` stripped exactly one name, so every
 * other stored header — an `X-Api-Key` holding the user's vendor key, a session
 * header, anything saved against that server — went along. A server could
 * harvest its caller's credentials by answering 401 with
 * `resource_metadata="https://collect.attacker.test/prm"`.
 *
 * Each cell that asserts a strip is paired with the same-origin case that must
 * still carry the headers, so "sends nothing anywhere" cannot pass this file.
 */

const SERVER_URL = "https://mcp.example.com/mcp";
const STORED = {
  "X-Api-Key": "vendor-key-value",
  "X-Session-Id": "session-value",
  "X-Trace-Id": "trace-value",
};

type Seen = { url: string; headers: Record<string, string> };

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** 401 with a challenge that points discovery at `metadataUrl`. */
function challengingFetch(metadataUrl: string, seen: Seen[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({
      url,
      headers: { ...((init?.headers as Record<string, string>) ?? {}) },
    });
    if (url === SERVER_URL) {
      return jsonResponse({ error: "unauthorized" }, 401, {
        "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}"`,
      });
    }
    if (url === metadataUrl) {
      return jsonResponse({
        resource: SERVER_URL,
        authorization_servers: [],
      });
    }
    return jsonResponse({ error: "missing" }, 404);
  }) as typeof fetch;
}

function headersFor(seen: Seen[], url: string): Record<string, string> {
  const hit = seen.find((r) => r.url === url);
  if (!hit) throw new Error(`no request recorded for ${url}`);
  return hit.headers;
}

describe("probeMcpServer metadata-host credentials (#5000)", () => {
  it("sends no stored header to a metadata host the target chose", async () => {
    const metadataUrl = "https://collect.attacker.test/prm";
    const seen: Seen[] = [];

    await probeMcpServer({
      url: SERVER_URL,
      headers: STORED,
      fetchFn: challengingFetch(metadataUrl, seen),
    });

    const sent = headersFor(seen, metadataUrl);
    for (const name of ["x-api-key", "x-session-id", "x-trace-id"]) {
      expect(sent[name]).toBeUndefined();
    }
    // Nothing of the values reached it under any spelling either.
    expect(JSON.stringify(sent)).not.toContain("vendor-key-value");
    expect(JSON.stringify(sent)).not.toContain("session-value");
  });

  it("still sends them to a metadata host on the server's own origin", async () => {
    const metadataUrl =
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
    const seen: Seen[] = [];

    await probeMcpServer({
      url: SERVER_URL,
      headers: STORED,
      fetchFn: challengingFetch(metadataUrl, seen),
    });

    const sent = headersFor(seen, metadataUrl);
    expect(sent["x-api-key"]).toBe("vendor-key-value");
    expect(sent["x-trace-id"]).toBe("trace-value");
  });

  it("a different port on the same host is a different origin", async () => {
    const metadataUrl = "https://mcp.example.com:8443/prm";
    const seen: Seen[] = [];

    await probeMcpServer({
      url: SERVER_URL,
      headers: STORED,
      fetchFn: challengingFetch(metadataUrl, seen),
    });

    expect(headersFor(seen, metadataUrl)["x-api-key"]).toBeUndefined();
  });

  it("a cross-origin redirect from the server's own metadata URL gets nothing", async () => {
    // CodeRabbit on #5000. A metadata URL on the server's own origin
    // legitimately carries the stored headers — and can then 302 anywhere.
    // `fetch`'s own redirect following strips Authorization, Cookie and
    // Proxy-Authorization across origins and NOTHING else, so an `X-Api-Key`
    // rides along (measured against two local origins on Node 24). The probe
    // follows these by hand and re-asks the same question per destination.
    const sameOrigin =
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
    const elsewhere = "https://collect.attacker.test/prm";
    const seen: Seen[] = [];

    const fetchFn: typeof fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const url = String(input);
      seen.push({
        url,
        headers: { ...((init?.headers as Record<string, string>) ?? {}) },
      });
      if (url === SERVER_URL) {
        return jsonResponse({ error: "unauthorized" }, 401, {
          "WWW-Authenticate": `Bearer resource_metadata="${sameOrigin}"`,
        });
      }
      if (url === sameOrigin) {
        return new Response(null, {
          status: 302,
          headers: { location: elsewhere },
        });
      }
      return jsonResponse({ resource: SERVER_URL, authorization_servers: [] });
    }) as typeof fetch;

    await probeMcpServer({ url: SERVER_URL, headers: STORED, fetchFn });

    // The first hop is the server's own origin and keeps them.
    expect(headersFor(seen, sameOrigin)["x-api-key"]).toBe("vendor-key-value");
    // The hop the server redirected to does not.
    const redirected = headersFor(seen, elsewhere);
    expect(redirected["x-api-key"]).toBeUndefined();
    expect(redirected["x-session-id"]).toBeUndefined();
    expect(JSON.stringify(redirected)).not.toContain("vendor-key-value");
  });

  it("a redirect to a blocked destination is refused before the hop", async () => {
    // The destination guard has to run on each hop, in the same order it runs
    // for the initial URL: refuse first, dial second. Otherwise following by
    // hand would reach a host the guard exists to keep the probe away from.
    const sameOrigin =
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
    const blocked = "http://127.0.0.1:9/prm";
    const seen: Seen[] = [];

    const fetchFn: typeof fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const url = String(input);
      seen.push({
        url,
        headers: { ...((init?.headers as Record<string, string>) ?? {}) },
      });
      if (url === SERVER_URL) {
        return jsonResponse({ error: "unauthorized" }, 401, {
          "WWW-Authenticate": `Bearer resource_metadata="${sameOrigin}"`,
        });
      }
      if (url === sameOrigin) {
        return new Response(null, {
          status: 302,
          headers: { location: blocked },
        });
      }
      return jsonResponse({ ok: true });
    }) as typeof fetch;

    await probeMcpServer({ url: SERVER_URL, headers: STORED, fetchFn });

    expect(seen.some((r) => r.url === blocked)).toBe(false);
  });

  it("a same-origin redirect keeps the headers", async () => {
    // The control: following by hand must not turn into "strip on any
    // redirect". `/prm` to `/prm/` is the ordinary case.
    const first =
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
    const second =
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp/";
    const seen: Seen[] = [];

    const fetchFn: typeof fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const url = String(input);
      seen.push({
        url,
        headers: { ...((init?.headers as Record<string, string>) ?? {}) },
      });
      if (url === SERVER_URL) {
        return jsonResponse({ error: "unauthorized" }, 401, {
          "WWW-Authenticate": `Bearer resource_metadata="${first}"`,
        });
      }
      if (url === first) {
        return new Response(null, {
          status: 308,
          headers: { location: second },
        });
      }
      return jsonResponse({ resource: SERVER_URL, authorization_servers: [] });
    }) as typeof fetch;

    await probeMcpServer({ url: SERVER_URL, headers: STORED, fetchFn });

    expect(headersFor(seen, second)["x-api-key"]).toBe("vendor-key-value");
  });

  it("the recorded attempt shows what was actually sent", async () => {
    const metadataUrl = "https://collect.attacker.test/prm";
    const seen: Seen[] = [];

    const result = await probeMcpServer({
      url: SERVER_URL,
      headers: STORED,
      fetchFn: challengingFetch(metadataUrl, seen),
    });

    // A record that still listed the stored headers would tell a reader the
    // opposite of what happened.
    const metadataAttempt = result.transport.attempts.find(
      (a) => a.request.url === metadataUrl
    );
    expect(metadataAttempt).toBeDefined();
    expect(JSON.stringify(metadataAttempt!.request.headers)).not.toContain(
      "vendor-key-value"
    );
  });

  it("the server's own request is untouched", async () => {
    const metadataUrl = "https://collect.attacker.test/prm";
    const seen: Seen[] = [];

    await probeMcpServer({
      url: SERVER_URL,
      headers: STORED,
      fetchFn: challengingFetch(metadataUrl, seen),
    });

    // The control for the whole file: the headers a user configured still reach
    // the server they configured them for.
    const sent = headersFor(seen, SERVER_URL);
    expect(sent["X-Api-Key"] ?? sent["x-api-key"]).toBe("vendor-key-value");
  });
});
