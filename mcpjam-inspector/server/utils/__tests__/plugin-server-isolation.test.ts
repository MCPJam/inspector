import { afterEach, describe, expect, it, vi } from "vitest";
import type { UIMessageChunk } from "ai";
import {
  createTurnToolLister,
  emitPluginServersUnavailable,
  listToolsByServerIsolating,
  pluginServerUnavailableReason,
  unavailablePluginServers,
} from "../plugin-server-isolation.js";
import { withinToolListingBudget } from "../within-budget.js";
import { logger } from "../logger.js";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";
import {
  PLUGIN_SERVER_UNAVAILABLE_DATA_PART_TYPE,
  isPluginServerUnavailableDataPart,
} from "@/shared/plugin-server-unavailable";

type Lister = Parameters<typeof createTurnToolLister>[0]["manager"];

/** One fake tool per server, named after it, so merges are visible. */
const toolsOf = (keys: string[]) =>
  Object.fromEntries(
    keys.map((key) => [key, { [`${key}_tool`]: { description: key } }]),
  );

function fakeManager(fail: Record<string, unknown> = {}, hang: string[] = []) {
  const calls: string[][] = [];
  const getToolsForAiSdkByServer = vi.fn(async (keys?: string[] | string) => {
    const list = [keys ?? []].flat();
    calls.push(list);
    if (list.some((key) => hang.includes(key))) return new Promise(() => {});
    const failed = list.find((key) => key in fail);
    if (failed) throw fail[failed];
    return toolsOf(list);
  });
  const getToolsForAiSdk = vi.fn(async (keys?: string[] | string) =>
    Object.assign({}, ...Object.values(toolsOf([keys ?? []].flat()))),
  );
  const manager = {
    getToolsForAiSdkByServer,
    getToolsForAiSdk,
    listServers: () => ["a", "p1"],
  } as unknown as Lister;
  return { manager, calls, getToolsForAiSdkByServer, getToolsForAiSdk };
}

const within = <T>(listing: Promise<T>) => listing;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listToolsByServerIsolating", () => {
  it("lists the shared servers together and each isolated one on its own", async () => {
    const { manager, calls } = fakeManager();
    await listToolsByServerIsolating({
      list: (keys) => manager.getToolsForAiSdkByServer(keys),
      keys: ["a", "b", "p1", "p2"],
      isolatedKeys: new Set(["p1", "p2"]),
    });
    expect(calls).toEqual([["a", "b"], ["p1"], ["p2"]]);
  });

  it("keeps the turn when an isolated server fails, and records why", async () => {
    const refused = new Error("refused");
    const { manager } = fakeManager({ p1: refused });
    const result = await listToolsByServerIsolating({
      list: (keys) => manager.getToolsForAiSdkByServer(keys),
      keys: ["a", "p1", "p2"],
      isolatedKeys: new Set(["p1", "p2"]),
    });
    expect(Object.keys(result.byServer)).toEqual(["a", "p2"]);
    expect([...result.failed]).toEqual([["p1", refused]]);
  });

  it("still fails the turn when a server that is not isolated fails", async () => {
    const { manager } = fakeManager({ a: new Error("selected server down") });
    await expect(
      listToolsByServerIsolating({
        list: (keys) => manager.getToolsForAiSdkByServer(keys),
        keys: ["a", "p1"],
        isolatedKeys: new Set(["p1"]),
      }),
    ).rejects.toThrow("selected server down");
  });

  it("keeps the turn's server order, so a shared tool name resolves as before", async () => {
    const { manager } = fakeManager();
    const result = await listToolsByServerIsolating({
      list: (keys) => manager.getToolsForAiSdkByServer(keys),
      keys: ["p1", "a", "b"],
      isolatedKeys: new Set(["p1"]),
    });
    expect(Object.keys(result.byServer)).toEqual(["p1", "a", "b"]);
  });
});

