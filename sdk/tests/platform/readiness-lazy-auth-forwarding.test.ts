/**
 * The two optional readiness inputs — the lazy-auth probe and feature claims —
 * on their way from an operation to the start endpoint.
 *
 * Two properties matter. A start that asked for neither sends a body with
 * neither key, so an endpoint that predates them never sees an unknown key.
 * And the inputs are validated before anything is sent: a tool name is
 * bounded, a claim is one the SDK knows, and the probe is armed only by a
 * literal `true`.
 */

import { describe, expect, it, vi } from "vitest";

import {
  PlatformApiClient,
  startClaudeReadinessRunOperation,
  startOpenAIReadinessRunOperation,
} from "../../src/platform/index.js";

const PROJECT = {
  id: "project-1",
  name: "Shop",
  description: null,
  icon: null,
  organizationId: "org-a",
  visibility: null,
  createdAt: 1,
  updatedAt: 1,
};

const SERVER = {
  id: "server-1",
  projectId: "project-1",
  name: "Shop MCP",
  enabled: true,
  transportType: "http",
  url: "https://shop.example.com/mcp",
  useOAuth: true,
  hasClientSecret: false,
  createdAt: null,
  updatedAt: null,
};

function makeClient(): {
  client: PlatformApiClient;
  bodies: Array<{ path: string; body: Record<string, unknown> }>;
} {
  const bodies: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetchMock = vi.fn(async (target: unknown, init?: RequestInit) => {
    const path = new URL(String(target)).pathname;
    if (path === "/api/v1/projects") return Response.json({ items: [PROJECT] });
    if (path === "/api/v1/projects/project-1/servers") {
      return Response.json({ items: [SERVER] });
    }
    if (path.includes("/readiness-runs/") && init?.method === "POST") {
      bodies.push({ path, body: JSON.parse(String(init.body)) });
      return Response.json(
        {
          runId: "run-1",
          projectId: "project-1",
          serverId: "server-1",
          readinessKind: path.endsWith("/openai") ? "openai" : "claude",
          status: "pending",
          deduped: false,
          includeLlmObservations: false,
        },
        { status: 202 },
      );
    }
    return Response.json({ code: "NOT_FOUND", message: path }, { status: 404 });
  });
  return {
    client: new PlatformApiClient({
      baseUrl: "https://api.example.com/api/v1",
      getAuth: () => "sk_test",
      fetch: fetchMock as unknown as typeof fetch,
    }),
    bodies,
  };
}

describe("start_claude_readiness_run forwards the lazy-auth inputs", () => {
  it("sends neither key when neither was asked for", async () => {
    const { client, bodies } = makeClient();
    await startClaudeReadinessRunOperation.execute(
      startClaudeReadinessRunOperation.inputSchema.parse({ server: "Shop MCP" }),
      { client },
    );
    expect(bodies[0]?.body).toEqual({});
  });

  it("forwards the probe and the claims, deduplicated and sorted", async () => {
    const { client, bodies } = makeClient();
    await startClaudeReadinessRunOperation.execute(
      startClaudeReadinessRunOperation.inputSchema.parse({
        server: "server-1",
        lazyAuthProbe: {
          enabled: true,
          toolName: "get_my_orders",
          publicToolName: "get_weather",
        },
        claimedFeatures: ["lazy-authentication", "lazy-authentication"],
      }),
      { client },
    );
    expect(bodies[0]).toEqual({
      path: "/api/v1/projects/project-1/servers/server-1/readiness-runs/claude",
      body: {
        lazyAuthProbe: {
          enabled: true,
          toolName: "get_my_orders",
          publicToolName: "get_weather",
        },
        claimedFeatures: ["lazy-authentication"],
      },
    });
  });

  it("forwards them on the OpenAI start too, beside the submission mode", async () => {
    const { client, bodies } = makeClient();
    await startOpenAIReadinessRunOperation.execute(
      startOpenAIReadinessRunOperation.inputSchema.parse({
        server: "server-1",
        submissionMode: "mcp-only",
        lazyAuthProbe: { enabled: true },
      }),
      { client },
    );
    expect(bodies[0]?.body).toEqual({
      submissionMode: "mcp-only",
      lazyAuthProbe: { enabled: true },
    });
  });
});

describe("the inputs are validated before anything is sent", () => {
  const parse = (input: Record<string, unknown>) =>
    startClaudeReadinessRunOperation.inputSchema.safeParse({
      server: "s",
      ...input,
    });

  it("arms the probe only with a literal true", () => {
    expect(parse({ lazyAuthProbe: { enabled: false } }).success).toBe(false);
    expect(parse({ lazyAuthProbe: { enabled: "true" } }).success).toBe(false);
    expect(parse({ lazyAuthProbe: { enabled: true } }).success).toBe(true);
  });

  it("bounds tool names and refuses unknown keys", () => {
    expect(
      parse({ lazyAuthProbe: { enabled: true, toolName: "x".repeat(129) } })
        .success,
    ).toBe(false);
    expect(
      parse({ lazyAuthProbe: { enabled: true, toolName: "  " } }).success,
    ).toBe(false);
    expect(
      parse({ lazyAuthProbe: { enabled: true, credentials: "token" } }).success,
    ).toBe(false);
  });

  it("refuses the same tool as both the public and the protected one", () => {
    expect(
      parse({
        lazyAuthProbe: { enabled: true, toolName: "a", publicToolName: "a" },
      }).success,
    ).toBe(false);
  });

  it("accepts only known claims, at most ten", () => {
    expect(parse({ claimedFeatures: ["lazy-auth"] }).success).toBe(false);
    expect(
      parse({ claimedFeatures: Array(11).fill("lazy-authentication") }).success,
    ).toBe(false);
    expect(
      parse({
        claimedFeatures: ["lazy-authentication", "enterprise-managed-auth"],
      }).success,
    ).toBe(true);
  });
});

describe("PlatformApiClient picks the fields it forwards", () => {
  it("drops keys the endpoint does not accept", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ runId: "r" }, { status: 202 }),
    );
    const client = new PlatformApiClient({
      baseUrl: "https://api.example.com/api/v1",
      getAuth: () => "sk_test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await client.startClaudeReadinessRun({
      projectId: "p",
      serverId: "s",
      lazyAuthProbe: {
        enabled: true,
        toolName: "t",
        // A wider object is assignable here; its extra keys must not travel.
        ...({ credentials: "nope" } as object),
      } as { enabled: boolean; toolName: string },
      claimedFeatures: ["lazy-authentication"],
    });
    const [, init] = fetchMock.mock.calls[0]! as unknown as [unknown, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      lazyAuthProbe: { enabled: true, toolName: "t" },
      claimedFeatures: ["lazy-authentication"],
    });
  });
});
