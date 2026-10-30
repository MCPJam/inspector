import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { createHostedClaudeCodeHarness } from "../../claude-code-typed-errors.js";
import type { HarnessV1NetworkSandboxSession } from "@ai-sdk/harness";
import { sealHarnessProxyToken } from "../../harness-proxy-policy-seal.js";
import {
  patchClaudeForwardingResume,
  refreshClaudeForwarding,
  withClaudeForwardingResume,
} from "../claude-resume.js";

const servers = {
  server: {
    type: "http" as const,
    url: "https://forward.example/mcp",
    headers: {
      Connection: "close",
      "X-MCPJam-Forwarding-Context": "new-context",
    },
  },
};
const sockets = new Set<WebSocketServer>();
afterEach(async () => {
  for (const server of sockets) {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  sockets.clear();
});

async function bridge(
  reply: "ok" | "refuse" | "wrong-id" | "close" | "silent",
  helloDelay = 0,
) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  sockets.add(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const messages: Record<string, unknown>[] = [];
  server.on("connection", (socket, request) => {
    expect(
      new URL(request.url!, "http://localhost").searchParams.get(
        "agent_bridge_token",
      ),
    ).toBe("capability");
    let ready = false;
    setTimeout(() => {
      ready = true;
      if (socket.readyState === socket.OPEN)
        socket.send(JSON.stringify({ type: "bridge-hello" }));
    }, helloDelay);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      expect(ready).toBe(true);
      messages.push(message);
      if (reply === "close") {
        socket.close();
        return;
      }
      if (reply === "silent") return;
      socket.send(
        JSON.stringify({
          type: "mcpjam-mcp-refreshed",
          id: reply === "wrong-id" ? "other" : message.id,
          ok: reply !== "refuse",
        }),
      );
    });
  });
  return {
    endpoint: { url: `ws://127.0.0.1:${address.port}` },
    token: "capability",
    servers,
    timeoutMs: 200,
    messages,
  };
}

