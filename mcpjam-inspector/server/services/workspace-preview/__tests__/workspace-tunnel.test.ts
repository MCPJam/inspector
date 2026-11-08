import { describe, expect, it, vi } from "vitest";

const plane = vi.hoisted(() => ({
  ensureComputerReady: vi.fn(),
  getComputerSandboxInfo: vi.fn(),
}));
vi.mock("../../../utils/computers/control-plane-client.js", async (original) => ({
  ...(await original<typeof import("../../../utils/computers/control-plane-client.js")>()),
  ensureComputerReady: plane.ensureComputerReady,
  getComputerSandboxInfo: plane.getComputerSandboxInfo,
}));
import {
  ensureWorkspaceTunnel,
  openPreviewForNavigation,
  personalComputerWorkspace,
  preparePreviewNavigation,
  previewKeyFor,
  previewTargetForUrl,
  WorkspacePreviewError,
  type PreviewGrantClient,
  type TunnelSandbox,
} from "../workspace-tunnel";
import { PREVIEW_TUNNEL_SOURCE, PREVIEW_TUNNEL_STATE } from "../tunnel-sidecar";

function fakeWorkspace(opts: {
  hasNode?: boolean;
  running?: { port: number; pid: number; secret: string; version?: number };
  alive?: boolean;
  trafficAccessToken?: string;
}) {
  const files = new Map<string, string>();
  if (opts.running)
    files.set(PREVIEW_TUNNEL_STATE, JSON.stringify({ version: 1, ...opts.running }));
  const commands: string[] = [];
  const sandbox: TunnelSandbox = {
    sandboxId: "ws1",
    ...(opts.trafficAccessToken ? { trafficAccessToken: opts.trafficAccessToken } : {}),
    getHost: (port) => `${port}-ws1.e2b.app`,
    files: {
      read: async (path) => {
        const text = files.get(path);
        if (text === undefined) throw new Error("not found");
        return text;
      },
      write: async (path, data) => {
        files.set(path, data);
      },
    },
    commands: {
      run: async (command, options) => {
        commands.push(command);
        if (command === "command -v node") return { exitCode: opts.hasNode === false ? 1 : 0 };
        if (command.startsWith("kill -0")) return { exitCode: opts.alive ? 0 : 1 };
        if (options?.background) {
          files.set(
            PREVIEW_TUNNEL_STATE,
            JSON.stringify({ version: 1, port: 41000, pid: 99, secret: options.envs?.MCPJAM_PREVIEW_SECRET }),
          );
        }
        return { exitCode: 0 };
      },
    },
  };
  return { sandbox, files, commands };
}

describe("previewTargetForUrl", () => {
  it.each([
    ["http://localhost:5173/", { kind: "port", port: 5173 }],
    ["http://127.0.0.1:3000/api", { kind: "port", port: 3000 }],
    ["http://[::1]:8080", { kind: "port", port: 8080 }],
    ["http://0.0.0.0:5173", { kind: "port", port: 5173 }],
    ["https://localhost:5173", { kind: "refused", code: "https_unsupported" }],
    ["http://localhost/", { kind: "refused", code: "port_not_allowed" }],
    ["http://localhost:49983/", { kind: "refused", code: "port_not_allowed" }],
    ["https://example.com/", { kind: "none" }],
    ["not a url", { kind: "none" }],
  ])("%s", (url, expected) => {
    expect(previewTargetForUrl(url)).toEqual(expected);
  });
});

