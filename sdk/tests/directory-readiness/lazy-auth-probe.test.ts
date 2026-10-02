/**
 * The lazy-authentication probe, against real sockets.
 *
 * A lazy server answers an unauthenticated `initialize` exactly like an
 * authless one. Only a protected call made without credentials tells them
 * apart, so every case here drives one against a loopback server and grades
 * what came back:
 *
 *   - the probe never sends a credential, even when the run holds one;
 *   - it calls read-only tools only, at most two of them;
 *   - a server that serves its metadata ONLY at the challenge's
 *     `resource_metadata` path is graded on that metadata, because discovery
 *     runs again from the protected call's challenge;
 *   - each publisher applies its own host's trigger: Claude needs a 401 with
 *     `WWW-Authenticate`, OpenAI needs `_meta["mcp/www_authenticate"]` on an
 *     `oauth2` tool with both `error` and `error_description`.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { gatherClaudeReadinessEvidence } from "../../src/claude-readiness/gather.js";
import { gradeClaudeReadiness } from "../../src/claude-readiness/runner.js";
import {
  gatherOpenAIReadinessEvidence,
  gradeOpenAIReadiness,
} from "../../src/openai-readiness/runner.js";
import { resolveLazyAuthProbeMode } from "../../src/directory-readiness/lazy-auth.js";
import { probeLazyAuthentication } from "../../src/directory-readiness/lazy-auth-probe.js";
import { dialToolListing, dialInitialize } from "../../src/directory-readiness/mcp-dial.js";

const TOKEN = "Bearer run-token";
const POINTER_PATH = "/meta/protected-resource.json";

interface Hit {
  method: string;
  path: string;
  rpc?: string;
  tool?: string;
  authorization?: string;
}

type Refusal = "bearer-401" | "bare-401" | "meta";

interface LazyServerOptions {
  refusal: Refusal;
  /** Where PRM is served. `pointer-only`: nowhere but the challenge's pointer. */
  prmAt?: "pointer-only" | "well-known";
  /** Shape of `_meta["mcp/www_authenticate"]`. OpenAI documents an array. */
  metaShape?: "array" | "string";
  /** Whether the `_meta` challenge carries error + error_description. */
  metaErrorParams?: boolean;
  /** `securitySchemes` on the protected tool; `null` leaves it undeclared. */
  protectedSchemes?: unknown;
  /** Refuse even `initialize`: a server that is not lazy at all. */
  initialize401?: boolean;
  /**
   * `get_weather` requires a `city`, and a call without one fails input
   * validation: as a JSON-RPC `-32602`, or as an `isError` result.
   */
  weatherRequiresCity?: "rpc-error" | "tool-error";
  /** Also list `get_time`: public, read-only, and takes no arguments. */
  withNoArgPublicTool?: boolean;
}

