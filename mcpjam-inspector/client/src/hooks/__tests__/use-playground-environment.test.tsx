/**
 * Playground environment mode — the override tri-state and the
 * select-vs-edit distinction (Project Environments, Phase 2.1).
 *
 * These two rules are the whole reason this hook exists, and both are the kind
 * that a "simplifying" refactor breaks silently:
 *
 *   - `null` (follow the environment) and `[]` (explicitly no servers) are
 *     DIFFERENT. Collapsing them re-enables servers the user just turned off.
 *   - Selecting a different environment clears the override; a live EDIT of the
 *     same environment does not. Environments are live config.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFlagValue, mockFetch, mockEnvironments } = vi.hoisted(() => ({
  mockFlagValue: { value: true as boolean | undefined },
  mockFetch: vi.fn(),
  mockEnvironments: { value: [] as Array<Record<string, unknown>> },
}));

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => mockFlagValue.value,
}));
vi.mock("@/lib/session-token", () => ({ authFetch: mockFetch }));
// The hook reads the selected row's `revision` from the reactive list so an
// edit elsewhere refetches the preview; the list is Convex-backed, so stub it.
vi.mock("@/hooks/useProjectEnvironments", () => ({
  useProjectEnvironments: () => mockEnvironments.value,
}));

import { usePlaygroundEnvironment } from "../use-playground-environment";

const PLUGINS = [
  { pluginId: "pl_1", pluginVersionId: "pv_1", name: "docs" },
  { pluginId: "pl_2", pluginVersionId: "pv_2", name: "linear" },
];

function previewPayload(
  environmentId: string,
  servers: Array<{ serverId: string; name: string; source?: string }>,
  revision = 1,
  plugins: Array<{
    pluginId: string;
    pluginVersionId: string;
    name: string;
  }> = []
) {
  return {
    specVersion: 1,
    environment: { environmentId, name: `Env ${environmentId}`, revision },
    host: {
      hostId: "host_1",
      hostName: "Claude Code",
      hostConfigId: "cfg_1",
      modelId: null,
      hostStyle: null,
      harness: "claude_code",
    },
    servers: servers.map((s) => ({
      ...s,
      source: s.source ?? "host_or_group",
    })),
    skills: [],
    plugins,
    capabilities: {
      requireToolApproval: null,
      respectToolVisibility: null,
      progressiveToolDiscovery: null,
      builtInToolIds: [],
      hasComputer: false,
      serverCount: servers.length,
      skillCount: 0,
      skillDelivery: "harness",
      pluginCount: plugins.length,
      serversOverridden: false,
    },
  };
}

function respondWith(payload: unknown) {
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => payload,
  } as unknown as Response);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockFlagValue.value = true;
  respondWith(
    previewPayload("env_1", [
      { serverId: "srv_a", name: "Alpha" },
      // Plugin-contributed: intentionally absent from
      // `servers:getProjectServers`, so it can only ever travel by id.
      { serverId: "srv_plugin", name: "Docs", source: "plugin" },
    ])
  );
});

async function renderEnvironment(projectId: string | null = "proj_1") {
  const rendered = renderHook(() => usePlaygroundEnvironment(projectId));
  return rendered;
}

describe("usePlaygroundEnvironment — mode", () => {
  it("is inert until an environment is selected", async () => {
    const { result } = await renderEnvironment();
    expect(result.current.isEnvironmentMode).toBe(false);
    expect(result.current.executionTarget).toBeUndefined();
    expect(result.current.environmentOverrides).toBeUndefined();
  });

  it("fails closed when the feature flag is off, even with a persisted id", async () => {
    localStorage.setItem(
      "mcp-previewed-environment-id",
      JSON.stringify({ proj_1: "env_1" })
    );
    mockFlagValue.value = false;
    const { result } = await renderEnvironment();
    expect(result.current.isEnvironmentMode).toBe(false);
    expect(result.current.executionTarget).toBeUndefined();
    // And it never even asks the server what the environment resolves to.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("selecting an environment produces exactly one environment target", async () => {
    const { result } = await renderEnvironment();
    act(() => result.current.selectEnvironment("env_1"));
    await waitFor(() => expect(result.current.preview).not.toBeNull());
    expect(result.current.isEnvironmentMode).toBe(true);
    expect(result.current.executionTarget).toEqual({
      kind: "environment",
      environmentId: "env_1",
    });
    // Reads go through the browser-reachable preview route — never /api/v1.
    expect(String(mockFetch.mock.calls[0][0])).toBe(
      "/api/web/environments/env_1/preview?projectId=proj_1"
    );
  });

  it("clearing the environment returns to host/ad-hoc mode", async () => {
    const { result } = await renderEnvironment();
    act(() => result.current.selectEnvironment("env_1"));
    await waitFor(() => expect(result.current.isEnvironmentMode).toBe(true));
    act(() => result.current.clearEnvironment());
    await waitFor(() => expect(result.current.isEnvironmentMode).toBe(false));
    expect(result.current.executionTarget).toBeUndefined();
  });
});

describe("usePlaygroundEnvironment — the override tri-state", () => {
  it("sends no override at all until the user touches a server", async () => {
    const { result } = await renderEnvironment();
    act(() => result.current.selectEnvironment("env_1"));
    await waitFor(() => expect(result.current.preview).not.toBeNull());

    expect(result.current.serverOverrideIds).toBeNull();
    expect(result.current.hasExplicitOverride).toBe(false);
    expect(result.current.environmentOverrides).toBeUndefined();
    // Every environment server shows enabled — that's the environment's own set.
    expect(result.current.servers.map((s) => s.enabled)).toEqual([true, true]);
  });

  it("turning one server off materializes the FULL set minus that server", async () => {
    // Not `[srv_plugin]`. The first toggle has to seed from the environment's
    // own set or "turn one off" would silently read as "keep only this one".
    const { result } = await renderEnvironment();
    act(() => result.current.selectEnvironment("env_1"));
    await waitFor(() => expect(result.current.preview).not.toBeNull());

    act(() => result.current.setServerEnabled("srv_a", false));
    expect(result.current.serverOverrideIds).toEqual(["srv_plugin"]);
    expect(result.current.hasExplicitOverride).toBe(true);
    expect(result.current.environmentOverrides).toEqual({
      serverIds: ["srv_plugin"],
    });
  });

  it("turning every server off is an EMPTY override, not an absent one", async () => {
    const { result } = await renderEnvironment();
    act(() => result.current.selectEnvironment("env_1"));
    await waitFor(() => expect(result.current.preview).not.toBeNull());

    act(() => result.current.setServerEnabled("srv_a", false));
    act(() => result.current.setServerEnabled("srv_plugin", false));

    expect(result.current.serverOverrideIds).toEqual([]);
    expect(result.current.hasExplicitOverride).toBe(true);
    // `{ serverIds: [] }` — the turn runs with no MCP servers, which is a
    // choice the user made and not the same as "use the environment's set".
    expect(result.current.environmentOverrides).toEqual({ serverIds: [] });
  });

  it("reset returns to null (follow the environment), not to an empty array", async () => {
    const { result } = await renderEnvironment();
    act(() => result.current.selectEnvironment("env_1"));
    await waitFor(() => expect(result.current.preview).not.toBeNull());

    act(() => result.current.setServerEnabled("srv_a", false));
    act(() => result.current.resetServersToEnvironment());

    expect(result.current.serverOverrideIds).toBeNull();
    expect(result.current.hasExplicitOverride).toBe(false);
    expect(result.current.environmentOverrides).toBeUndefined();
  });

  it("carries plugin-contributed servers by ID, never by name", async () => {
    const { result } = await renderEnvironment();
    act(() => result.current.selectEnvironment("env_1"));
    await waitFor(() => expect(result.current.preview).not.toBeNull());

    act(() => result.current.setServerEnabled("srv_a", false));
    // The hidden plugin server survives the override as a Convex id. It has no
    // representation in the browser's name-keyed project-server catalog, so a
    // name-shaped override would have dropped it here.
    expect(result.current.environmentOverrides?.serverIds).toEqual([
      "srv_plugin",
    ]);
    expect(
      result.current.servers.find((s) => s.serverId === "srv_plugin")?.source
    ).toBe("plugin");
  });
});

describe("usePlaygroundEnvironment — the EPHEMERAL plugin narrowing", () => {
  async function withPlugins() {
    respondWith(
      previewPayload(
        "env_1",
        [{ serverId: "srv_a", name: "Alpha" }],
        1,
        PLUGINS
      )
    );
    const rendered = await renderEnvironment();
    act(() => rendered.result.current.selectEnvironment("env_1"));
    await waitFor(() => expect(rendered.result.current.preview).not.toBeNull());
    return rendered;
  }

  it("shows the environment's pins enabled and sends no override", async () => {
    const { result } = await withPlugins();
    expect(result.current.plugins.map((p) => p.pluginVersionId)).toEqual([
      "pv_1",
      "pv_2",
    ]);
    expect(result.current.plugins.every((p) => p.enabled)).toBe(true);
    expect(result.current.hasExplicitPluginOverride).toBe(false);
    expect(result.current.environmentOverrides).toBeUndefined();
  });

  it("turning one plugin off materializes the FULL pin set minus that one", async () => {
    const { result } = await withPlugins();
    act(() => result.current.setPluginVersionEnabled("pv_1", false));
    expect(result.current.pluginVersionOverrideIds).toEqual(["pv_2"]);
    expect(result.current.environmentOverrides).toEqual({
      pluginVersionIds: ["pv_2"],
    });
    expect(result.current.plugins.map((p) => p.enabled)).toEqual([false, true]);
  });

  it("turning every plugin off is an EMPTY override, not an absent one", async () => {
    const { result } = await withPlugins();
    act(() => result.current.setPluginVersionEnabled("pv_1", false));
    act(() => result.current.setPluginVersionEnabled("pv_2", false));
    expect(result.current.environmentOverrides).toEqual({
      pluginVersionIds: [],
    });
  });

  it("travels alongside a server override without clobbering it", async () => {
    const { result } = await withPlugins();
    act(() => result.current.setServerEnabled("srv_a", false));
    act(() => result.current.setPluginVersionEnabled("pv_2", false));
    expect(result.current.environmentOverrides).toEqual({
      serverIds: [],
      pluginVersionIds: ["pv_1"],
    });
  });

  it("reset and re-selecting an environment both return to the environment's pins", async () => {
    const { result } = await withPlugins();
    act(() => result.current.setPluginVersionEnabled("pv_1", false));
    act(() => result.current.resetPluginsToEnvironment());
    expect(result.current.pluginVersionOverrideIds).toBeNull();
    expect(result.current.environmentOverrides).toBeUndefined();

    // Nothing is written down, so switching environments cannot carry a
    // narrowing across — the next environment's own pins are the baseline.
    act(() => result.current.setPluginVersionEnabled("pv_2", false));
    respondWith(
      previewPayload("env_2", [{ serverId: "srv_z", name: "Zeta" }], 1, [
        PLUGINS[0],
      ])
    );
    act(() => result.current.selectEnvironment("env_2"));
    await waitFor(() =>
      expect(result.current.preview?.environment.environmentId).toBe("env_2")
    );
    expect(result.current.pluginVersionOverrideIds).toBeNull();
    expect(result.current.plugins.map((p) => p.enabled)).toEqual([true]);
  });
});

describe("usePlaygroundEnvironment — select vs edit", () => {
  it("refetches when the selected row's revision moves (edited elsewhere)", async () => {
    // Another tab or a collaborator edits the environment. Without watching
    // the revision, the next turn resolves server-side against the NEW
    // revision while the UI still shows the old servers — and toggling one of
    // those stale checkboxes would build an override from obsolete ids.
    mockEnvironments.value = [{ environmentId: "env_1", revision: 1 }];
    const { result, rerender } = await renderEnvironment();
    act(() => result.current.selectEnvironment("env_1"));
    await waitFor(() => expect(result.current.preview).not.toBeNull());
    const callsAfterSelect = mockFetch.mock.calls.length;

    respondWith(
      previewPayload("env_1", [{ serverId: "srv_a", name: "Alpha" }], 2)
    );
    mockEnvironments.value = [{ environmentId: "env_1", revision: 2 }];
    rerender();

    await waitFor(() =>
      expect(mockFetch.mock.calls.length).toBeGreaterThan(callsAfterSelect)
    );
    await waitFor(() =>
      expect(result.current.preview?.environment.revision).toBe(2)
    );
  });

  it("selecting a DIFFERENT environment clears the override", async () => {
    const { result } = await renderEnvironment();
    act(() => result.current.selectEnvironment("env_1"));
    await waitFor(() => expect(result.current.preview).not.toBeNull());
    act(() => result.current.setServerEnabled("srv_a", false));
    expect(result.current.hasExplicitOverride).toBe(true);

    respondWith(previewPayload("env_2", [{ serverId: "srv_z", name: "Zeta" }]));
    act(() => result.current.selectEnvironment("env_2"));
    await waitFor(() =>
      expect(result.current.preview?.environment.environmentId).toBe("env_2")
    );

    expect(result.current.serverOverrideIds).toBeNull();
    expect(result.current.environmentOverrides).toBeUndefined();
  });

  it("a live EDIT of the same environment keeps the override and updates the base", async () => {
    const { result } = await renderEnvironment();
    act(() => result.current.selectEnvironment("env_1"));
    await waitFor(() => expect(result.current.preview).not.toBeNull());
    act(() => result.current.setServerEnabled("srv_a", false));

    // Someone edits the environment on /environments: new revision, a server
    // added. Live-config semantics — the conversation and the user's per-turn
    // narrowing both survive.
    respondWith(
      previewPayload(
        "env_1",
        [
          { serverId: "srv_a", name: "Alpha" },
          { serverId: "srv_plugin", name: "Docs", source: "plugin" },
          { serverId: "srv_new", name: "New" },
        ],
        2
      )
    );
    act(() => result.current.refreshPreview());
    await waitFor(() =>
      expect(result.current.preview?.environment.revision).toBe(2)
    );

    // The refreshed base is visible…
    expect(result.current.servers.map((s) => s.serverId)).toEqual([
      "srv_a",
      "srv_plugin",
      "srv_new",
    ]);
    // …and the override was NOT erased.
    expect(result.current.serverOverrideIds).toEqual(["srv_plugin"]);
    expect(
      result.current.servers.find((s) => s.serverId === "srv_a")?.enabled
    ).toBe(false);
  });

  it("re-selecting the environment that is ALREADY selected keeps the override", async () => {
    // Picking the current entry out of the picker is a no-op selection, not an
    // environment change. Clearing the per-turn narrowing on it would discard a
    // choice the user never asked to undo.
    const { result } = await renderEnvironment();
    act(() => result.current.selectEnvironment("env_1"));
    await waitFor(() => expect(result.current.preview).not.toBeNull());
    act(() => result.current.setServerEnabled("srv_a", false));
    expect(result.current.serverOverrideIds).toEqual(["srv_plugin"]);

    act(() => result.current.selectEnvironment("env_1"));

    expect(result.current.serverOverrideIds).toEqual(["srv_plugin"]);
    expect(result.current.environmentOverrides).toEqual({
      serverIds: ["srv_plugin"],
    });
  });
});

describe("usePlaygroundEnvironment — nothing stale across a transition", () => {
  it("blanks the previous environment's preview the instant the id changes", async () => {
    const { result } = await renderEnvironment();
    act(() => result.current.selectEnvironment("env_1"));
    await waitFor(() =>
      expect(result.current.preview?.environment.environmentId).toBe("env_1")
    );

    // env_2's resolve never lands. The panel must NOT keep describing env_1 in
    // the meantime: its name, host, counts and — worst — its server checkboxes
    // belong to a different bundle, and a click on one of those would build an
    // override out of the wrong environment's server ids.
    mockFetch.mockReturnValue(new Promise(() => {}));
    act(() => result.current.selectEnvironment("env_2"));

    expect(result.current.preview).toBeNull();
    expect(result.current.servers).toEqual([]);
    expect(result.current.isPreviewLoading).toBe(true);
    // …and the caller can see the target isn't ready, so sends stay gated.
    expect(result.current.isResolutionPending).toBe(true);
  });

  it("never reports one project's environment under another project's id", async () => {
    localStorage.setItem(
      "mcp-previewed-environment-id",
      JSON.stringify({ proj_1: "env_1" })
    );
    const seen: Array<string | null> = [];
    const { rerender } = renderHook(
      ({ projectId }: { projectId: string }) => {
        const state = usePlaygroundEnvironment(projectId);
        seen.push(state.environmentId);
        return state;
      },
      { initialProps: { projectId: "proj_1" } }
    );
    await waitFor(() => expect(seen).toContain("env_1"));

    const before = seen.length;
    rerender({ projectId: "proj_2" });

    // proj_2 has no previewed environment. Carrying proj_1's id through even
    // one committed render would put the Playground into environment mode for
    // an environment the new project doesn't own — and ask the server to
    // resolve it under the new project id.
    expect(seen.slice(before)).not.toContain("env_1");
    for (const call of mockFetch.mock.calls) {
      expect(String(call[0])).not.toContain("projectId=proj_2");
    }
  });

  it("refetches on return to the tab, because the row revision isn't the whole truth", async () => {
    // A rotated host config or a changed server-group membership does not bump
    // the environment row's revision, so the revision dependency alone can't
    // see them. A refetch on return closes the common "edited in another tab"
    // case without a subscription or a poll.
    const { result } = await renderEnvironment();
    act(() => result.current.selectEnvironment("env_1"));
    await waitFor(() => expect(result.current.preview).not.toBeNull());
    const callsBefore = mockFetch.mock.calls.length;

    // Switching to another APPLICATION: the tab stays visible, so only the
    // window blur/focus pair fires.
    act(() => {
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() =>
      expect(mockFetch.mock.calls.length).toBeGreaterThan(callsBefore)
    );
  });

  it("returning from a backgrounded tab refetches ONCE, not once per event", async () => {
    // Backgrounding and returning fires BOTH `visibilitychange` and `focus`.
    // Refetching per event would issue two requests for one return, and the
    // loser isn't free: it flips `isLoading` a second time, which gates sends.
    const { result } = await renderEnvironment();
    act(() => result.current.selectEnvironment("env_1"));
    await waitFor(() => expect(result.current.preview).not.toBeNull());
    const callsBefore = mockFetch.mock.calls.length;

    const visibility = { value: "visible" };
    const original = Object.getOwnPropertyDescriptor(
      Document.prototype,
      "visibilityState"
    );
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility.value,
    });
    try {
      act(() => {
        visibility.value = "hidden";
        window.dispatchEvent(new Event("blur"));
        document.dispatchEvent(new Event("visibilitychange"));
      });
      // Two SEPARATE `act` blocks on purpose. The browser delivers
      // `visibilitychange` and `focus` as distinct tasks, so React commits
      // between them — batching them into one block would let a
      // refetch-per-event implementation collapse to a single effect run and
      // pass this test without coalescing anything.
      visibility.value = "visible";
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });

      await waitFor(() =>
        expect(mockFetch.mock.calls.length).toBe(callsBefore + 1)
      );
      // Hold past any second in-flight request the pair could have started.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mockFetch.mock.calls.length).toBe(callsBefore + 1);
    } finally {
      if (original) {
        Object.defineProperty(document, "visibilityState", original);
      } else {
        delete (document as unknown as Record<string, unknown>).visibilityState;
      }
    }
  });

  it("does not refetch on a focus event the tab never left", async () => {
    // A bare `focus` with no preceding away signal is not a return — e.g. a
    // window that was already frontmost. Treating it as one would refetch on
    // incidental focus churn and flip the send gate each time.
    const { result } = await renderEnvironment();
    act(() => result.current.selectEnvironment("env_1"));
    await waitFor(() => expect(result.current.preview).not.toBeNull());
    const callsBefore = mockFetch.mock.calls.length;

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockFetch.mock.calls.length).toBe(callsBefore);
  });
});