describe("Claude forwarding refresh", () => {
  it("waits for the matching acknowledgement and sends no start or resume", async () => {
    const target = await bridge("ok", 30);
    await refreshClaudeForwarding(target);
    expect(target.messages).toEqual([
      { type: "mcpjam-refresh-mcp", id: expect.any(String), servers },
    ]);
  });
  it.each(["refuse", "close", "wrong-id", "silent"] as const)(
    "refuses continuation on %s",
    async (reply) => {
      const target = await bridge(reply);
      await expect(refreshClaudeForwarding(target)).rejects.toThrow();
      expect(target.messages).toHaveLength(1);
    },
  );
  it("cancels without allowing a late acknowledgement", async () => {
    const target = await bridge("silent");
    const abort = new AbortController();
    const promise = refreshClaudeForwarding({
      ...target,
      signal: abort.signal,
    });
    abort.abort();
    await expect(promise).rejects.toThrow("cancelled");
  });
  it("patches the installed hosted bridge, preserves host tools, and refuses changed destinations", async () => {
    const bootstrap = await createHostedClaudeCodeHarness().getBootstrap?.();
    const source = bootstrap?.files.find((file) =>
      file.path.endsWith("/bridge.mjs"),
    )?.content;
    if (!source) throw new Error("Missing installed bridge");
    const patched = patchClaudeForwardingResume(source);
    expect(patchClaudeForwardingResume(patched)).toBe(patched);
    expect(patched).toContain(
      'sendControl(ws, { type: "mcpjam-mcp-refreshed", id: msg.id, ok });',
    );
    expect(patched).toContain(
      "if (mcpjamRefreshNativeMcp === refreshNativeMcp) mcpjamRefreshNativeMcp = void 0;",
    );
    const begin = patched.indexOf(
      "  const refreshNativeMcp = async (servers) => {",
    );
    const end = patched.indexOf("  gracefulAbort = () => {", begin);
    const setMcpServers = vi.fn(async () => ({ errors: {} }));
    const prior = {
      ...servers,
      "harness-tools": { type: "sdk", instance: { marker: "keep" } },
    };
    const create = new Function(
      "q",
      "start",
      "mcpServers",
      `let mcpjamRefreshNativeMcp; ${patched.slice(begin, end)} return mcpjamRefreshNativeMcp;`,
    );
    const refresh = create({ setMcpServers }, { mcpServers: servers }, prior);
    await refresh(servers);
    expect(setMcpServers).toHaveBeenCalledWith(prior);
    await expect(
      refresh({ server: { ...servers.server, url: "https://other.example" } }),
    ).rejects.toThrow();
    await expect(
      refresh({
        server: {
          ...servers.server,
          headers: { ...servers.server.headers, Connection: "keep-alive" },
        },
      }),
    ).rejects.toThrow("Invalid forwarding configuration");
    expect(setMcpServers).toHaveBeenCalledOnce();
    vi.stubEnv(
      "COMPUTERS_TERMINAL_TOKEN_SECRET",
      "test-forwarding-seal-key-with-32-characters",
    );
    try {
      const seal = sealHarnessProxyToken({
        token: "x".repeat(6500),
        serverId: "server",
        expiresAtMs: Date.now() + 60_000,
        policy: {
          mode: "default",
          denied: {},
          known: [],
          unknownTool: "allow",
        },
      });
      expect(seal.length).toBeGreaterThan(8192);
      await refresh({
        server: {
          ...servers.server,
          headers: {
            Connection: "close",
            "X-MCPJam-Forwarding-Context": seal,
          },
        },
      });
    } finally {
      vi.unstubAllEnvs();
    }
    setMcpServers.mockResolvedValueOnce({
      errors: { server: "connection failed" },
    });
    await expect(refresh(servers)).rejects.toThrow("MCP refresh failed");
  });
  it.each([false, true])(
    "never respawns a paused query after refresh, restricted=%s",
    async (restricted) => {
      const target = await bridge("ok");
      const unavailable = vi.fn(async () => {
        throw new Error("Unexpected sandbox call");
      });
      const fileSystem = {
        description: "test",
        readFile: unavailable,
        readBinaryFile: unavailable,
        readTextFile: unavailable,
        writeFile: unavailable,
        writeBinaryFile: unavailable,
        writeTextFile: unavailable,
        run: unavailable,
        spawn: unavailable,
      };
      const sandboxSession: HarnessV1NetworkSandboxSession = {
        ...fileSystem,
        id: "box",
        defaultWorkingDirectory: "/work",
        ports: [],
        getPortEndpoint: async () => target.endpoint,
        getPortUrl: async () => target.endpoint.url,
        stop: unavailable,
        destroy: unavailable,
        restricted: () => fileSystem,
      };
      const harness = createHostedClaudeCodeHarness();
      const doStart = vi.fn<typeof harness.doStart>(async (options) => {
        const session =
          restricted && "restricted" in options.sandboxSession
            ? options.sandboxSession.restricted()
            : options.sandboxSession;
        await session.spawn({ command: "node replacement-bridge" });
        throw new Error("A replacement bridge must never run");
      });
      const wrapped = withClaudeForwardingResume(
        { ...harness, doStart },
        servers,
        "current-policy",
      );
      await expect(
        wrapped.doStart({
          sessionId: "session",
          sessionWorkDir: "/work",
          sandboxSession,
          continueFrom: {
            type: "continue-turn",
            harnessId: "claude-code",
            specificationVersion: "harness-v1",
            data: {
              bridge: { port: 4100, token: "capability" },
              mcpjamForwardingPolicy: "old-policy",
            },
          },
        }),
      ).rejects.toThrow("tool policy has changed");
      expect(target.messages).toHaveLength(0);
      expect(doStart).not.toHaveBeenCalled();
      await expect(
        wrapped.doStart({
          sessionId: "session",
          sessionWorkDir: "/work",
          sandboxSession,
          continueFrom: {
            type: "continue-turn",
            harnessId: "claude-code",
            specificationVersion: "harness-v1",
            data: {
              bridge: { port: 4100, token: "capability" },
              mcpjamForwardingPolicy: "current-policy",
            },
          },
        }),
      ).rejects.toThrow("paused Claude process is unavailable");
      expect(doStart).toHaveBeenCalledOnce();
      expect(unavailable).not.toHaveBeenCalled();
    },
  );
  it("refuses an unrecognized pinned bridge shape", () => {
    expect(() => patchClaudeForwardingResume("changed vendor code")).toThrow(
      "does not support",
    );
  });
});