const servers: http.Server[] = [];
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

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function startLazyServer(options: LazyServerOptions): Promise<{
  origin: string;
  url: string;
  hits: Hit[];
}> {
  const hits: Hit[] = [];
  let origin = "";
  const prmAt = options.prmAt ?? "pointer-only";
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
        method: req.method ?? "",
        path: req.url ?? "",
        rpc: body?.method,
        tool: body?.params?.name,
        authorization: req.headers.authorization,
      });

      const prm = {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: ["orders:read"],
      };
      if (req.url === POINTER_PATH) return json(res, 200, prm);
      if (req.url?.startsWith("/.well-known/oauth-protected-resource")) {
        return prmAt === "well-known"
          ? json(res, 200, prm)
          : json(res, 404, { error: "not here" });
      }
      if (req.url?.startsWith("/.well-known/oauth-authorization-server")) {
        return json(res, 200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          authorization_response_iss_parameter_supported: true,
        });
      }
      if (req.url !== "/mcp") return json(res, 404, {});
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }

      const challenge = `Bearer resource_metadata="${origin}${POINTER_PATH}", scope="orders:read"`;
      const authed = req.headers.authorization === TOKEN;
      if (body?.method === "initialize") {
        if (options.initialize401 && !authed) {
          res.writeHead(401, { "www-authenticate": challenge });
          res.end();
          return;
        }
        return json(res, 200, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "shop", version: "1" },
          },
        });
      }
      if (body?.method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      if (body?.method === "tools/list") {
        const protectedTool: Record<string, unknown> = {
          name: "get_my_orders",
          description: "The signed-in user's orders.",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        };
        const schemes =
          options.protectedSchemes === undefined
            ? [{ type: "oauth2", scopes: ["orders:read"] }]
            : options.protectedSchemes;
        if (schemes !== null) protectedTool.securitySchemes = schemes;
        return json(res, 200, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [
              {
                name: "get_weather",
                description: "Public weather.",
                inputSchema: options.weatherRequiresCity
                  ? {
                      type: "object",
                      properties: { city: { type: "string" } },
                      required: ["city"],
                    }
                  : { type: "object" },
                annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
                securitySchemes: [{ type: "noauth" }],
              },
              ...(options.withNoArgPublicTool
                ? [
                    {
                      name: "get_time",
                      description: "Public clock.",
                      inputSchema: { type: "object", properties: {} },
                      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
                      securitySchemes: [{ type: "noauth" }],
                    },
                  ]
                : []),
              protectedTool,
              {
                name: "cancel_order",
                description: "Cancels an order.",
                inputSchema: { type: "object" },
                annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
                securitySchemes: [{ type: "oauth2", scopes: ["orders:write"] }],
              },
            ],
          },
        });
      }
      if (body?.method === "tools/call") {
        const name = body.params?.name;
        if (name === "get_time") {
          return json(res, 200, {
            jsonrpc: "2.0",
            id: body.id,
            result: { content: [{ type: "text", text: "noon" }] },
          });
        }
        if (
          name === "get_weather" &&
          options.weatherRequiresCity &&
          typeof body.params?.arguments?.city !== "string"
        ) {
          return options.weatherRequiresCity === "rpc-error"
            ? json(res, 200, {
                jsonrpc: "2.0",
                id: body.id,
                error: { code: -32602, message: "Invalid params: city is required" },
              })
            : json(res, 200, {
                jsonrpc: "2.0",
                id: body.id,
                result: {
                  isError: true,
                  content: [
                    {
                      type: "text",
                      text: "MCP error -32602: Input validation error: Invalid arguments for tool get_weather",
                    },
                  ],
                },
              });
        }
        if (name === "get_weather") {
          return json(res, 200, {
            jsonrpc: "2.0",
            id: body.id,
            result: { content: [{ type: "text", text: "sunny" }] },
          });
        }
        if (authed) {
          return json(res, 200, {
            jsonrpc: "2.0",
            id: body.id,
            result: { content: [{ type: "text", text: "ok" }] },
          });
        }
        if (options.refusal === "bearer-401") {
          res.writeHead(401, { "www-authenticate": challenge });
          res.end();
          return;
        }
        if (options.refusal === "bare-401") {
          res.writeHead(401);
          res.end();
          return;
        }
        const metaChallenge = `Bearer resource_metadata="${origin}${POINTER_PATH}"${
          options.metaErrorParams === false
            ? ""
            : ', error="invalid_token", error_description="Sign in to see your orders"'
        }`;
        return json(res, 200, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            isError: true,
            content: [{ type: "text", text: "Sign in required" }],
            _meta: {
              "mcp/www_authenticate":
                options.metaShape === "string" ? metaChallenge : [metaChallenge],
            },
          },
        });
      }
      if (body?.method === "resources/list") {
        return json(res, 200, { jsonrpc: "2.0", id: body.id, result: { resources: [] } });
      }
      return json(res, 200, {
        jsonrpc: "2.0",
        id: body?.id,
        error: { code: -32601, message: "Method not found" },
      });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;
  return { origin, url: `${origin}/mcp`, hits };
}

const NOW = () => new Date("2026-10-01T00:00:00.000Z");
const toolCalls = (hits: Hit[]) => hits.filter((hit) => hit.rpc === "tools/call");
const byId = <T extends { id: string }>(findings: T[], id: string) =>
  findings.find((finding) => finding.id === id)!;

