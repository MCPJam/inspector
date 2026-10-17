/**
 * Where a readiness run's credential goes, against real sockets.
 *
 * The credential is for the MCP endpoint. It must ride on the MCP requests a
 * run makes to that endpoint's origin, and on nothing else:
 *
 *   - not on the unauthenticated probe, or an OAuth server reads as authless
 *     and every auth check grades `not-applicable`;
 *   - not on Protected Resource Metadata, which is public;
 *   - not on authorization-server metadata, whose origin the server under test
 *     chooses. Sending it there hands the caller's token to a third party;
 *   - not on a redirect hop the server points at another origin.
 *
 * Two loopback ports are two origins, so the authorization server below is a
 * genuinely cross-origin party.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { gatherClaudeReadinessEvidence } from "../../src/claude-readiness/gather.js";
import { gradeClaudeReadiness } from "../../src/claude-readiness/runner.js";
import { traceRedirects } from "../../src/directory-readiness/discovery.js";
import {
  gatherOpenAIReadinessEvidence,
  gradeOpenAIReadiness,
} from "../../src/openai-readiness/runner.js";

const TOKEN = "Bearer good-token";
const API_KEY = "key-under-test";

interface Hit {
  origin: string;
  method: string;
  path: string;
  /** The JSON-RPC method, for a POST. */
  rpc?: string;
  /** `clientInfo.name` on an `initialize`: tells the probe from the dial. */
  client?: string;
  authorization?: string;
  apiKey?: string;
}

const servers: http.Server[] = [];
const hits: Hit[] = [];

