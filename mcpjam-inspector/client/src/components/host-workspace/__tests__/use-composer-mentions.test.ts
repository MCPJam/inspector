import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/session-token", () => ({ authFetch: state.fetch }));
import { useComposerMentions } from "../use-composer-mentions";
import { useTrafficLogStore } from "@/stores/traffic-log-store";

const token = "t".repeat(43);
const scope = {
  projectId: "project",
  hostId: "host",
  threadId: "thread",
  pluginWorkspace: { version: 1 as const, workspaceId: "chat-a" },
};
const servers = [
  { serverId: "bits", name: "Bits & Bolts" },
  { serverId: "plain", name: "Plain Server" },
  { serverId: "broken", name: "Broken Server" },
  // An older server response without the discovery `mentions` field.
  { serverId: "legacy", name: "Legacy Parts" },
];
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });

function route(approvalRequired = false) {
  let searches = 0;
  state.fetch.mockImplementation(async (url: string, init: RequestInit) => {
    const action = url.split("/plugin-instances/")[1];
    const body = JSON.parse(String(init.body));
    if (action === "discover") {
      if (body.serverId === "broken") return json({ error: "down" }, 502);
      if (body.serverId === "legacy") return json({ entries: [] });
      return json({
        entries: [],
        mentions:
          body.serverId === "bits"
            ? { available: true, toolName: "find_parts", title: "Parts" }
            : { available: false },
      });
    }
    if (action === "mentions/open") {
      if (body.serverId === "broken") return json({ error: "down" }, 502);
      return json({
        mention:
          body.serverId === "bits" || body.serverId === "legacy"
            ? { instanceToken: token, toolName: "find_parts", title: "Parts" }
            : null,
      });
    }
    if (action === "mentions/close") return json({ status: "closed" });
    if (action === "mentions/search") {
      searches++;
      if (approvalRequired && !body.approval)
        return json(
          {
            status: "approval_required",
            approval: {
              id: `approval-${searches}`,
              invocationId: body.invocationId,
              name: "find_parts",
              params: { name: "find_parts", arguments: body.params },
            },
          },
          409,
        );
      return json({
        status: "completed",
        result: {
          content: [],
          structuredContent: {
            items: [
              {
                type: "resource",
                resourceUri: "fixture://hex-bolt",
                title: `Result for ${body.params.query}`,
              },
            ],
          },
        },
      });
    }
    throw new Error(`unexpected ${action}`);
  });
}

beforeEach(() => {
  state.fetch.mockReset();
  useTrafficLogStore.getState().clear();
});

describe("composer mentions", () => {
  it("lists plugins App discovery reports, probes only servers that predate it, and logs a failing server", async () => {
    route();
    const approve = vi.fn(async () => true);
    const { result, rerender } = renderHook(
      ({ approval }) => useComposerMentions(scope, servers, approval),
      { initialProps: { approval: approve } },
    );
    const plugins = await result.current.mentions!.plugins(
      new AbortController().signal,
    );
    expect(plugins).toEqual([
      { serverId: "bits", name: "Bits & Bolts" },
      { serverId: "legacy", name: "Legacy Parts" },
    ]);
    const calls = (action: string) =>
      state.fetch.mock.calls
        .filter(([url]) => String(url).endsWith(`/${action}`))
        .map(([, init]) => JSON.parse(String(init.body)).serverId);
    // Discovery answers for every server; only the legacy one is probed.
    expect(calls("mentions/open")).toEqual(["legacy"]);
    const discovered = () => calls("discover").length;
    expect(discovered()).toBe(4);
    const log = useTrafficLogStore
      .getState()
      .mcpServerItems.find((row) => row.serverId === "broken");
    expect(log?.method).toBe("plugin-extensions/mention-discovery-failed");
    // A fresh approval closure does not reset the session's cache; only the
    // failed server is asked again.
    rerender({ approval: vi.fn(async () => true) });
    await result.current.mentions!.plugins(new AbortController().signal);
    expect(discovered()).toBe(5);
    expect(calls("mentions/open")).toEqual(["legacy"]);
  });

  it("shows the owning plugin's icons on its row, and the server's icons", async () => {
    const serverIcons = [{ src: "https://cdn.example.invalid/server.png" }];
    state.fetch.mockImplementation(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(url).toMatch(/\/discover$/);
      return json({
        entries: [],
        mentions: { available: true, toolName: "find", title: "Find" },
        ...(body.serverId === "bits"
          ? { pluginId: "plugin-bits", serverIcons }
          : {}),
      });
    });
    const composerIcon = {
      url: "https://cdn.example.invalid/composer.png",
      contentType: "image/png",
    };
    const { result, rerender } = renderHook(
      ({ icons }) =>
        useComposerMentions(
          scope,
          servers.slice(0, 2),
          vi.fn(async () => true),
          icons,
        ),
      { initialProps: { icons: new Map() } },
    );
    // Icons that arrive after the composer mounted still show on "@".
    rerender({ icons: new Map([["plugin-bits", { composerIcon }]]) });
    const plugins = await result.current.mentions!.plugins(
      new AbortController().signal,
    );
    expect(plugins).toEqual([
      {
        serverId: "bits",
        name: "Bits & Bolts",
        pluginId: "plugin-bits",
        icons: { composerIcon },
        serverIcons,
      },
      // A plain MCP server has no plugin icons.
      { serverId: "plain", name: "Plain Server" },
    ]);
  });

  it("searches only the picked plugin with a multi-word query", async () => {
    route();
    const { result } = renderHook(() =>
      useComposerMentions(
        scope,
        servers,
        vi.fn(async () => true),
      ),
    );
    const rows = await result.current.mentions!.search(
      "bits",
      "hex bolt",
      new AbortController().signal,
    );
    expect(rows.map((row) => row.item)).toEqual([
      {
        type: "resource",
        resourceUri: "fixture://hex-bolt",
        title: "Result for hex bolt",
      },
    ]);
    const searched = state.fetch.mock.calls
      .filter(([url]) => String(url).endsWith("mentions/open"))
      .map(([, init]) => JSON.parse(String(init.body)).serverId);
    expect(searched).toEqual(["bits"]);
  });

  it("asks for approval once per plugin, not per keystroke", async () => {
    route(true);
    const approve = vi.fn(async () => true);
    const { result } = renderHook(() =>
      useComposerMentions(scope, servers, approve),
    );
    for (const query of ["h", "he", "hex", "hex b"])
      await result.current.mentions!.search(
        "bits",
        query,
        new AbortController().signal,
      );
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it("asks again after a declined approval", async () => {
    route(true);
    const approve = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const { result } = renderHook(() =>
      useComposerMentions(scope, servers, approve),
    );
    await expect(
      result.current.mentions!.search(
        "bits",
        "h",
        new AbortController().signal,
      ),
    ).rejects.toThrow("declined");
    await result.current.mentions!.search(
      "bits",
      "he",
      new AbortController().signal,
    );
    await result.current.mentions!.search(
      "bits",
      "hex",
      new AbortController().signal,
    );
    expect(approve).toHaveBeenCalledTimes(2);
  });
});