// ── Claude ──────────────────────────────────────────────────────────────

describe("Claude: the probe and the metadata only the protected call reveals", () => {
  it("grades the OAuth lanes of a server whose PRM lives only at the challenge pointer", async () => {
    const server = await startLazyServer({ refusal: "bearer-401" });

    // WITHOUT the probe the server reads as authless: nothing at the
    // well-known paths, and an initialize that succeeds anonymously.
    const unprobed = gradeClaudeReadiness(
      await gatherClaudeReadinessEvidence({
        enteredUrl: server.url,
        fetchFn: fetch,
        now: NOW,
      }),
    );
    expect(byId(unprobed.findings, "claude.auth.prm-discoverable").status).toBe(
      "not-applicable",
    );

    const evidence = await gatherClaudeReadinessEvidence({
      enteredUrl: server.url,
      fetchFn: fetch,
      // The run holds a credential. The probe must not use it.
      mcpHeaders: { authorization: TOKEN },
      lazyAuthProbe: {
        enabled: true,
        toolName: "get_my_orders",
        publicToolName: "get_weather",
      },
      now: NOW,
    });
    const result = gradeClaudeReadiness(evidence);

    expect(evidence.lazyAuthProbe?.rediscovery).toMatchObject({
      trigger: "resource_metadata",
      source: "http_401",
      prmFound: true,
      discoveredVia: "www-authenticate",
    });
    for (const id of [
      "claude.auth.prm-discoverable",
      "claude.auth.prm-resource-matches-entered-url",
      "claude.auth.first-authorization-server-usable",
      "claude.auth.pkce-s256-advertised",
      "claude.auth.client-acquisition-path",
      "claude.auth.unauthenticated-challenge",
      "claude.auth.challenge-names-resource-metadata",
    ]) {
      expect(byId(result.findings, id).status, id).toBe("satisfied");
    }
    expect(
      result.badges.find((badge) => badge.id === "claude.features.lazy-authentication"),
    ).toMatchObject({ state: "supported", provenance: "wire" });

    // Two calls, read-only tools only, and no credential on any of them.
    const calls = toolCalls(server.hits);
    expect(calls.map((hit) => hit.tool)).toEqual(["get_weather", "get_my_orders"]);
    expect(calls.every((hit) => hit.authorization === undefined)).toBe(true);
    expect(server.hits.some((hit) => hit.tool === "cancel_order")).toBe(false);
    // The anonymous session is the probe's own: its initialize carried nothing.
    const anonymousInitializes = server.hits.filter(
      (hit) => hit.rpc === "initialize" && hit.authorization === undefined,
    );
    expect(anonymousInitializes.length).toBeGreaterThanOrEqual(2);
    expect(evidence.lazyAuthProbe?.protocolVersion).toBe("2025-06-18");
    expect(evidence.lazyAuthProbe?.eraNote).toMatch(/session-based/);
  });

  it("calls a headerless 401 unsupported, quoting Claude's trigger", async () => {
    const server = await startLazyServer({ refusal: "bare-401", prmAt: "well-known" });
    const result = gradeClaudeReadiness(
      await gatherClaudeReadinessEvidence({
        enteredUrl: server.url,
        fetchFn: fetch,
        lazyAuthProbe: { enabled: true, toolName: "get_my_orders", publicToolName: "get_weather" },
        now: NOW,
      }),
    );
    const badge = result.badges.find(
      (entry) => entry.id === "claude.features.lazy-authentication",
    )!;
    expect(badge.state).toBe("unsupported");
    expect(badge.detail).toMatch(/Claude starts sign-in only on HTTP 401 with WWW-Authenticate/);
    expect(byId(result.findings, "claude.auth.unauthenticated-challenge").status).toBe(
      "violated",
    );
    // The PRM is still graded: it is published at the well-known path.
    expect(byId(result.findings, "claude.auth.prm-discoverable").status).toBe("satisfied");
  });

  it("calls a _meta-only refusal unsupported, and never follows its pointer", async () => {
    const server = await startLazyServer({ refusal: "meta" });
    const evidence = await gatherClaudeReadinessEvidence({
      enteredUrl: server.url,
      fetchFn: fetch,
      lazyAuthProbe: { enabled: true, toolName: "get_my_orders", publicToolName: "get_weather" },
      now: NOW,
    });
    const result = gradeClaudeReadiness(evidence);
    const badge = result.badges.find(
      (entry) => entry.id === "claude.features.lazy-authentication",
    )!;
    expect(badge.state).toBe("unsupported");
    expect(badge.detail).toMatch(/a 200 isError result is an ordinary tool failure to Claude/);
    // Claude acts on the HTTP challenge only, so the `_meta` pointer is one
    // Claude never reaches; discovery is not re-run from it.
    expect(evidence.lazyAuthProbe?.rediscovery).toBeUndefined();
    expect(server.hits.some((hit) => hit.path === POINTER_PATH)).toBe(false);
  });

  it("records a server that refuses initialize as not lazy", async () => {
    const server = await startLazyServer({ refusal: "bearer-401", initialize401: true });
    const evidence = await gatherClaudeReadinessEvidence({
      enteredUrl: server.url,
      fetchFn: fetch,
      lazyAuthProbe: { enabled: true, toolName: "get_my_orders" },
      now: NOW,
    });
    expect(evidence.lazyAuthProbe?.initialize).toMatchObject({ ok: false, status: 401 });
    expect(evidence.lazyAuthProbe?.reason).toMatch(/not lazy/);
    expect(toolCalls(server.hits)).toEqual([]);
    const badge = gradeClaudeReadiness(evidence).badges.find(
      (entry) => entry.id === "claude.features.lazy-authentication",
    )!;
    expect(badge.state).toBe("unsupported");
  });
});

