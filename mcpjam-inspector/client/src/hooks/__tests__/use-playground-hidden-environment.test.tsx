import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivePluginRow } from "@/lib/plugins/active-plugins-types";

const state = vi.hoisted(() => ({
  plugins: [] as ActivePluginRow[],
  activePluginsProjectIds: [] as Array<string | null | undefined>,
  isMember: true as boolean | undefined,
  secrets: undefined as unknown,
  secretsProjectIds: [] as Array<string | null | undefined>,
  ensure: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/hooks/useActivePlugins", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/useActivePlugins")>();
  return {
    ...actual,
    activePluginsRuntimeVenue: () => "hosted",
    useActivePlugins: (projectId: string | null | undefined) => {
      state.activePluginsProjectIds.push(projectId);
      const plugins = projectId ? state.plugins : [];
      return {
        plugins,
        activePlugins: plugins.filter((plugin) => plugin.status === "active"),
        activeServers: actual.activePluginServers(plugins),
        isLoading: false,
      };
    },
  };
});
vi.mock("@/hooks/useProjectEnvironments", () => ({
  useEnsureAdhocEnvironment: () => state.ensure,
}));
vi.mock("@/hooks/use-is-member-actor", () => ({
  useIsMemberActor: () => state.isMember,
}));
vi.mock("@/hooks/useProjectSecrets", () => ({
  useProjectSecrets: (projectId: string | null | undefined) => {
    state.secretsProjectIds.push(projectId);
    return projectId ? state.secrets : undefined;
  },
}));
vi.mock("convex/react", () => ({
  useConvex: () => ({ query: state.query }),
}));

import { usePlaygroundHiddenEnvironment } from "../use-playground-hidden-environment";

const PROJECT_ID = "j57abcdefghijklmnopqrstuvwxyz012";

function plugin(
  id: string,
  overrides: Partial<ActivePluginRow> = {},
): ActivePluginRow {
  return {
    pluginId: `plg_${id}`,
    pluginVersionId: `ver_${id}`,
    name: id,
    displayName: id.toUpperCase(),
    status: "active",
    servers: [
      {
        serverId: `srv_${id}`,
        name: `${id}-server`,
        componentKey: "server",
        placement: "remote",
      },
    ],
    skills: [],
    ...overrides,
  };
}

function render(
  input: Partial<Parameters<typeof usePlaygroundHiddenEnvironment>[0]> = {},
) {
  return renderHook(
    (props: Parameters<typeof usePlaygroundHiddenEnvironment>[0]) =>
      usePlaygroundHiddenEnvironment(props),
    {
      initialProps: {
        projectId: PROJECT_ID,
        eligible: true,
        hostId: "host_1",
        harnessId: null,
        hostResolved: true,
        ...input,
      },
    },
  );
}