describe("ensureWorkspaceTunnel", () => {
  it("reuses a live sidecar without starting another", async () => {
    const ws = fakeWorkspace({ running: { port: 40001, pid: 7, secret: "s".repeat(64) }, alive: true });
    const tunnel = await ensureWorkspaceTunnel(ws.sandbox);
    expect(tunnel).toEqual({ secret: "s".repeat(64), upstreamUrl: "wss://40001-ws1.e2b.app", upstreamHeaders: {} });
    expect(ws.commands).toEqual(["kill -0 7"]);
  });

  it("starts the shipped sidecar when none is running, and replaces a dead one", async () => {
    const ws = fakeWorkspace({ running: { port: 40001, pid: 7, secret: "old" }, alive: false });
    const tunnel = await ensureWorkspaceTunnel(ws.sandbox, { pollMs: 1 });
    expect(tunnel.upstreamUrl).toBe("wss://41000-ws1.e2b.app");
    expect(tunnel.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(ws.files.get("/tmp/mcpjam-preview/tunnel.mjs")).toBe(PREVIEW_TUNNEL_SOURCE);
    expect(ws.commands).toContain("kill 7");
    expect(ws.commands.at(-1)).toBe("exec node /tmp/mcpjam-preview/tunnel.mjs");
  });

  it("sends a private workspace's traffic token on the tunnel handshake only", async () => {
    const ws = fakeWorkspace({ trafficAccessToken: "tok" });
    const tunnel = await ensureWorkspaceTunnel(ws.sandbox, { pollMs: 1 });
    expect(tunnel.upstreamHeaders).toEqual({ "e2b-traffic-access-token": "tok" });
  });

  it("shares one start between concurrent first navigations", async () => {
    const ws = fakeWorkspace({});
    const [a, b] = await Promise.all([
      ensureWorkspaceTunnel(ws.sandbox, { pollMs: 1 }),
      ensureWorkspaceTunnel(ws.sandbox, { pollMs: 1 }),
    ]);
    expect(a).toEqual(b);
    expect(ws.commands.filter((c) => c.startsWith("exec node"))).toHaveLength(1);
  });

  it("refuses a workspace without Node.js", async () => {
    const ws = fakeWorkspace({ hasNode: false });
    await expect(ensureWorkspaceTunnel(ws.sandbox)).rejects.toMatchObject({ code: "no_node_runtime" });
  });
});

describe("preparePreviewNavigation", () => {
  const client = (answer: Awaited<ReturnType<NonNullable<PreviewGrantClient["previewGrant"]>>>) => {
    const previewGrant = vi.fn(async () => answer);
    return { client: { previewGrant }, previewGrant };
  };

  it("grants exactly the navigated port with its own key", async () => {
    const ws = fakeWorkspace({ running: { port: 40001, pid: 7, secret: "k".repeat(64) }, alive: true });
    const { client: c, previewGrant } = client({ ok: true });
    await expect(preparePreviewNavigation({ url: "http://localhost:5173/", client: c, attach: async () => ws.sandbox })).resolves.toBe(true);
    expect(previewGrant).toHaveBeenCalledWith({
      port: 5173,
      upstreamUrl: "wss://40001-ws1.e2b.app",
      upstreamHeaders: {},
      key: previewKeyFor("k".repeat(64), 5173),
    });
  });

  it("leaves any other URL alone without touching the workspace", async () => {
    const attach = vi.fn();
    await expect(preparePreviewNavigation({ url: "https://example.com", client: {}, attach })).resolves.toBe(false);
    expect(attach).not.toHaveBeenCalled();
  });

  it("maps a daemon without the relay and a busy port to readable refusals", async () => {
    const ws = fakeWorkspace({ running: { port: 1, pid: 7, secret: "k".repeat(64) }, alive: true });
    await expect(preparePreviewNavigation({ url: "http://localhost:5173", client: {}, attach: async () => ws.sandbox })).rejects.toMatchObject({ code: "browser_preview_unsupported" });
    await expect(
      preparePreviewNavigation({ url: "http://localhost:5173", client: client({ ok: false, error: "port_unavailable" }).client, attach: async () => ws.sandbox }),
    ).rejects.toMatchObject({ code: "port_unavailable" });
  });
});

describe("openPreviewForNavigation", () => {
  const hosted = { engine: "hosted", client: { previewGrant: vi.fn(async () => ({ ok: true as const })) } };

  it("resolves a lazy workspace at navigation time", async () => {
    const ws = fakeWorkspace({ running: { port: 40001, pid: 7, secret: "k".repeat(64) }, alive: true });
    let workspace: { sandboxId: string } | undefined;
    const attach = vi.fn(async () => ws.sandbox);
    const navigate = { kind: "navigate", url: "http://localhost:5173" };
    expect(await openPreviewForNavigation({ action: navigate, workspace: () => workspace, handle: hosted, attach })).toBeUndefined();
    expect(attach).not.toHaveBeenCalled();
    workspace = { sandboxId: "ws1" };
    expect(await openPreviewForNavigation({ action: navigate, workspace: () => workspace, handle: hosted, attach })).toBeUndefined();
    expect(attach).toHaveBeenCalledWith("ws1");
  });

  it("does nothing for the local engine or a non-navigation", async () => {
    const attach = vi.fn();
    const workspace = { sandboxId: "ws1" };
    await openPreviewForNavigation({ action: { kind: "navigate", url: "http://localhost:5173" }, workspace, handle: { ...hosted, engine: "local" }, attach });
    await openPreviewForNavigation({ action: { kind: "reload" }, workspace, handle: hosted, attach });
    expect(attach).not.toHaveBeenCalled();
  });

  it("returns the refusal for the model instead of throwing", async () => {
    const ws = fakeWorkspace({ hasNode: false });
    const message = await openPreviewForNavigation({
      action: { kind: "navigate", url: "http://localhost:5173" },
      workspace: { sandboxId: "ws1" },
      handle: hosted,
      attach: async () => ws.sandbox,
    });
    expect(message).toBe(new WorkspacePreviewError("no_node_runtime").message);
  });
});

describe("personalComputerWorkspace", () => {
  it("resolves the member's hosted computer the way Bash does, on first use", async () => {
    plane.ensureComputerReady.mockResolvedValue({ ok: true, value: { computerId: "c1" } });
    plane.getComputerSandboxInfo.mockResolvedValue({ ok: true, value: { providerComputerId: "pc1" } });
    const resolve = personalComputerWorkspace({ authHeader: "Bearer t", projectId: "p1" });
    expect(plane.ensureComputerReady).not.toHaveBeenCalled();
    await expect(resolve()).resolves.toEqual({ sandboxId: "pc1" });
    expect(plane.ensureComputerReady).toHaveBeenCalledWith({ bearer: "Bearer t", projectId: "p1" });
  });

  it("opens nothing when the computer cannot be reached", async () => {
    plane.ensureComputerReady.mockResolvedValue({ ok: false, status: 503 });
    await expect(personalComputerWorkspace({ authHeader: "Bearer t", projectId: "p1" })()).resolves.toBeUndefined();
  });
});