// ── OpenAI ──────────────────────────────────────────────────────────────

describe("OpenAI: the runtime challenge, observed", () => {
  it("satisfies runtime-challenge from a _meta array on an oauth2 tool, and grades the PRM it names", async () => {
    const server = await startLazyServer({ refusal: "meta", metaShape: "array" });
    const evidence = await gatherOpenAIReadinessEvidence({
      target: server.url,
      mode: "mcp-only",
      fetchFn: fetch,
      mcpHeaders: { authorization: TOKEN },
      // No names: the probe picks by securitySchemes — `noauth` for the
      // public call, `oauth2` only for the protected one.
      lazyAuthProbe: { enabled: true },
      claimedFeatures: ["lazy-authentication"],
      now: NOW,
    });
    const result = gradeOpenAIReadiness(evidence);

    expect(evidence.lazyAuthProbe?.publicCall).toMatchObject({
      toolName: "get_weather",
      selectedBy: "security-schemes",
      outcome: "succeeded",
    });
    expect(evidence.lazyAuthProbe?.protectedCall).toMatchObject({
      toolName: "get_my_orders",
      selectedBy: "security-schemes",
      outcome: "tool-error",
      challenge: {
        source: "tool_result_meta",
        facets: { hasErrorParams: true, hasResourceMetadata: true },
      },
    });
    expect(evidence.lazyAuthProbe?.rediscovery).toMatchObject({
      trigger: "resource_metadata",
      source: "tool_result_meta",
      prmFound: true,
    });

    expect(byId(result.findings, "openai.auth.runtime-challenge").status).toBe("satisfied");
    expect(byId(result.findings, "openai.auth.prm-discoverable").status).toBe("satisfied");
    expect(byId(result.findings, "openai.auth.pkce-s256").status).toBe("satisfied");
    expect(byId(result.findings, "openai.auth.challenge").status).toBe("not-applicable");
    expect(
      result.badges.find((badge) => badge.id === "openai.feature.lazy-authentication"),
    ).toMatchObject({ state: "supported" });

    const calls = toolCalls(server.hits);
    expect(calls).toHaveLength(2);
    expect(calls.every((hit) => hit.authorization === undefined)).toBe(true);
    expect(calls.some((hit) => hit.tool === "cancel_order")).toBe(false);
  });

  it("requires both error and error_description in the _meta challenge", async () => {
    const server = await startLazyServer({ refusal: "meta", metaShape: "string", metaErrorParams: false });
    const result = gradeOpenAIReadiness(
      await gatherOpenAIReadinessEvidence({
        target: server.url,
        mode: "mcp-only",
        fetchFn: fetch,
        lazyAuthProbe: { enabled: true },
        now: NOW,
      }),
    );
    const runtime = byId(result.findings, "openai.auth.runtime-challenge");
    expect(runtime.status).toBe("violated");
    expect(runtime.remediation).toMatch(/error and error_description/);
  });

  it("reports an undeclared tool as inheriting the server default (unresolved), not as no OAuth", async () => {
    const server = await startLazyServer({ refusal: "meta", protectedSchemes: null });
    const result = gradeOpenAIReadiness(
      await gatherOpenAIReadinessEvidence({
        target: server.url,
        mode: "mcp-only",
        fetchFn: fetch,
        lazyAuthProbe: { enabled: true, toolName: "get_my_orders" },
        now: NOW,
      }),
    );
    const runtime = byId(result.findings, "openai.auth.runtime-challenge");
    expect(runtime.status).toBe("not-evaluated");
    expect(runtime.notEvaluatedReason).toMatch(/inherits the server default \(unresolved\)/);
    const schemes = byId(result.findings, "openai.tools.security-schemes");
    expect(schemes.details?.inheritsServerDefault).toEqual(["get_my_orders"]);
  });

  it("says a 401 is not the tool-level trigger ChatGPT documents", async () => {
    const server = await startLazyServer({ refusal: "bearer-401" });
    const evidence = await gatherOpenAIReadinessEvidence({
      target: server.url,
      mode: "mcp-only",
      fetchFn: fetch,
      lazyAuthProbe: { enabled: true },
      now: NOW,
    });
    const result = gradeOpenAIReadiness(evidence);
    expect(byId(result.findings, "openai.auth.runtime-challenge").status).toBe("violated");
    // Any client follows a 401, so the metadata it names is still graded.
    expect(evidence.lazyAuthProbe?.rediscovery?.prmFound).toBe(true);
    expect(byId(result.findings, "openai.auth.prm-discoverable").status).toBe("satisfied");
  });
});

