import { probeMcpServer } from "../src/server-probe.js";

/**
 * Issue #5001: the probe result must not carry the stored bearer token.
 *
 * `buildInitializeRequest` puts the token on the attempt's `request.headers`,
 * and that same object is what the caller receives inside
 * `transport.attempts[]` — so a token that never had to leave the server ended
 * up in a JSON response body, and from there in browser memory, HAR exports and
 * any support bundle someone pastes it into.
 *
 * Every cell here pairs the redaction with the thing it must not break: the
 * request that goes out still carries the real credential. A redaction that
 * also broke authentication would pass a test that only looked at the record.
 */

const TOKEN = "super-secret-access-token";

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

function readyServerFetch(
  serverUrl: string,
  seen: Array<{ url: string; headers: Record<string, string> }>
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({
      url,
      headers: { ...((init?.headers as Record<string, string>) ?? {}) },
    });
    if (url === serverUrl) {
      return jsonResponse({
        jsonrpc: "2.0",
        result: {
          protocolVersion: "2025-11-25",
          serverInfo: { name: "mock-server", version: "1.0.0" },
          capabilities: { tools: {} },
        },
      });
    }
    return jsonResponse({ error: "missing" }, 404);
  }) as typeof fetch;
}

describe("probeMcpServer credential redaction (#5001)", () => {
  it("records the Authorization header name but not its value", async () => {
    const serverUrl = "https://mcp.example.com/mcp";
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];

    const result = await probeMcpServer({
      url: serverUrl,
      accessToken: TOKEN,
      fetchFn: readyServerFetch(serverUrl, seen),
    });

    const initialize = result.transport.attempts.find(
      (a) => a.name === "streamable_initialize"
    );
    expect(initialize).toBeDefined();
    // The name is the diagnostic — it is how a reader tells an authenticated
    // attempt from an anonymous one — so it must survive.
    expect(initialize!.request.headers.Authorization).toBe("[REDACTED]");
    expect(initialize!.request.headers.Accept).toContain("application/json");
  });

  it("still sends the real bearer token", async () => {
    const serverUrl = "https://mcp.example.com/mcp";
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];

    await probeMcpServer({
      url: serverUrl,
      accessToken: TOKEN,
      fetchFn: readyServerFetch(serverUrl, seen),
    });

    const initialize = seen.find((r) => r.url === serverUrl);
    expect(initialize).toBeDefined();
    expect(initialize!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("the token appears nowhere in the serialized result", async () => {
    const serverUrl = "https://mcp.example.com/mcp";
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];

    const result = await probeMcpServer({
      url: serverUrl,
      accessToken: TOKEN,
      fetchFn: readyServerFetch(serverUrl, seen),
    });

    // The whole point: not "the header we thought of is clean" but "the
    // document a caller receives does not contain the secret anywhere".
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    // Control: the harness really did hand a token to the probe, so the
    // assertion above is not passing on an empty run.
    expect(
      seen.some((r) => r.headers.Authorization === `Bearer ${TOKEN}`)
    ).toBe(true);
  });

  it("leaves non-credential caller headers alone", async () => {
    const serverUrl = "https://mcp.example.com/mcp";
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];

    const result = await probeMcpServer({
      url: serverUrl,
      accessToken: TOKEN,
      headers: { "X-Trace-Id": "abc-123", "X-Api-Key": "another-secret" },
      fetchFn: readyServerFetch(serverUrl, seen),
    });

    const initialize = result.transport.attempts.find(
      (a) => a.name === "streamable_initialize"
    );
    // `normalizeHeaders` runs caller headers through `new Headers()`, which
    // lower-cases the names, so the record spells them that way.
    expect(initialize!.request.headers["x-trace-id"]).toBe("abc-123");
    // A credential-shaped custom header is a credential too — the predicate is
    // shared with the conformance redactor rather than being a list of one.
    expect(initialize!.request.headers["x-api-key"]).toBe("[REDACTED]");
    expect(seen.find((r) => r.url === serverUrl)!.headers["x-api-key"]).toBe(
      "another-secret"
    );
  });

  it("redacts an attempt recorded before its request was made", async () => {
    // A 401 with a resource-metadata pointer makes the probe record the
    // metadata attempt before dialling it, and the destination guard can reject
    // it after that. Whatever the outcome, no recorded attempt may carry a live
    // credential.
    const serverUrl = "https://mcp.example.com/mcp";
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];

    const fetchFn: typeof fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const url = String(input);
      seen.push({
        url,
        headers: { ...((init?.headers as Record<string, string>) ?? {}) },
      });
      if (url === serverUrl) {
        return jsonResponse({ error: "unauthorized" }, 401, {
          "WWW-Authenticate":
            'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
        });
      }
      return jsonResponse({ error: "missing" }, 404);
    }) as typeof fetch;

    const result = await probeMcpServer({
      url: serverUrl,
      accessToken: TOKEN,
      fetchFn,
    });

    expect(JSON.stringify(result)).not.toContain(TOKEN);
    for (const attempt of result.transport.attempts) {
      for (const [name, value] of Object.entries(attempt.request.headers)) {
        expect(`${name}=${value}`).not.toContain(TOKEN);
      }
    }
  });
});
