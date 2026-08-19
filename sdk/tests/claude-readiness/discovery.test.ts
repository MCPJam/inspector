/**
 * Discovery, against a real server.
 *
 * Two properties are worth a socket rather than a stub:
 *
 *   1. the RFC 9728 discovery ORDER — which step answers is itself reported,
 *      because a server discoverable only at the root well-known path is
 *      reachable by luck rather than by the documented walk;
 *   2. the redirect TRACE — the transport follows redirects internally and
 *      reports only where it landed, so a chain that downgrades mid-way and
 *      recovers is invisible unless discovery walks it by hand.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  discoverClaudeAuthEvidence,
  traceConnectorRedirects,
} from "../../src/claude-readiness/discovery.js";

const servers: http.Server[] = [];

async function start(
  handler: http.RequestListener,
): Promise<{
  origin: string;
  hits: string[];
  /** Request headers, index-aligned with `hits`. */
  headers: Array<Record<string, string | undefined>>;
}> {
  const hits: string[] = [];
  const headers: Array<Record<string, string | undefined>> = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    headers.push({ ...req.headers } as Record<string, string | undefined>);
    handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, hits, headers };
}

/** An origin nothing listens on: opened to claim a port, then closed. */
async function closedLoopbackOrigin(): Promise<string> {
  const server = http.createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
});

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

describe("the unauthenticated probe", () => {
  it("captures the status and the challenge from an initialize", async () => {
    const { origin, hits } = await start((_req, res) => {
      res.writeHead(401, {
        "www-authenticate": `Bearer resource_metadata="/.well-known/oauth-protected-resource/mcp"`,
      });
      res.end();
    });

    const evidence = await discoverClaudeAuthEvidence({
      enteredUrl: `${origin}/mcp`,
      fetchFn: fetch,
    });

    expect(evidence.unauthenticated).toMatchObject({
      status: 401,
      servedWithoutCredentials: false,
      representsProtectedOperation: true,
    });
    expect(hits[0]).toBe("POST /mcp");
  });

  it("only calls a 200 'served without credentials' when MCP actually answered", async () => {
    // An HTML error page is a 200 too. Treating that as a served MCP request
    // would classify a broken server as authless.
    const { origin } = await start((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>gateway</html>");
    });

    const evidence = await discoverClaudeAuthEvidence({
      enteredUrl: `${origin}/mcp`,
      fetchFn: fetch,
    });
    expect(evidence.unauthenticated?.servedWithoutCredentials).toBe(false);
  });

  it("records a genuine MCP result as served without credentials", async () => {
    const { origin } = await start((_req, res) => {
      json(res, 200, { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } });
    });

    const evidence = await discoverClaudeAuthEvidence({
      enteredUrl: `${origin}/mcp`,
      fetchFn: fetch,
    });
    expect(evidence.unauthenticated?.servedWithoutCredentials).toBe(true);
  });

  it("reads an SSE answer, which Streamable HTTP lets a server choose", async () => {
    // The probe advertises `text/event-stream`, so answering with one is
    // conforming. Parsing it as JSON would fail and record a working authless
    // connector as one that never answered — a required runtime-blocker
    // violation manufactured entirely by the probe.
    const { origin } = await start((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: message\n");
      res.write(
        `data: ${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { protocolVersion: "2025-06-18" },
        })}\n\n`,
      );
      // Deliberately left OPEN: a server may keep the stream up after
      // answering, and the probe must not wait for it to close.
    });

    const evidence = await discoverClaudeAuthEvidence({
      enteredUrl: `${origin}/mcp`,
      fetchFn: fetch,
      timeoutMs: 5_000,
    });
    expect(evidence.unauthenticated?.servedWithoutCredentials).toBe(true);
  });

  it("reads an SSE error frame as an answer too", async () => {
    const { origin } = await start((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32600, message: "no" },
        })}\n\n`,
      );
    });

    const evidence = await discoverClaudeAuthEvidence({
      enteredUrl: `${origin}/mcp`,
      fetchFn: fetch,
      timeoutMs: 5_000,
    });
    expect(evidence.unauthenticated?.servedWithoutCredentials).toBe(true);
  });

  it("does not call an SSE stream carrying no JSON-RPC message an answer", async () => {
    const { origin } = await start((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": keepalive\n\n");
      res.end();
    });

    const evidence = await discoverClaudeAuthEvidence({
      enteredUrl: `${origin}/mcp`,
      fetchFn: fetch,
      timeoutMs: 5_000,
    });
    expect(evidence.unauthenticated?.servedWithoutCredentials).toBe(false);
  });
});

describe("PRM discovery order", () => {
  it("follows the challenge pointer first and does not guess a well-known path", async () => {
    const { origin, hits } = await start((req, res) => {
      if (req.url === "/mcp") {
        res.writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="/custom/prm.json"`,
        });
        res.end();
        return;
      }
      if (req.url === "/custom/prm.json") {
        json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [] });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const evidence = await discoverClaudeAuthEvidence({
      enteredUrl: `${origin}/mcp`,
      fetchFn: fetch,
    });

    expect(evidence.prm?.discoveredVia).toBe("www-authenticate");
    expect(hits).not.toContain("GET /.well-known/oauth-protected-resource/mcp");
  });

  it("falls back to the path-suffixed well-known form", async () => {
    const { origin } = await start((req, res) => {
      if (req.url === "/mcp") {
        res.writeHead(401);
        res.end();
        return;
      }
      if (req.url === "/.well-known/oauth-protected-resource/mcp") {
        json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [] });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const evidence = await discoverClaudeAuthEvidence({
      enteredUrl: `${origin}/mcp`,
      fetchFn: fetch,
    });
    expect(evidence.prm?.discoveredVia).toBe("well-known-path-suffixed");
  });

  it("reports the root well-known form as such, so 'reachable by luck' is visible", async () => {
    const { origin } = await start((req, res) => {
      if (req.url === "/.well-known/oauth-protected-resource") {
        json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [] });
        return;
      }
      res.writeHead(401);
      res.end();
    });

    const evidence = await discoverClaudeAuthEvidence({
      enteredUrl: `${origin}/mcp`,
      fetchFn: fetch,
    });
    expect(evidence.prm?.discoveredVia).toBe("well-known-root");
  });

  it("reports not-found with the last error rather than throwing", async () => {
    const { origin } = await start((_req, res) => {
      res.writeHead(404);
      res.end();
    });

    const evidence = await discoverClaudeAuthEvidence({
      enteredUrl: `${origin}/mcp`,
      fetchFn: fetch,
    });
    expect(evidence.prm?.discoveredVia).toBe("not-found");
    expect(evidence.prm?.fetchError).toContain("404");
  });
});