// ── The gate ────────────────────────────────────────────────────────────

describe("the probe's empty arguments", () => {
  it.each(["rpc-error", "tool-error"] as const)(
    "reads a public tool that rejects them (%s) as inconclusive, not as refused",
    async (validation) => {
      const server = await startLazyServer({
        refusal: "bearer-401",
        prmAt: "well-known",
        weatherRequiresCity: validation,
      });
      const evidence = await gatherClaudeReadinessEvidence({
        enteredUrl: server.url,
        fetchFn: fetch,
        lazyAuthProbe: { enabled: true, toolName: "get_my_orders", publicToolName: "get_weather" },
        now: NOW,
      });
      expect(evidence.lazyAuthProbe?.publicCall).toMatchObject({
        toolName: "get_weather",
        invalidArguments: true,
      });
      const badge = gradeClaudeReadiness(evidence).badges.find(
        (entry) => entry.id === "claude.features.lazy-authentication",
      );
      expect(badge?.state).not.toBe("unsupported");
    },
  );

  it("picks a public tool that takes no required arguments", async () => {
    const server = await startLazyServer({
      refusal: "bearer-401",
      prmAt: "well-known",
      weatherRequiresCity: "tool-error",
      withNoArgPublicTool: true,
    });
    const evidence = await gatherClaudeReadinessEvidence({
      enteredUrl: server.url,
      fetchFn: fetch,
      lazyAuthProbe: { enabled: true },
      now: NOW,
    });
    expect(toolCalls(server.hits).map((hit) => hit.tool)).toEqual([
      "get_time",
      "get_my_orders",
    ]);
    expect(
      gradeClaudeReadiness(evidence).badges.find(
        (entry) => entry.id === "claude.features.lazy-authentication",
      ),
    ).toMatchObject({ state: "supported" });
  });

  it("skips the public call, without calling, when every public tool needs arguments", async () => {
    const server = await startLazyServer({
      refusal: "bearer-401",
      prmAt: "well-known",
      weatherRequiresCity: "rpc-error",
    });
    const evidence = await gatherClaudeReadinessEvidence({
      enteredUrl: server.url,
      fetchFn: fetch,
      lazyAuthProbe: { enabled: true },
      now: NOW,
    });
    expect(evidence.lazyAuthProbe?.publicCallSkipped).toMatch(/required inputs/);
    expect(toolCalls(server.hits).map((hit) => hit.tool)).toEqual(["get_my_orders"]);
  });
});

