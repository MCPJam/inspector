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
): Promise<{ origin: string; hits: string[] }> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, hits };
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
    const { origin } = await start((_req, res) => {
      res.writeHead(302, { location: "https://unreachable.invalid/mcp" });
      res.end();
    });

    const evidence = await traceConnectorRedirects({
      enteredUrl: `${origin}/mcp`,
      fetchFn: fetch,
    });
    expect(evidence.redirectChain).toHaveLength(1);
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