describe("createTurnToolLister", () => {
  it("is the manager's own listing when the turn isolates nothing", async () => {
    const { manager, getToolsForAiSdkByServer, getToolsForAiSdk } =
      fakeManager();
    const lister = createTurnToolLister({
      manager,
      serverIds: ["a", "b"],
      isolatedServers: [],
      keysOf: (id) => [id],
      toolOptions: undefined,
      within,
    });
    await lister.byServer();
    await lister.flat();
    expect(getToolsForAiSdkByServer.mock.calls).toEqual([
      [["a", "b"], undefined],
    ]);
    expect(getToolsForAiSdk.mock.calls).toEqual([[["a", "b"], undefined]]);
    expect(lister.unavailable().size).toBe(0);
  });

  it("holds a hanging plugin server to its own budget and runs the turn without it", async () => {
    const { manager } = fakeManager({}, ["p1"]);
    const lister = createTurnToolLister({
      manager,
      serverIds: ["a", "p1"],
      isolatedServers: ["p1"],
      keysOf: (id) => [id],
      toolOptions: undefined,
      within: (listing) => withinToolListingBudget(listing, 20, () => '"p1"'),
    });
    expect(Object.keys(await lister.flat())).toEqual(["a_tool"]);
    const unavailable = lister.unavailable();
    expect([...unavailable.keys()]).toEqual(["p1"]);
    expect((unavailable.get("p1") as Error).name).toBe("TimeoutError");
  });

  it("reports a server by id when one of its connections fails", async () => {
    const { manager } = fakeManager({ "p1::work": new Error("expired") });
    const lister = createTurnToolLister({
      manager,
      serverIds: ["a", "p1::home", "p1::work"],
      isolatedServers: ["p1"],
      keysOf: (id) => (id === "p1" ? ["p1::home", "p1::work"] : [id]),
      toolOptions: undefined,
      within,
    });
    expect(Object.keys(await lister.byServer())).toEqual(["a", "p1::home"]);
    expect([...lister.unavailable().keys()]).toEqual(["p1"]);
  });

  it("lists every registered server when the turn names none", async () => {
    const { manager, calls } = fakeManager();
    const lister = createTurnToolLister({
      manager,
      serverIds: undefined,
      isolatedServers: ["p1"],
      keysOf: (id) => [id],
      toolOptions: undefined,
      within,
    });
    await lister.byServer();
    expect(calls).toEqual([["a"], ["p1"]]);
  });
});

describe("pluginServerUnavailableReason", () => {
  it("asks for a sign-in when our builder refused the server with a 401", () => {
    const refusal = new WebRouteError(
      401,
      ErrorCode.UNAUTHORIZED,
      'Server "mail" requires OAuth authentication.',
      { oauthRequired: true },
    );
    expect(pluginServerUnavailableReason(refusal)).toBe("needs_auth");
    expect(
      pluginServerUnavailableReason(new Error("connect", { cause: refusal })),
    ).toBe("needs_auth");
  });

  it("asks for a sign-in when the MCP server itself answers 401", () => {
    expect(
      pluginServerUnavailableReason(
        new Error("Error POSTing to endpoint (HTTP 401): unauthorized"),
      ),
    ).toBe("needs_auth");
  });

  it("asks for a sign-in when the server refuses for missing scopes", () => {
    const refusal = Object.assign(new Error("insufficient_scope"), {
      name: "InsufficientScopeError",
    });
    expect(pluginServerUnavailableReason(refusal)).toBe("needs_auth");
    expect(
      pluginServerUnavailableReason(new Error("list", { cause: refusal })),
    ).toBe("needs_auth");
  });

  it("calls every other failure unreachable", () => {
    for (const error of [
      new WebRouteError(403, ErrorCode.FORBIDDEN, "Access denied"),
      new WebRouteError(502, ErrorCode.SERVER_UNREACHABLE, "Bad gateway"),
      new Error("Error POSTing to endpoint (HTTP 503)"),
      new TypeError("fetch failed"),
    ]) {
      expect(pluginServerUnavailableReason(error)).toBe("unreachable");
    }
  });
});

describe("unavailablePluginServers", () => {
  it("names only isolated servers, in the turn's order, a refusal before a listing failure", () => {
    const refused = new WebRouteError(401, ErrorCode.UNAUTHORIZED, "sign in");
    const failed = new TypeError("fetch failed");
    expect(
      unavailablePluginServers({
        serverIds: ["p2", "p1", "p3"],
        refused: { p1: refused },
        failed: new Map<string, unknown>([
          ["p1", failed],
          ["p2", failed],
          ["selected", failed],
        ]),
      }).map(({ serverId, reason }) => [serverId, reason]),
    ).toEqual([
      ["p2", "unreachable"],
      ["p1", "needs_auth"],
    ]);
  });
});