describe("the gate", () => {
  it("refuses a truthy non-boolean and makes no call", async () => {
    const server = await startLazyServer({ refusal: "bearer-401" });
    const evidence = await gatherClaudeReadinessEvidence({
      enteredUrl: server.url,
      fetchFn: fetch,
      lazyAuthProbe: { enabled: "true" as unknown as boolean, toolName: "get_my_orders" },
      now: NOW,
    });
    expect(evidence.lazyAuthProbe).toMatchObject({ attempted: false });
    expect(evidence.lazyAuthProbe?.reason).toMatch(/boolean/);
    expect(toolCalls(server.hits)).toEqual([]);
  });

  it("refuses a named tool that is not annotated read-only, without calling it", async () => {
    const server = await startLazyServer({ refusal: "bearer-401" });
    const mode = resolveLazyAuthProbeMode({ enabled: true, toolName: "cancel_order" });
    if (!mode.enabled) throw new Error("expected an armed mode");
    const evidence = await probeLazyAuthentication({
      enteredUrl: server.url,
      fetchFn: fetch,
      mode,
    });
    expect(evidence.protectedCall).toBeUndefined();
    expect(evidence.protectedCallSkipped).toMatch(/readOnlyHint: true/);
    expect(server.hits.some((hit) => hit.tool === "cancel_order")).toBe(false);
    // The public call still ran, chosen by its `noauth` scheme.
    expect(toolCalls(server.hits).map((hit) => hit.tool)).toEqual(["get_weather"]);
  });

  it("bounds the tool names it accepts", () => {
    expect(
      resolveLazyAuthProbeMode({ enabled: true, toolName: "x".repeat(129) }),
    ).toMatchObject({ enabled: false });
    expect(
      resolveLazyAuthProbeMode({ enabled: true, toolName: "a", publicToolName: "a" }),
    ).toMatchObject({ enabled: false });
    expect(resolveLazyAuthProbeMode(undefined)).toMatchObject({ enabled: false });
  });
});

// ── The dial pieces ─────────────────────────────────────────────────────

describe("the dial", () => {
  it("reads securitySchemes out of _meta when the top level has none", async () => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : {};
        if (body.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
          return;
        }
        json(res, 200, {
          jsonrpc: "2.0",
          id: body.id,
          result:
            body.method === "initialize"
              ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "x" } }
              : {
                  tools: [
                    {
                      name: "t",
                      inputSchema: { type: "object" },
                      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["a"] }] },
                    },
                  ],
                },
        });
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const initialize = await dialInitialize({ enteredUrl: url, fetchFn: fetch });
    const listing = await dialToolListing({ enteredUrl: url, fetchFn: fetch }, initialize.sessionId);
    expect(listing.entries[0]?.securitySchemes).toEqual([
      { type: "oauth2", scopes: ["a"] },
    ]);
  });

  it("keeps the challenge of a refused initialize", async () => {
    const server = await startLazyServer({ refusal: "bearer-401", initialize401: true });
    const initialize = await dialInitialize({ enteredUrl: server.url, fetchFn: fetch });
    expect(initialize).toMatchObject({ ok: false, status: 401 });
    expect(initialize.wwwAuthenticate).toMatch(/resource_metadata=/);
  });
});