afterEach(async () => {
  hits.length = 0;
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

async function start(
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: Record<string, any> | undefined,
    origin: string,
  ) => void,
): Promise<string> {
  let origin = "";
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let body: Record<string, any> | undefined;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = undefined;
      }
      hits.push({
        origin,
        method: req.method ?? "",
        path: req.url ?? "",
        rpc: body?.method,
        client: body?.params?.clientInfo?.name,
        authorization: req.headers.authorization,
        apiKey: req.headers["x-api-key"] as string | undefined,
      });
      handler(req, res, body, origin);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;
  return origin;
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** An authorization server on its own origin. */
async function startAuthorizationServer(): Promise<string> {
  return start((req, res, _body, origin) => {
    if (req.url?.startsWith("/.well-known/")) {
      json(res, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

/**
 * An OAuth-protected MCP server: 401 with a challenge without the token, MCP
 * with it. Its PRM names the authorization server on the other origin.
 */
async function startProtectedServer(issuer: string): Promise<string> {
  return start((req, res, body, origin) => {
    if (req.url === "/.well-known/oauth-protected-resource/mcp") {
      json(res, 200, {
        resource: `${origin}/mcp`,
        authorization_servers: [issuer],
        scopes_supported: ["orders:read"],
      });
      return;
    }
    if (req.url !== "/mcp") {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.method === "HEAD") {
      res.writeHead(405);
      res.end();
      return;
    }
    if (req.headers.authorization !== TOKEN) {
      res.writeHead(401, {
        "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
      });
      res.end();
      return;
    }
    if (body?.method === "notifications/initialized") {
      res.writeHead(202);
      res.end();
      return;
    }
    const result =
      body?.method === "initialize"
        ? {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "orders", version: "1" },
          }
        : body?.method === "tools/list"
          ? {
              tools: [
                {
                  name: "get_my_orders",
                  description: "List the signed-in user's orders.",
                  inputSchema: { type: "object" },
                  annotations: { readOnlyHint: true },
                },
              ],
            }
          : body?.method === "resources/list"
            ? { resources: [] }
            : undefined;
    json(
      res,
      200,
      result
        ? { jsonrpc: "2.0", id: body?.id, result }
        : {
            jsonrpc: "2.0",
            id: body?.id,
            error: { code: -32601, message: "Method not found" },
          },
    );
  });
}

const MCP_HEADERS = { authorization: TOKEN, "x-api-key": API_KEY };

function carriesCredential(hit: Hit): boolean {
  return hit.authorization !== undefined || hit.apiKey !== undefined;
}

/** The unauthenticated probe's `initialize`, which is not the dial's. */
function isProbe(hit: Hit): boolean {
  return (
    hit.rpc === "initialize" && hit.client !== "mcpjam-directory-readiness"
  );
}

function isEndpoint(hit: Hit, mcpOrigin: string): boolean {
  return hit.origin === mcpOrigin && hit.path === "/mcp";
}

/**
 * Every discovery request: anything not sent to the endpoint itself, plus the
 * unauthenticated probe. (The redirect trace's HEAD on the endpoint is neither
 * discovery nor the dial; the trace has its own test below.)
 */
function discoveryHits(mcpOrigin: string): Hit[] {
  return hits.filter((hit) => !isEndpoint(hit, mcpOrigin) || isProbe(hit));
}

/** The authenticated MCP requests: every POST to the endpoint but the probe. */
function dialHits(mcpOrigin: string): Hit[] {
  return hits.filter(
    (hit) =>
      isEndpoint(hit, mcpOrigin) && hit.method === "POST" && !isProbe(hit),
  );
}

describe("Claude readiness keeps the credential on the MCP endpoint", () => {
  it("sends it on the dial and nowhere else", async () => {
    const issuer = await startAuthorizationServer();
    const origin = await startProtectedServer(issuer);

    await gatherClaudeReadinessEvidence({
      enteredUrl: `${origin}/mcp`,
      fetchFn: fetch,
      mcpHeaders: MCP_HEADERS,
    });

    // The run reached every party it should have.
    expect(hits.some((hit) => hit.origin === issuer)).toBe(true);
    expect(
      hits.some(
        (hit) => hit.path === "/.well-known/oauth-protected-resource/mcp",
      ),
    ).toBe(true);
    expect(
      hits.some(
        (hit) =>
          hit.rpc === "initialize" &&
          hit.client === "mcpjam-claude-readiness",
      ),
    ).toBe(true);

    expect(discoveryHits(origin).filter(carriesCredential)).toEqual([]);
    const dial = dialHits(origin);
    expect(dial.map((hit) => hit.rpc)).toContain("tools/list");
    expect(dial.every((hit) => hit.authorization === TOKEN)).toBe(true);
    expect(dial.every((hit) => hit.apiKey === API_KEY)).toBe(true);
  });

  it("still grades the 401 contract for an OAuth server graded with a token", async () => {
    const issuer = await startAuthorizationServer();
    const origin = await startProtectedServer(issuer);

    const evidence = await gatherClaudeReadinessEvidence({
      enteredUrl: `${origin}/mcp`,
      fetchFn: fetch,
      mcpHeaders: { authorization: TOKEN },
    });
    const result = gradeClaudeReadiness(evidence);
    const finding = (id: string) =>
      result.findings.find((candidate) => candidate.id === id);

    expect(evidence.auth.unauthenticated).toMatchObject({
      status: 401,
      servedWithoutCredentials: false,
    });
    expect(finding("claude.auth.unauthenticated-challenge")?.status).toBe(
      "satisfied",
    );
    expect(
      finding("claude.auth.challenge-names-resource-metadata")?.status,
    ).toBe("satisfied");
    expect(finding("claude.auth.prm-discoverable")?.status).toBe("satisfied");
    // And the token still did its job: the dial listed the protected tools.
    expect(evidence.tools?.map((tool) => tool.name)).toEqual([
      "get_my_orders",
    ]);
  });

  it("gives the deprecated `headers` option the same narrow scope", async () => {
    const issuer = await startAuthorizationServer();
    const origin = await startProtectedServer(issuer);

    const evidence = await gatherClaudeReadinessEvidence({
      enteredUrl: `${origin}/mcp`,
      fetchFn: fetch,
      headers: MCP_HEADERS,
    });

    expect(discoveryHits(origin).filter(carriesCredential)).toEqual([]);
    expect(evidence.tools?.map((tool) => tool.name)).toEqual([
      "get_my_orders",
    ]);
  });
});

describe("OpenAI readiness keeps the credential on the MCP endpoint", () => {
  it("sends it on the dial and nowhere else", async () => {
    const issuer = await startAuthorizationServer();
    const origin = await startProtectedServer(issuer);

    await gatherOpenAIReadinessEvidence({
      target: `${origin}/mcp`,
      mode: "mcp-only",
      fetchFn: fetch,
      mcpHeaders: MCP_HEADERS,
    });

    expect(hits.some((hit) => hit.origin === issuer)).toBe(true);
    expect(
      hits.some(
        (hit) =>
          hit.rpc === "initialize" &&
          hit.client === "mcpjam-openai-readiness",
      ),
    ).toBe(true);

    expect(discoveryHits(origin).filter(carriesCredential)).toEqual([]);
    const dial = dialHits(origin);
    expect(dial.map((hit) => hit.rpc)).toContain("tools/list");
    expect(dial.every((hit) => hit.authorization === TOKEN)).toBe(true);
  });

  it("sends it on the imported-skills walk, which is an MCP request too", async () => {
    const issuer = await startAuthorizationServer();
    const origin = await startProtectedServer(issuer);

    await gatherOpenAIReadinessEvidence({
      target: `${origin}/mcp`,
      mode: "mcp-imported-skills",
      fetchFn: fetch,
      mcpHeaders: { authorization: TOKEN },
    });

    const skills = hits.filter((hit) => hit.rpc === "skills/list");
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.every((hit) => hit.authorization === TOKEN)).toBe(true);
    expect(discoveryHits(origin).filter(carriesCredential)).toEqual([]);
  });

  it("grades the auth lane instead of calling a token-graded server authless", async () => {
    const issuer = await startAuthorizationServer();
    const origin = await startProtectedServer(issuer);

    const evidence = await gatherOpenAIReadinessEvidence({
      target: `${origin}/mcp`,
      mode: "mcp-only",
      fetchFn: fetch,
      mcpHeaders: { authorization: TOKEN },
    });
    const result = gradeOpenAIReadiness(evidence);
    const finding = (id: string) =>
      result.findings.find((candidate) => candidate.id === id);

    expect(evidence.auth?.unauthenticated?.status).toBe(401);
    expect(finding("openai.auth.challenge")?.status).toBe("satisfied");
    expect(finding("openai.auth.prm-discoverable")?.status).toBe("satisfied");
    expect(evidence.tools?.map((tool) => tool.name)).toEqual([
      "get_my_orders",
    ]);
  });
});

describe("the redirect trace", () => {
  it("sends the credential only on hops on the entered URL's origin", async () => {
    const elsewhere = await start((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    const origin = await start((req, res) => {
      if (req.url === "/mcp") {
        res.writeHead(307, { location: "/mcp/" });
      } else {
        res.writeHead(302, { location: `${elsewhere}/mcp` });
      }
      res.end();
    });

    const trace = await traceRedirects({
      enteredUrl: `${origin}/mcp`,
      fetchFn: fetch,
      mcpHeaders: MCP_HEADERS,
    });

    expect(trace.redirectChain).toHaveLength(3);
    const sameOrigin = hits.filter((hit) => hit.origin === origin);
    expect(sameOrigin).toHaveLength(2);
    expect(sameOrigin.every((hit) => hit.authorization === TOKEN)).toBe(true);
    const crossOrigin = hits.filter((hit) => hit.origin === elsewhere);
    expect(crossOrigin).toHaveLength(1);
    expect(crossOrigin.filter(carriesCredential)).toEqual([]);
  });
});