describe("emitPluginServersUnavailable", () => {
  const secret = "https://mail.example.com/mcp?token=sk-live-0123456789";

  it("writes one transient part with ids and reasons, never the error's text", () => {
    const written: UIMessageChunk[] = [];
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    emitPluginServersUnavailable(
      { write: (chunk) => written.push(chunk) },
      "chat_1",
      {
        serverIds: ["p1", "p2"],
        refused: {
          p1: new WebRouteError(
            401,
            ErrorCode.UNAUTHORIZED,
            `sign in at ${secret}`,
          ),
        },
        failed: new Map([["p2", new Error(`cannot reach ${secret}`)]]),
      },
    );
    expect(written).toHaveLength(1);
    expect(written[0]).toEqual({
      type: PLUGIN_SERVER_UNAVAILABLE_DATA_PART_TYPE,
      data: {
        servers: [
          { serverId: "p1", reason: "needs_auth" },
          { serverId: "p2", reason: "unreachable" },
        ],
        chatSessionId: "chat_1",
      },
      transient: true,
    });
    expect(isPluginServerUnavailableDataPart(written[0])).toBe(true);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("sk-live");
    expect(warn).toHaveBeenCalledWith(
      "[chat] turn ran without plugin servers",
      expect.objectContaining({
        servers: [
          expect.objectContaining({ serverId: "p1", reason: "needs_auth" }),
          expect.objectContaining({ serverId: "p2", reason: "unreachable" }),
        ],
      }),
    );
  });

  it("says nothing when every isolated server ran", () => {
    const write = vi.fn();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    emitPluginServersUnavailable({ write }, "chat_1", {
      serverIds: ["p1"],
      failed: new Map(),
    });
    emitPluginServersUnavailable({ write }, "chat_1", {});
    expect(write).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("costs only the notice when the stream is already gone", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    expect(() =>
      emitPluginServersUnavailable(
        {
          write: () => {
            throw new Error("controller closed");
          },
        },
        undefined,
        { serverIds: ["p1"], failed: new Map([["p1", new Error("down")]]) },
      ),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      "[chat] plugin server notice stream write failed",
      expect.anything(),
    );
  });
});

 it("keeps healthy siblings and forwards only the failing server's scope challenge", async () => {
   const refusal = Object.assign(new Error("secret-error-text"), {
     name: "InsufficientScopeError",
     requiredScope: "mail.write",
     resourceMetadataUrl: new URL("https://mail.example/metadata"),
     errorDescription: "secret-error-description",
   });
   const { manager } = fakeManager({
     p1: new Error("wrapped", { cause: refusal }),
   });
   const lister = createTurnToolLister({
     manager,
     serverIds: ["a", "p1", "p2"],
     isolatedServers: ["p1", "p2"],
     keysOf: (id) => [id],
     toolOptions: undefined,
     within,
   });
   expect(Object.keys(await lister.byServer())).toEqual(["a", "p2"]);
   const written: UIMessageChunk[] = [];
   const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
   emitPluginServersUnavailable(
     { write: (chunk) => written.push(chunk) },
     "chat_1",
     { serverIds: ["p1", "p2"], failed: lister.unavailable() },
   );
   expect(written).toEqual([
     {
       type: PLUGIN_SERVER_UNAVAILABLE_DATA_PART_TYPE,
       data: {
         chatSessionId: "chat_1",
         servers: [
           {
             serverId: "p1",
             reason: "needs_auth",
             scopeChallenge: {
               requiredScope: "mail.write",
               resourceMetadataUrl: "https://mail.example/metadata",
             },
           },
         ],
       },
       transient: true,
     },
   ]);
   expect(isPluginServerUnavailableDataPart(written[0])).toBe(true);
   expect(JSON.stringify([written, warn.mock.calls])).not.toContain(
     "secret-error",
   );
 });
