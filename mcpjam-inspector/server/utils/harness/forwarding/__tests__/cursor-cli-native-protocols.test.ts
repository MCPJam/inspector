/**
 * The Cursor CLI client negotiates as the real CLI does.
 *
 * Measured on CLI 2026.11.05-86047df: `initialize` at 2025-11-25 against every
 * server; a 2025-only or both-era server stays there and never sees
 * `server/discover`; a 2026-only server that refuses with `-32022` naming
 * 2026-07-28 gets `server/discover` and runs 2026-07-28; a generic refusal ends
 * the connection. The servers here are the official `@modelcontextprotocol/
 * server` handlers in those shapes, and each connection goes through the same
 * mapping a hosted turn uses (`buildHostConnectionPins`, then `toHttpConfig`).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { MCPClientManager } from "@mcpjam/sdk";
import { seedHostTemplate } from "@mcpjam/sdk/host-config/templates";
import { WEB_STREAM_TIMEOUT_MS } from "@/shared/hosted-web-timeouts";
import {
  createAuthorizedManager,
  toHttpConfig,
} from "../../../../routes/web/auth.js";
import { buildHostConnectionPins } from "../../../../services/host-connection-pins.js";
import { harnessConnectionProfile } from "../../harness-connection-profile.js";
import {
  sealHarnessSessionEnvelope,
  unsealHarnessProxyToken,
} from "../../harness-proxy-policy-seal.js";
import { getHarnessAdapter } from "../../registry.js";
import { forwardingAdmission } from "../enhanced-admission.js";
import { nativeForwardingGaps } from "../native-admission.js";
import { qualifiedForwardingRuntime } from "../runtime-contract.js";

type Profile = ReturnType<typeof seedHostTemplate>;
type Era = "both" | "modern" | "modern-generic-reject";

/** Official handlers: both eras, or 2026-only (`legacy: "reject"`, which
 * refuses `initialize` with -32022). The generic variant refuses `initialize`
 * with a bare -32600 instead, and serves everything else as 2026-only. */
async function serve(era: Era) {
  const node = toNodeHandler(
    createMcpHandler(
      () =>
        new McpServer(
          { name: era, version: "1.0.0" },
          { capabilities: { tools: {} } },
        ),
      era === "both" ? {} : { legacy: "reject" },
    ),
  );
  const wire: string[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString("utf8");
    const body = text
      ? (JSON.parse(text) as {
          id?: unknown;
          method?: string;
          params?: { protocolVersion?: string };
        })
      : undefined;
    wire.push(
      [req.method, body?.method ?? "-", body?.params?.protocolVersion]
        .filter(Boolean)
        .join(" "),
    );
    if (era === "modern-generic-reject" && body?.method === "initialize") {
      res.writeHead(400, { "content-type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32600, message: "legacy era rejected" },
        }),
      );
      return;
    }
    await node(req, res, body);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const fixture = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    wire,
  };
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  return fixture;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function connect(
  config: Parameters<MCPClientManager["connectToServer"]>[1],
) {
  const manager = new MCPClientManager();
  cleanups.push(() => manager.disconnectAllServers());
  await manager.connectToServer("server", config);
  return manager;
}

/** A hosted turn's own connection to the server, built from the profile. */
async function turnConnection(profile: Profile, url: string) {
  const pins = buildHostConnectionPins(profile, WEB_STREAM_TIMEOUT_MS);
  return connect(
    toHttpConfig(
      { serverConfig: { transportType: "http", url } },
      pins.timeoutMs,
      undefined,
      profile.clientCapabilities,
      undefined,
      pins.initializePins,
    ),
  );
}

const cursorCli = () => seedHostTemplate("cursor-cli");
const declared = (harness: string) =>
  qualifiedForwardingRuntime(getHarnessAdapter(harness))
    ?.nativeVersionNegotiation;

function admission(
  manager: MCPClientManager,
  profile: Profile,
  harness: string,
) {
  return forwardingAdmission({
    manager,
    serverIds: ["server"],
    respectToolVisibility: profile.respectToolVisibility,
    modelVisibleMcpToolResults: profile.modelVisibleMcpToolResults,
    nativeVersionNegotiation: declared(harness),
  });
}