describe("usePlaygroundHiddenEnvironment", () => {
  beforeEach(() => {
    state.plugins = [];
    state.activePluginsProjectIds = [];
    state.isMember = true;
    state.secrets = undefined;
    state.secretsProjectIds = [];
    state.ensure.mockReset();
    state.query.mockReset();
    let n = 0;
    state.ensure.mockImplementation(async () => ({
      environment: { environmentId: `env_${++n}` },
      created: true,
    }));
  });

  it("composes nothing without a runnable plugin", async () => {
    state.plugins = [
      plugin("bits", { status: "skipped", reason: "needs_auth" }),
    ];
    const { result } = render();
    expect(result.current.wanted).toBe(false);
    expect(result.current.pluginServers).toEqual([]);
    // Skipped rows stay readable for the notice.
    expect(result.current.plugins).toHaveLength(1);
    await Promise.resolve();
    expect(state.ensure).not.toHaveBeenCalled();
  });

  it("composes one ad-hoc environment for the client and the runnable versions", async () => {
    state.plugins = [
      plugin("bits"),
      plugin("off", { status: "skipped", reason: "disabled" }),
      plugin("cad"),
    ];
    const { result } = render();
    expect(result.current.wanted).toBe(true);
    expect(result.current.environmentId).toBeNull();
    await waitFor(() => expect(result.current.environmentId).toBe("env_1"));
    expect(state.ensure).toHaveBeenCalledTimes(1);
    expect(state.ensure).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      hostId: "host_1",
      serverSelection: { mode: "none" },
      pluginVersionIds: ["ver_bits", "ver_cad"],
    });
    expect(result.current.pluginServerIds).toEqual(["srv_bits", "srv_cad"]);
    expect(result.current.pluginServers.map((s) => s.pluginLabel)).toEqual([
      "BITS",
      "CAD",
    ]);
  });

  it("re-ensures only when the composition changes, never on a re-render", async () => {
    state.plugins = [plugin("bits")];
    const { result, rerender } = render();
    await waitFor(() => expect(result.current.environmentId).toBe("env_1"));
    const props = {
      projectId: PROJECT_ID,
      eligible: true,
      hostId: "host_1",
      harnessId: null,
      hostResolved: true,
    };
    // Same plugin set, a fresh array (a refetch): no new ensure.
    state.plugins = [plugin("bits")];
    rerender(props);
    rerender(props);
    expect(state.ensure).toHaveBeenCalledTimes(1);

    // Another client is another composition.
    rerender({ ...props, hostId: "host_2" });
    await waitFor(() => expect(result.current.environmentId).toBe("env_2"));
    expect(state.ensure).toHaveBeenCalledTimes(2);
    expect(state.ensure.mock.calls[1][0].hostId).toBe("host_2");

    // A new active version is another composition too.
    state.plugins = [plugin("bits", { pluginVersionId: "ver_bits_2" })];
    rerender({ ...props, hostId: "host_2" });
    await waitFor(() => expect(result.current.environmentId).toBe("env_3"));
    expect(state.ensure.mock.calls[2][0].pluginVersionIds).toEqual([
      "ver_bits_2",
    ]);
  });

  it("does nothing while the environments UI is on, for a non-member, or without a client", () => {
    state.plugins = [plugin("bits")];
    expect(render({ eligible: false }).result.current.wanted).toBe(false);
    state.isMember = false;
    expect(render().result.current.wanted).toBe(false);
    state.isMember = true;
    expect(render({ hostId: null }).result.current.wanted).toBe(false);
    // The plugins are not even read while the environments UI is on.
    expect(state.activePluginsProjectIds).toContain(null);
    expect(state.ensure).not.toHaveBeenCalled();
  });

  it("falls back to a plain client turn when composing fails", async () => {
    state.plugins = [plugin("bits")];
    state.ensure.mockRejectedValueOnce(new Error("FORBIDDEN"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = render();
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.wanted).toBe(false);
    expect(result.current.pluginServers).toEqual([]);
    warn.mockRestore();
  });

  it("grants a Cursor client the member's own key, as its client turn does", async () => {
    state.plugins = [plugin("bits")];
    state.secrets = [
      {
        secretId: "sec_mine",
        name: "CURSOR_API_KEY",
        delivery: "brokered",
        sharing: "user",
        isOwner: true,
        brokerHosts: ["api2.cursor.sh"],
        brokerHeader: "authorization",
        brokerTemplate: "Bearer {}",
      },
    ];
    const { result } = render({ harnessId: "cursor" });
    await waitFor(() => expect(result.current.environmentId).toBe("env_1"));
    expect(state.ensure.mock.calls[0][0].secretSelection).toEqual({
      mode: "explicit",
      secretIds: ["sec_mine"],
    });
  });

  it("leaves a Cursor client with no usable key on its client turn", async () => {
    state.plugins = [plugin("bits")];
    state.secrets = [];
    const { result } = render({ harnessId: "cursor" });
    expect(result.current.wanted).toBe(false);
    await Promise.resolve();
    expect(state.ensure).not.toHaveBeenCalled();
  });

  it("waits for the client's settings before composing", async () => {
    state.plugins = [plugin("bits")];
    const { result, rerender } = render({ hostResolved: false });
    // Wanted, so sends wait — but nothing composed for a client whose
    // harness (and so whose key) is not known yet.
    expect(result.current.wanted).toBe(true);
    expect(result.current.environmentId).toBeNull();
    await Promise.resolve();
    expect(state.ensure).not.toHaveBeenCalled();
    rerender({
      projectId: PROJECT_ID,
      eligible: true,
      hostId: "host_1",
      harnessId: null,
      hostResolved: true,
    });
    await waitFor(() => expect(result.current.environmentId).toBe("env_1"));
  });

  it("does not read secrets for a client that needs no key", () => {
    state.plugins = [plugin("bits")];
    render({ harnessId: "claude-code" });
    expect(state.secretsProjectIds.every((id) => id === null)).toBe(true);
  });

  describe("recover", () => {
    it("re-reads the plugins and recomposes", async () => {
      state.plugins = [plugin("bits")];
      const { result } = render();
      await waitFor(() => expect(result.current.environmentId).toBe("env_1"));
      state.query.mockResolvedValue({
        enabled: true,
        plugins: [plugin("cad")],
      });

      let recovery: unknown;
      await act(async () => {
        recovery = await result.current.recover();
      });

      expect(state.query).toHaveBeenCalledWith("plugins:resolveActivePlugins", {
        projectId: PROJECT_ID,
        content: false,
        runtimeVenue: "hosted",
      });
      expect(recovery).toEqual({
        ok: true,
        environmentId: "env_2",
        pluginServerIds: ["srv_cad"],
      });
      expect(state.ensure.mock.calls[1][0].pluginVersionIds).toEqual([
        "ver_cad",
      ]);
      // Held until the subscription moves on.
      expect(result.current.environmentId).toBe("env_2");
      expect(result.current.pluginServerIds).toEqual(["srv_cad"]);
    });

    it("turns the chat back into a client turn when nothing is runnable", async () => {
      state.plugins = [plugin("bits")];
      const { result } = render();
      await waitFor(() => expect(result.current.environmentId).toBe("env_1"));
      state.query.mockResolvedValue({
        enabled: true,
        plugins: [plugin("bits", { status: "skipped", reason: "disabled" })],
      });

      let recovery: unknown;
      await act(async () => {
        recovery = await result.current.recover();
      });

      expect(recovery).toEqual({ ok: true, environmentId: null });
      expect(result.current.wanted).toBe(false);
    });

    const PROPS = {
      projectId: PROJECT_ID,
      eligible: true,
      hostId: "host_1",
      harnessId: null,
      hostResolved: true,
    };

    it("drops a re-read whose chat moved to another client meanwhile (nothing runnable)", async () => {
      state.plugins = [plugin("bits")];
      const { result, rerender } = render();
      await waitFor(() => expect(result.current.environmentId).toBe("env_1"));
      let answer!: (value: unknown) => void;
      state.query.mockImplementationOnce(
        () => new Promise((resolve) => (answer = resolve)),
      );

      let pending!: Promise<unknown>;
      act(() => {
        pending = result.current.recover();
      });
      rerender({ ...PROPS, hostId: "host_2" });
      await waitFor(() => expect(result.current.environmentId).toBe("env_2"));

      let recovery: unknown;
      await act(async () => {
        answer({ enabled: true, plugins: [] });
        recovery = await pending;
      });

      // Not "run as a plain client turn": that answer was for host_1.
      expect(recovery).toEqual({ ok: false });
      expect(result.current.wanted).toBe(true);
      expect(result.current.environmentId).toBe("env_2");
    });

    it("drops a recompose that finishes after an A→B→A switch", async () => {
      state.plugins = [plugin("bits")];
      const { result, rerender } = render();
      await waitFor(() => expect(result.current.environmentId).toBe("env_1"));
      state.query.mockResolvedValue({
        enabled: true,
        plugins: [plugin("cad")],
      });
      let release!: (value: unknown) => void;
      state.ensure.mockImplementationOnce(
        () => new Promise((resolve) => (release = resolve)),
      );

      let pending!: Promise<unknown>;
      act(() => {
        pending = result.current.recover();
      });
      await waitFor(() => expect(state.ensure).toHaveBeenCalledTimes(2));

      // Away to another client and back: the key is A again, but the
      // composition under it was ensured afresh.
      rerender({ ...PROPS, hostId: "host_2" });
      await waitFor(() => expect(result.current.environmentId).toBe("env_2"));
      rerender(PROPS);
      await waitFor(() => expect(result.current.environmentId).toBe("env_3"));

      let recovery: unknown;
      await act(async () => {
        release({ environment: { environmentId: "env_stale" }, created: true });
        recovery = await pending;
      });

      expect(recovery).toEqual({ ok: false });
      // The fresh composition stands.
      expect(result.current.environmentId).toBe("env_3");
      expect(result.current.pluginServerIds).toEqual(["srv_bits"]);
    });

    it("reports a failed re-read without throwing", async () => {
      state.plugins = [plugin("bits")];
      const { result } = render();
      await waitFor(() => expect(result.current.environmentId).toBe("env_1"));
      state.query.mockRejectedValue(new Error("offline"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      let recovery: unknown;
      await act(async () => {
        recovery = await result.current.recover();
      });

      expect(recovery).toEqual({ ok: false });
      warn.mockRestore();
    });
  });
});
