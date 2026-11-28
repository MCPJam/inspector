/**
 * The shared lifecycle every registered harness goes through (D10, E12, E13).
 *
 * Each row runs once per registered adapter through the shared code a hosted
 * turn calls, so a harness is enrolled the moment it is registered. A runtime
 * left out of a shared behavior is named below with the reason; one that is
 * neither enrolled nor named fails the suite, and so does a stale name.
 *
 * Mocked orchestration, not a real process: the recipes, the session
 * configuration and the warm decision are the shared code's own; what the
 * runtime does with them is the conformance suite's and the Docker box's.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hostedWarmAgentEligible } from "../../forwarding/runtime-contract";
import { harnessRecipeIdentity } from "../../harness-bake";
import { hostedBootstrapRuntimes } from "../../prepare-conversation-box";
import type { HarnessId } from "../../registry";
import { sessionProxyInputs } from "../../session-mcp-config";
import { CASES, NO_BOX, OWN_MODEL, assertFullMatrix } from "./support";

const tools = vi.hoisted(() => ({
  list: [{ name: "read", inputSchema: { type: "object" } }] as Array<
    Record<string, unknown>
  >,
}));
vi.mock("../../harness-session-state", async (original) => ({
  ...(await original<typeof import("../../harness-session-state")>()),
  // The backend returns the same handle for a server on every turn of a lane.
  bindHarnessSessionTurn: vi.fn(
    async ({ servers }: { servers: Array<{ serverId: string }> }) => ({
      ok: true,
      handles: Object.fromEntries(
        servers.map(({ serverId }) => [serverId, `lane-handle-${serverId}`]),
      ),
    }),
  ),
}));
vi.mock("../../harness-proxy-strategy", async (original) => ({
  ...(await original<typeof import("../../harness-proxy-strategy")>()),
  resolveHarnessProxyUrl: vi.fn(
    async ({ serverId }: { serverId: string }) =>
      `https://app.example/api/web/harness-mcp/${serverId}`,
  ),
}));
vi.mock("../../harness-connection-profile", async (original) => ({
  ...(await original<typeof import("../../harness-connection-profile")>()),
  harnessConnectionProfile: () => ({
    clientCapabilities: {},
    timeout: 300_000,
  }),
}));

it("covers every registered harness", assertFullMatrix);

/**
 * Runtimes that start every message cold, and why. A runtime leaves this list
 * by declaring `hostedWarmAgent` with the evidence its declaration needs.
 */
const STARTS_COLD: Partial<Record<HarnessId, string>> = {
  cursor:
    "a CLI kept between messages would hold the turn's Cursor login after the turn removed it",
  opencode:
    "its bridge keeps the OpenCode server it started until openCodeConfig changes, so a kept agent would keep the previous message's tools",
  "claude-web": "no agent runs in a box; claude.ai holds the conversation",
  "chatgpt-web": "no agent runs in a box; chatgpt.com holds the conversation",
};

/** Runtimes whose MCP servers are not in their own configuration, and why. */
const TAKES_TOOLS_PER_MESSAGE = (id: HarnessId) =>
  CASES.find((entry) => entry.id === id)!.adapter.mcpDelivery !== "harness";

const baked = JSON.parse(
  readFileSync(
    new URL("../../../../../harness-bake.lock.json", import.meta.url),
    "utf8",
  ),
) as { recipes: Array<{ harnessId: string; identity: string }> };

beforeEach(() => {
  vi.stubEnv("COMPUTERS_TERMINAL_TOKEN_SECRET", "x".repeat(48));
  vi.stubEnv("CONVEX_HTTP_URL", "https://backend.example");
  tools.list = [{ name: "read", inputSchema: { type: "object" } }];
});

describe.each(CASES)("$id lifecycle", ({ id, adapter }) => {
  it("prepares its box before Send with exactly the recipes the template bakes", async () => {
    if (NO_BOX[id]) {
      // Named with its reason in `NO_BOX`: nothing to prepare, nothing baked.
      expect(hostedBootstrapRuntimes(id, OWN_MODEL[id])).toEqual([]);
      expect(baked.recipes.some((recipe) => recipe.harnessId === id)).toBe(false);
      return;
    }
    const identities = await Promise.all(
      hostedBootstrapRuntimes(id, OWN_MODEL[id]).map(async (runtime) =>
        harnessRecipeIdentity((await runtime.getBootstrap!({}))!),
      ),
    );
    const bakedForRuntime = baked.recipes
      .filter((recipe) => recipe.harnessId === id)
      .map((recipe) => recipe.identity);
    expect(identities.length).toBeGreaterThan(0);
    expect(new Set(identities)).toEqual(new Set(bakedForRuntime));
  });

  it("runs warm between messages, or is named with the reason it starts cold", () => {
    if (hostedWarmAgentEligible(adapter)) {
      expect(STARTS_COLD).not.toHaveProperty(id);
      return;
    }
    expect(STARTS_COLD[id]).toEqual(expect.any(String));
  });

  it("keeps one MCP configuration for a chat lane, changed only by its server's tools", async () => {
    if (NO_BOX[id]) {
      // The vendor's app keeps its own connector, pointed at the forwarding
      // endpoint; MCPJam writes no configuration anywhere.
      expect(adapter.mcpNativeDelivery).toBe("web-connector");
      return;
    }
    if (TAKES_TOOLS_PER_MESSAGE(id)) {
      // MCPJam's own client lists the tools and hands them over with each
      // message, so there is no configuration to keep.
      expect(adapter.mcpDelivery).toBe("mcpjam");
      return;
    }
    const manager = {
      listTools: vi.fn(async () => ({ tools: tools.list })),
    };
    const configuration = (turnId: string) =>
      sessionProxyInputs({
        manager: manager as never,
        serverIds: ["orders"],
        strategy: {
          plane: "web-authorized",
          mode: "direct",
          publicBaseUrl: "https://app.example",
        },
        authHeader: "Bearer member",
        session: {
          owner: { ownerType: "direct-chat", chatSessionId: "chat" } as never,
          leaseId: "lane-lease",
          turnId,
        },
        ...(adapter.fingerprintsMcpConfig ? { fingerprinted: true } : {}),
      });
    const first = await configuration("turn-1");
    expect(await configuration("turn-2")).toEqual(first);
    tools.list = [
      ...tools.list,
      { name: "write", inputSchema: { type: "object" } },
    ];
    const changed = await configuration("turn-3");
    if (adapter.fingerprintsMcpConfig) {
      // The runtime refuses to resume a session whose configuration changed,
      // so nothing in it varies, the catalog included.
      expect(changed).toEqual(first);
      return;
    }
    // Only the catalog version moved, and every request opens its own
    // connection, since the agent can outlive the turn.
    expect(changed[0]!.proxyUrl).not.toBe(first[0]!.proxyUrl);
    expect({ ...changed[0], proxyUrl: "" }).toEqual({
      ...first[0],
      proxyUrl: "",
    });
    expect(first[0]).toMatchObject({ closeConnection: true });
  });
});

it("names no runtime that already runs warm", () => {
  for (const id of Object.keys(STARTS_COLD) as HarnessId[])
    expect(
      hostedWarmAgentEligible(CASES.find((entry) => entry.id === id)!.adapter),
    ).toBe(false);
});