describe("Cursor CLI client protocol negotiation", () => {
  it("T1: on a both-era server it stays on 2025-11-25 and pass-through is admitted", async () => {
    const fixture = await serve("both");
    const manager = await turnConnection(cursorCli(), fixture.url);
    expect(manager.getInitializationInfo("server")?.protocolVersion).toBe(
      "2025-11-25",
    );
    expect(fixture.wire).not.toContain("POST server/discover");
    expect(admission(manager, cursorCli(), "cursor")).toEqual({
      delivery: "native",
      gaps: [],
    });
  });

  it("T2: the signed proxy's connection, rebuilt from the sealed profile, negotiates 2025-11-25", async () => {
    const turn = await turnConnection(cursorCli(), (await serve("both")).url);
    // The session envelope a Cursor lane's MCP config carries, as the route
    // opens it.
    vi.stubEnv(
      "COMPUTERS_TERMINAL_TOKEN_SECRET",
      "test-harness-proxy-secret-32-chars",
    );
    const envelope = sealHarnessSessionEnvelope({
      handle: "lane-handle",
      serverId: "server",
      policy: { mode: "default", denied: {}, known: [], unknownTool: "allow" },
      profile: harnessConnectionProfile(turn, "server"),
    });
    const profile = unsealHarnessProxyToken(envelope, "server")!.profile!;
    expect(profile.versionNegotiation).toBe("legacy-first");
    const upstream = await serve("both");
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.example.test");
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        String(input).endsWith("/web/authorize-batch")
          ? Response.json({
              results: {
                server: {
                  ok: true,
                  role: "member",
                  accessLevel: "project_member",
                  permissions: { chatOnly: false },
                  serverConfig: {
                    transportType: "http",
                    url: upstream.url,
                    useOAuth: false,
                  },
                },
              },
            })
          : realFetch(input, init),
    );
    // As `/api/web/harness-mcp/:serverId` builds it from `sealed.profile`.
    const { authorizedServerConfigs } = await createAuthorizedManager(
      {},
      "",
      "p1",
      ["server"],
      profile.timeout ?? 60_000,
      undefined,
      profile.clientCapabilities,
      { lazyConnect: true, initializePins: profile },
    );
    const proxy = await connect(authorizedServerConfigs!.server!);
    expect(proxy.getInitializationInfo("server")?.protocolVersion).toBe(
      "2025-11-25",
    );
    expect(upstream.wire.slice(0, 1)).toEqual(["POST initialize 2025-11-25"]);
    expect(upstream.wire).not.toContain("POST server/discover");
  });

  it("T3: a 2026-only server's -32022 refusal moves it to 2026-07-28, which pass-through cannot carry yet", async () => {
    const fixture = await serve("modern");
    const manager = await turnConnection(cursorCli(), fixture.url);
    expect(manager.getInitializationInfo("server")?.protocolVersion).toBe(
      "2026-07-28",
    );
    expect(fixture.wire.slice(0, 2)).toEqual([
      "POST initialize 2025-11-25",
      "POST server/discover",
    ]);
    // The remaining gap: native forwarding is qualified on 2025 only.
    expect(
      nativeForwardingGaps({
        manager,
        serverIds: ["server"],
        respectToolVisibility: false,
        nativeVersionNegotiation: declared("cursor"),
      }),
    ).toEqual(["unqualified-protocol"]);
  });

  it("T4: a generic refusal of initialize ends the connection, as it does for the CLI", async () => {
    const fixture = await serve("modern-generic-reject");
    await expect(turnConnection(cursorCli(), fixture.url)).rejects.toThrow(
      /legacy era rejected/,
    );
    expect(fixture.wire).not.toContain("POST server/discover");
  });

  it.each(["claude-code", "codex"])(
    "T5: %s declares no negotiation of its own, so any protocol setting stays a pin",
    async (harness) => {
      expect(declared(harness)).toBeUndefined();
      const gaps = async (mcpProfile: Profile["mcpProfile"]) => {
        const profile = { ...cursorCli(), mcpProfile };
        const manager = await turnConnection(
          profile,
          (await serve("both")).url,
        );
        return admission(manager, profile, harness).gaps;
      };
      expect(
        await gaps({ profileVersion: 1, versionNegotiation: "legacy-first" }),
      ).toContain("protocol-pins");
      expect(
        await gaps({ profileVersion: 1, mcpProtocolVersion: "2025-11-25" }),
      ).toContain("protocol-pins");
      expect(await gaps({ profileVersion: 1 })).not.toContain("protocol-pins");
    },
  );
});