describe("authorization server metadata", () => {
  it("reads entry zero only, never a later entry", async () => {
    const auth = await start((req, res) => {
      if (req.url?.startsWith("/.well-known/")) {
        json(res, 200, { issuer: "second", code_challenge_methods_supported: ["S256"] });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const { origin } = await start((req, res) => {
      if (req.url === "/.well-known/oauth-protected-resource/mcp") {
        json(res, 200, {
          resource: "x",
          authorization_servers: ["https://broken.invalid", auth.origin],
        });
        return;
      }
      res.writeHead(401);
      res.end();
    });

    const evidence = await discoverClaudeAuthEvidence({
      enteredUrl: `${origin}/mcp`,
      fetchFn: fetch,
    });

    expect(evidence.firstAuthorizationServer?.issuer).toBe("https://broken.invalid");
    expect(evidence.firstAuthorizationServer?.reachable).toBe(false);
    // The healthy second entry was never dialled — probing it would grade a
    // client that falls back, which Claude is not.
    expect(auth.hits).toEqual([]);
  });
});

describe("the redirect trace", () => {
  it("records every hop, including one that downgrades and recovers", async () => {
    const final = await start((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    const middle = await start((_req, res) => {
      res.writeHead(302, { location: `${final.origin}/mcp` });
      res.end();
    });
    const { origin } = await start((_req, res) => {
      res.writeHead(302, { location: `${middle.origin}/mcp` });
      res.end();
    });

    const evidence = await traceConnectorRedirects({
      enteredUrl: `${origin}/mcp`,
      fetchFn: fetch,
    });

    expect(evidence.redirectChain).toHaveLength(3);
    expect(evidence.redirectChain?.[0].location).toBe(`${middle.origin}/mcp`);
    expect(evidence.redirectLimitHit).toBeUndefined();
  });

  it("stops at the ceiling and says so", async () => {
    const { origin } = await start((_req, res) => {
      res.writeHead(302, { location: "/again" });
      res.end();
    });

    const evidence = await traceConnectorRedirects({
      enteredUrl: `${origin}/mcp`,
      fetchFn: fetch,
      maxRedirects: 2,
    });
    expect(evidence.redirectLimitHit).toBe(true);
    expect(evidence.redirectChain).toHaveLength(3);
  });

  it("returns the partial chain when a hop is unreachable", async () => {
    // A port we listened on and then closed refuses immediately. Relying on a
    // reserved `.invalid` name instead makes the case depend on the resolver:
    // a wildcard or captive one answers with a routable address, and the test
    // then waits out a timeout to reach the same assertion.
    const deadOrigin = await closedLoopbackOrigin();
    const { origin } = await start((_req, res) => {
      res.writeHead(302, { location: `${deadOrigin}/mcp` });
      res.end();
    });

    const evidence = await traceConnectorRedirects({
      enteredUrl: `${origin}/mcp`,
      fetchFn: fetch,
    });
    expect(evidence.redirectChain).toHaveLength(1);
  });
});

describe("the resource_metadata pointer is not trusted", () => {
  it("refuses an off-origin pointer and never dials it", async () => {
    const attacker = await start((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ resource: "x", authorization_servers: [] }));
    });
    const { origin } = await start((req, res) => {
      if (req.url === "/mcp") {
        res.writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="${attacker.origin}/prm.json"`,
        });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const evidence = await discoverClaudeAuthEvidence({
      enteredUrl: `${origin}/mcp`,
      fetchFn: fetch,
    });

    // The pointer arrives in a header from the server under test; `new URL()`
    // would happily accept `http://169.254.169.254/…` here.
    expect(attacker.hits).toEqual([]);
    expect(evidence.prm?.rejectedPointer).toBe(`${attacker.origin}/prm.json`);
  });

  it("refuses a non-http scheme", async () => {
    const { origin } = await start((_req, res) => {
      res.writeHead(401, {
        "www-authenticate": `Bearer resource_metadata="file:///etc/passwd"`,
      });
      res.end();
    });

    const evidence = await discoverClaudeAuthEvidence({
      enteredUrl: `${origin}/mcp`,
      fetchFn: fetch,
    });
    expect(evidence.prm?.rejectedPointer).toBe("file:///etc/passwd");
  });

  it("still follows a same-origin pointer", async () => {
    const { origin } = await start((req, res) => {
      if (req.url === "/custom/prm.json") {
        json(res, 200, { resource: "x", authorization_servers: [] });
        return;
      }
      res.writeHead(401, {
        "www-authenticate": `Bearer resource_metadata="/custom/prm.json"`,
      });
      res.end();
    });

    const evidence = await discoverClaudeAuthEvidence({
      enteredUrl: `${origin}/mcp`,
      fetchFn: fetch,
    });
    expect(evidence.prm?.discoveredVia).toBe("www-authenticate");
    expect(evidence.prm?.rejectedPointer).toBeUndefined();
  });
});

describe("metadata documents are bounded", () => {
  it("refuses a body that declares a size over the cap, before reading it", async () => {
    const { origin } = await start((req, res) => {
      if (req.url?.startsWith("/.well-known/")) {
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": String(64 * 1024 * 1024),
        });
        res.end("{}");
        return;
      }
      res.writeHead(401);
      res.end();
    });

    const evidence = await discoverClaudeAuthEvidence({
      enteredUrl: `${origin}/mcp`,
      fetchFn: fetch,
    });
    expect(evidence.prm?.discoveredVia).toBe("not-found");
    expect(evidence.prm?.fetchError).toMatch(/over the .* cap/);
  });

  it("stops reading an oversized body that declared no length", async () => {
    const { origin } = await start((req, res) => {
      if (req.url?.startsWith("/.well-known/")) {
        res.writeHead(200, { "content-type": "application/json" });
        // Chunked, so there is no content-length to pre-empt on.
        for (let i = 0; i < 12; i += 1) res.write("x".repeat(64 * 1024));
        res.end();
        return;
      }
      res.writeHead(401);
      res.end();
    });

    const evidence = await discoverClaudeAuthEvidence({
      enteredUrl: `${origin}/mcp`,
      fetchFn: fetch,
    });
    expect(evidence.prm?.discoveredVia).toBe("not-found");
    expect(evidence.prm?.fetchError).toMatch(/exceeded/);
  });
});

describe("the transport is the caller's", () => {
  it("never reaches the global fetch on its own", async () => {
    // A default `fetchFn` would make "forgot to pass the guard" the silent
    // case, and the silent case is the one that reaches 169.254.169.254.
    const spy = vi.fn<typeof fetch>(async () => new Response("{}", { status: 404 }));
    await discoverClaudeAuthEvidence({
      enteredUrl: "https://mcp.example.com/mcp",
      fetchFn: spy,
    });
    expect(spy).toHaveBeenCalled();
    for (const [input] of spy.mock.calls) {
      expect(String(input)).toContain("mcp.example.com");
    }
  });
});

describe("whether anything answered is recorded separately from what it said", () => {
  // `discoveredVia: "not-found"` covers two different worlds, and the checks
  // grade them differently: a server that answered 404 publishes no metadata,
  // a host that never answered was never asked.
  it("records reachedServer: false when nothing on the origin answers", async () => {
    const origin = await closedLoopbackOrigin();
    const evidence = await discoverClaudeAuthEvidence({
      enteredUrl: `${origin}/mcp`,
      fetchFn: fetch,
      timeoutMs: 2_000,
    });
    expect(evidence.prm?.discoveredVia).toBe("not-found");
    expect(evidence.prm?.reachedServer).toBe(false);
  });

  it("records reachedServer: true when the server answers 404", async () => {
    const { origin } = await start((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    const evidence = await discoverClaudeAuthEvidence({
      enteredUrl: `${origin}/mcp`,
      fetchFn: fetch,
    });
    expect(evidence.prm?.discoveredVia).toBe("not-found");
    expect(evidence.prm?.reachedServer).toBe(true);
  });

  it("records reachedServer: true alongside a successful discovery", async () => {
    const { origin } = await start((req, res) => {
      if (req.url === "/.well-known/oauth-protected-resource/mcp") {
        json(res, 200, { resource: "x", authorization_servers: [] });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const evidence = await discoverClaudeAuthEvidence({
      enteredUrl: `${origin}/mcp`,
      fetchFn: fetch,
    });
    expect(evidence.prm?.discoveredVia).toBe("well-known-path-suffixed");
    expect(evidence.prm?.reachedServer).toBe(true);
  });
});

describe("the caller's credentials go to the connector and nowhere else", () => {
  // A `--header "Authorization: …"` is a credential for the SERVER UNDER TEST.
  // Every other host discovery dials is named by that server's own documents,
  // so replaying the header onto them would let any target collect it.
  it("never sends caller headers to the authorization server's origin", async () => {
    // A STUB transport rather than a socket: an authorization server on
    // another origin has to be `https` to be dialled at all, and what this
    // proves is about headers, not TLS.
    const seen: Array<{ url: string; authorization: string | null }> = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      seen.push({ url, authorization: headers.get("authorization") });
      if (url.endsWith("/.well-known/oauth-protected-resource/mcp")) {
        return Response.json({
          resource: "https://connector.example/mcp",
          // A DIFFERENT origin, which is entirely legitimate for an
          // authorization server and is exactly why same-origin cannot be the
          // rule for reaching one.
          authorization_servers: ["https://auth.example"],
        });
      }
      if (url.startsWith("https://auth.example")) {
        return Response.json({
          issuer: "https://auth.example",
          authorization_endpoint: "https://auth.example/authorize",
          token_endpoint: "https://auth.example/token",
        });
      }
      return new Response(null, {
        status: 401,
        headers: { "www-authenticate": "Bearer" },
      });
    };

    await discoverClaudeAuthEvidence({
      enteredUrl: "https://connector.example/mcp",
      fetchFn,
      headers: { authorization: "Bearer super-secret" },
    });

    const authRequests = seen.filter((entry) =>
      entry.url.startsWith("https://auth.example"),
    );
    expect(authRequests.length).toBeGreaterThan(0);
    expect(authRequests.every((entry) => entry.authorization === null)).toBe(
      true,
    );
    // And the connector's own well-known DID carry it, so this is scoping
    // rather than a header that stopped being sent at all.
    expect(
      seen.some(
        (entry) =>
          entry.url.startsWith("https://connector.example") &&
          entry.authorization === "Bearer super-secret",
      ),
    ).toBe(true);
  });

  it("does not send them on the unauthenticated probe either", async () => {
    // The probe's whole question is "what does this server do for a client
    // with no credentials". Answering it with a credentialed request produced
    // a 200 that `servedWithoutCredentials` recorded as "authless".
    const connector = await start((_req, res) => {
      json(res, 200, { jsonrpc: "2.0", id: 1, result: {} });
    });

    const evidence = await discoverClaudeAuthEvidence({
      enteredUrl: `${connector.origin}/mcp`,
      fetchFn: fetch,
      headers: { authorization: "Bearer super-secret" },
    });

    const probe = connector.headers[0];
    expect(probe?.authorization).toBeUndefined();
    // And the classification stands on a request that really had none.
    expect(evidence.unauthenticated?.servedWithoutCredentials).toBe(true);
  });

  it("still sends them to the connector's own well-known path", async () => {
    // Same origin as the connector: no third party sees it, and a connector
    // that gates its own metadata behind a header stays reachable.
    const connector = await start((req, res) => {
      if (req.url === "/.well-known/oauth-protected-resource/mcp") {
        json(res, 200, { resource: "x", authorization_servers: [] });
        return;
      }
      res.writeHead(401, { "www-authenticate": "Bearer" });
      res.end();
    });

    await discoverClaudeAuthEvidence({
      enteredUrl: `${connector.origin}/mcp`,
      fetchFn: fetch,
      headers: { "x-tenant": "acme" },
    });

    const wellKnown = connector.headers.find(
      (_entry, index) =>
        connector.hits[index] ===
        "GET /.well-known/oauth-protected-resource/mcp",
    );
    expect(wellKnown?.["x-tenant"]).toBe("acme");
  });
});

describe("an authorization server issuer is validated before it is dialled", () => {
  async function evidenceForIssuer(issuer: string) {
    const connector = await start((req, res) => {
      if (req.url === "/.well-known/oauth-protected-resource/mcp") {
        json(res, 200, { resource: "x", authorization_servers: [issuer] });
        return;
      }
      res.writeHead(401, { "www-authenticate": "Bearer" });
      res.end();
    });
    return {
      connector,
      evidence: await discoverClaudeAuthEvidence({
        enteredUrl: `${connector.origin}/mcp`,
        fetchFn: fetch,
      }),
    };
  }

  it.each([
    ["a plaintext third-party host", "http://169.254.169.254/"],
    ["a non-http scheme", "file:///etc/passwd"],
    ["credentials in the URL", "https://user:pw@auth.example.com"],
    ["a query string", "https://auth.example.com/?next=x"],
  ])("refuses %s without fetching it", async (_label, issuer) => {
    const { evidence } = await evidenceForIssuer(issuer);
    expect(evidence.firstAuthorizationServer?.reachable).toBe(false);
    // `rejected` rather than only `fetchError`: "we would not fetch this" is a
    // different problem from "we fetched it and it failed", and reporting the
    // second sends the submitter to look at DNS.
    expect(evidence.firstAuthorizationServer?.rejected).toBeTruthy();
    expect(evidence.firstAuthorizationServer?.metadataUrl).toBeUndefined();
  });

  it("allows plaintext when the issuer IS the connector's own origin", async () => {
    // A developer testing their own server over loopback http. Nothing leaves
    // the origin the caller already typed, so refusing it would only break
    // local development without protecting anything.
    let origin = "";
    const connector = await start((req, res) => {
      if (req.url === "/.well-known/oauth-protected-resource/mcp") {
        json(res, 200, { resource: "x", authorization_servers: [origin] });
        return;
      }
      if (req.url?.startsWith("/.well-known/oauth-authorization-server")) {
        json(res, 200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          code_challenge_methods_supported: ["S256"],
        });
        return;
      }
      res.writeHead(401, { "www-authenticate": "Bearer" });
      res.end();
    });
    origin = connector.origin;

    const evidence = await discoverClaudeAuthEvidence({
      enteredUrl: `${connector.origin}/mcp`,
      fetchFn: fetch,
    });
    expect(evidence.firstAuthorizationServer?.rejected).toBeUndefined();
    expect(evidence.firstAuthorizationServer?.reachable).toBe(true);
  });

  it("refuses plaintext on a different port of the same host", async () => {
    // Origin, not host: a scheme or port change is a different origin, and a
    // credential that travels between them has left the place it belongs.
    const { evidence } = await evidenceForIssuer("http://127.0.0.1:9/");
    expect(evidence.firstAuthorizationServer?.rejected).toBeTruthy();
  });
});

describe("a body that fails to read is still a server that answered", () => {
  it("keeps the response status when the body read throws", async () => {
    // `reachedServer` is decided on this exact difference. Reporting 0 for a
    // body-read failure turned a PRM failure into "we never asked".
    const fetchFn: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("connection reset mid-body"));
          },
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      );

    const evidence = await discoverClaudeAuthEvidence({
      enteredUrl: "https://mcp.example.com/mcp",
      fetchFn,
    });
    expect(evidence.prm?.discoveredVia).toBe("not-found");
    expect(evidence.prm?.reachedServer).toBe(true);
  });
});
