import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `optionalServerGroups`: servers a caller added implicitly (a host turn's
// active plugins) drop out whole — the group, not just the failing server —
// on any refusal or failed connect, while the servers the user selected keep
// failing the batch exactly as before.

const { mcpClientManagerMock, ensureConnectedMock, removeServerMock } =
  vi.hoisted(() => ({
    mcpClientManagerMock: vi.fn(),
    ensureConnectedMock: vi.fn(),
    removeServerMock: vi.fn(),
  }));

vi.mock("../../../utils/mcp-backpressure.js", () => ({
  hostedMcpBackpressureFetch: ({ fetch }: { fetch: typeof globalThis.fetch }) =>
    fetch,
}));

vi.mock("@mcpjam/sdk", async () => {
  const actual =
    await vi.importActual<typeof import("@mcpjam/sdk")>("@mcpjam/sdk");
  return {
    ...actual,
    MCPClientManager: mcpClientManagerMock.mockImplementation(() => ({
      disconnectAllServers: vi.fn(),
      ensureSkillsSupport: ensureConnectedMock,
      removeServer: removeServerMock,
    })),
  };
});

import type { Context } from "hono";
import { callerContextFromHono, createAuthorizedManager } from "../auth.js";

const mockVars: Record<string, unknown> = { requestLogContext: undefined };
const caller = callerContextFromHono({
  var: mockVars,
  get: (key: string) => mockVars[key],
  set: vi.fn((key: string, value: unknown) => {
    mockVars[key] = value;
  }),
} as unknown as Context);

function okResult(serverId: string, extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    role: "member",
    accessLevel: "shared_chat",
    permissions: { chatOnly: false },
    serverConfig: {
      transportType: "http",
      url: `https://${serverId}.example.com/mcp`,
      headers: {},
      useOAuth: false,
      ...extra,
    },
  };
}

function authorizeWith(results: Record<string, unknown>) {
  global.fetch = vi.fn(async () => Response.json({ results })) as typeof fetch;
}

const GROUPS = [
  { key: "plugin-a", serverIds: ["a1", "a2"] },
  { key: "plugin-b", serverIds: ["b1"] },
];

function build(options: Record<string, unknown> = {}) {
  return createAuthorizedManager(
    caller,
    "bearer",
    "project-1",
    ["mine", "a1", "a2", "b1"],
    1_000,
    undefined,
    undefined,
    { optionalServerGroups: GROUPS, ...options },
  );
}

function registered(): string[] {
  return Object.keys(mcpClientManagerMock.mock.calls.at(-1)![0]);
}

describe("createAuthorizedManager — optional server groups", () => {
  const originalFetch = global.fetch;
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
    ensureConnectedMock.mockResolvedValue({ active: false });
    removeServerMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    global.fetch = originalFetch;
    if (originalConvexHttpUrl === undefined) delete process.env.CONVEX_HTTP_URL;
    else process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
  });

  it("connects every group that authorizes and connects", async () => {
    authorizeWith({
      mine: okResult("mine"),
      a1: okResult("a1"),
      a2: okResult("a2"),
      b1: okResult("b1"),
    });
    const result = await build();
    expect(registered()).toEqual(["mine", "a1", "a2", "b1"]);
    expect(await result.optionalServerDrops).toEqual([]);
    // Only optional servers are awaited; the user's own connect is left to
    // the tool listing, exactly as before.
    expect(ensureConnectedMock.mock.calls.map(([id]) => id).sort()).toEqual([
      "a1",
      "a2",
      "b1",
    ]);
    expect(removeServerMock).not.toHaveBeenCalled();
  });

  it("drops a whole group when one of its servers is refused", async () => {
    authorizeWith({
      mine: okResult("mine"),
      a1: okResult("a1"),
      a2: { ok: false, status: 403, code: "FORBIDDEN", message: "disabled" },
      b1: okResult("b1"),
    });
    const result = await build();
    expect(registered()).toEqual(["mine", "b1"]);
    expect(await result.optionalServerDrops).toEqual([
      {
        key: "plugin-a",
        serverId: "a2",
        stage: "authorize",
        message: "disabled",
      },
    ]);
  });

  it("drops a group whose server needs a sign-in it does not have", async () => {
    authorizeWith({
      mine: okResult("mine"),
      a1: okResult("a1"),
      a2: okResult("a2"),
      b1: okResult("b1", { useOAuth: true, authMethod: "oauth" }),
    });
    const result = await build();
    expect(registered()).toEqual(["mine", "a1", "a2"]);
    const drops = await result.optionalServerDrops;
    expect(drops?.map((drop) => [drop.key, drop.stage])).toEqual([
      ["plugin-b", "authorize"],
    ]);
  });

  it("still fails the batch when a server outside every group is refused", async () => {
    authorizeWith({
      mine: { ok: false, status: 403, code: "FORBIDDEN", message: "nope" },
      a1: okResult("a1"),
      a2: okResult("a2"),
      b1: okResult("b1"),
    });
    await expect(build()).rejects.toMatchObject({ status: 403 });
  });

  it("removes a group whose server does not connect, siblings included", async () => {
    authorizeWith({
      mine: okResult("mine"),
      a1: okResult("a1"),
      a2: okResult("a2"),
      b1: okResult("b1"),
    });
    ensureConnectedMock.mockImplementation(async (key: string) => {
      if (key === "a1") throw new Error("ECONNREFUSED");
      return { active: false };
    });
    const result = await build();
    const drops = await result.optionalServerDrops;
    expect(drops).toEqual([
      {
        key: "plugin-a",
        serverId: "a1",
        stage: "connect",
        message: "ECONNREFUSED",
      },
    ]);
    expect(removeServerMock.mock.calls.map(([id]) => id).sort()).toEqual([
      "a1",
      "a2",
    ]);
  });

  it("gives a connect its deadline and then drops the group", async () => {
    vi.useFakeTimers();
    authorizeWith({
      mine: okResult("mine"),
      a1: okResult("a1"),
      a2: okResult("a2"),
      b1: okResult("b1"),
    });
    ensureConnectedMock.mockImplementation((key: string) =>
      key === "b1" ? new Promise(() => {}) : Promise.resolve({ active: false }),
    );
    const result = await build({ optionalConnectTimeoutMs: 2_000 });
    await vi.advanceTimersByTimeAsync(2_001);
    const drops = await result.optionalServerDrops;
    expect(drops?.map((drop) => [drop.key, drop.stage])).toEqual([
      ["plugin-b", "connect"],
    ]);
    expect(removeServerMock).toHaveBeenCalledWith("b1");
  });

  it("is unchanged without groups", async () => {
    authorizeWith({ mine: okResult("mine") });
    const result = await createAuthorizedManager(
      caller,
      "bearer",
      "project-1",
      ["mine"],
      1_000,
    );
    expect(result.optionalServerDrops).toBeUndefined();
    expect(ensureConnectedMock).not.toHaveBeenCalled();
  });
});
