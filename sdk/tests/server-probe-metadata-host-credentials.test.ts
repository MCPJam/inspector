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
