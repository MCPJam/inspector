import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivePluginRow } from "@/lib/plugins/active-plugins-types";

const state = vi.hoisted(() => ({
  plugins: [] as ActivePluginRow[],
  activePluginsProjectIds: [] as Array<string | null | undefined>,
  activePluginsVenues: [] as Array<string | undefined>,
  activeLoading: false,
  activeFailed: false,
  hostedMode: false,
  clientRunsHere: false,
  pluginsEnabled: true,
  isMember: true as boolean | undefined,
  secrets: undefined as unknown,
  secretsProjectIds: [] as Array<string | null | undefined>,
  ensure: vi.fn(),
  query: vi.fn(),
  signInAvailable: false,
  signIn: vi.fn(),
  signInProjectIds: [] as Array<string | null>,
  toastInfo: vi.fn(),
}));

vi.mock("@/hooks/useActivePlugins", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/useActivePlugins")>();
  return {
    ...actual,
    // A desktop build: the deployment's own venue is local. The hidden
    // composition must not use it.
    activePluginsRuntimeVenue: () => "local",
    useActivePlugins: (
      projectId: string | null | undefined,
      options?: { runtimeVenue?: string },
    ) => {
      state.activePluginsProjectIds.push(projectId);
      state.activePluginsVenues.push(options?.runtimeVenue);
      const answered = projectId && !state.activeLoading && !state.activeFailed;
      const plugins = answered ? state.plugins : [];
      return {
        plugins,
        activePlugins: plugins.filter((plugin) => plugin.status === "active"),
        activeServers: actual.activePluginServers(plugins),
        isLoading: !!projectId && state.activeLoading,
        failed: !!projectId && state.activeFailed,
        answered: !!answered,
      };
    },
  };
});
vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  get HOSTED_MODE() {
    return state.hostedMode;
  },
}));
vi.mock("@/hooks/useLocalHarnessTarget", () => ({
  useLocalHarnessRunsHere: () => state.clientRunsHere,
}));
vi.mock("@/hooks/useProjectEnvironments", () => ({
  useEnsureAdhocEnvironment: () => state.ensure,
}));
vi.mock("@/hooks/use-is-member-actor", () => ({
  useIsMemberActor: () => state.isMember,
}));
vi.mock("@/hooks/usePluginsEnabled", () => ({
  usePluginsEnabled: () => state.pluginsEnabled,
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
vi.mock("@/hooks/usePluginServerSignIn", () => ({
  usePluginServerSignIn: (projectId: string | null) => {
    state.signInProjectIds.push(projectId);
    return {
      available: state.signInAvailable && !!projectId,
      pendingKey: null,
      signIn: state.signIn,
    };
  },
}));
vi.mock("@/lib/toast", () => ({ toast: { info: state.toastInfo } }));

import {
  HIDDEN_ENVIRONMENT_WAIT_MS,
  usePlaygroundHiddenEnvironment,
} from "../use-playground-hidden-environment";
import {
  resetShownPluginNotices,
  showPluginNotice,
} from "@/lib/plugins/plugin-notice-display";
import { usePluginServerNoticeStore } from "@/stores/plugin-server-notice-store";
import {
  hasOnboardingAfterSignIn,
  markOnboardingSignInCompleted,
  requestOnboardingAfterSignIn,
  usePluginOnboardingIntentStore,
} from "@/lib/plugin-onboarding-intent";

const PROJECT_ID = "j57abcdefghijklmnopqrstuvwxyz012";

const PROPS_FOR_PENDING = {
  projectId: PROJECT_ID,
  eligible: true,
  hostId: "host_1",
  harnessId: null,
  hostResolved: true,
};

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

describe("a Set up kept across a sign-in", () => {
  const binding = { pluginVersionId: "ver_bits", componentKey: "server:api" };
  const bits = (unavailable?: "needs_auth") =>
    plugin("bits", {
      servers: [
        {
          serverId: "srv_bits",
          name: "bits-server",
          componentKey: "server:api",
          placement: "remote",
          ...(unavailable ? { unavailable } : {}),
        },
      ],
    });
  const outside = { ...PROPS_FOR_PENDING, eligible: false };
  beforeEach(() => {
    sessionStorage.clear();
    usePluginOnboardingIntentStore.getState().clear();
    state.isMember = true;
    state.activeLoading = false;
    state.activeFailed = false;
    state.activePluginsProjectIds = [];
    state.ensure.mockReset();
    state.ensure.mockResolvedValue({
      environment: { environmentId: "env_1" },
      created: true,
    });
    requestOnboardingAfterSignIn(
      {
        projectId: PROJECT_ID,
        serverIds: ["srv_bits"],
        pluginId: "plg_bits",
        pluginName: "Bits",
        conversation: "new",
      },
      binding,
    );
  });

  it("is made by the first read that answers with its server signed in, even outside a hidden chat", () => {
    markOnboardingSignInCompleted(binding);
    state.activeLoading = true;
    state.plugins = [bits()];
    const { rerender } = render(outside);
    expect(state.activePluginsProjectIds).toContain(PROJECT_ID);
    expect(usePluginOnboardingIntentStore.getState().intent).toBeNull();

    state.activeLoading = false;
    rerender(outside);
    expect(usePluginOnboardingIntentStore.getState().intent).toMatchObject({
      pluginId: "plg_bits",
      conversation: "new",
    });
    // Settled, so that chat stops reading plugins for it.
    expect(state.activePluginsProjectIds.at(-1)).toBeNull();
  });

  it("is dropped by that read when the sign-in did not finish, so a later one starts nothing", () => {
    state.plugins = [bits("needs_auth")];
    const { rerender } = render();
    expect(hasOnboardingAfterSignIn(PROJECT_ID)).toBe(false);

    state.plugins = [bits()];
    rerender(PROPS_FOR_PENDING);
    expect(usePluginOnboardingIntentStore.getState().intent).toBeNull();
  });

  it("reads no plugins for a chat outside the hidden environment otherwise", () => {
    sessionStorage.clear();
    render(outside);
    expect(state.activePluginsProjectIds.every((id) => id === null)).toBe(true);
  });
});

describe("the chat notice's Sign in", () => {
  beforeEach(() => {
    state.plugins = [];
    state.isMember = true;
    state.activeLoading = false;
    state.activeFailed = false;
    state.signInAvailable = true;
    state.signIn.mockReset();
    state.signInProjectIds = [];
    state.toastInfo.mockReset();
    state.ensure.mockReset();
    state.ensure.mockResolvedValue({
      environment: { environmentId: "env_1" },
      created: true,
    });
    resetShownPluginNotices();
  });

  it("is on a notice a remount replays, and leaves with the Playground", () => {
    state.plugins = [
      plugin("bits", {
        servers: [
          {
            serverId: "srv_bits",
            name: "bits-server",
            componentKey: "server:api",
            placement: "remote",
            unavailable: "needs_auth",
          },
        ],
      }),
    ];
    // Reported while the Playground was away.
    usePluginServerNoticeStore
      .getState()
      .report("chat-away", [{ serverId: "srv_bits", reason: "needs_auth" }]);
    const { unmount } = render();
    const action = state.toastInfo.mock.calls.at(-1)?.[1]?.action;
    expect(action?.label).toBe("Sign in");
    action.onClick();
    expect(state.signIn).toHaveBeenCalledWith({
      pluginVersionId: "ver_bits",
      componentKey: "server:api",
    });
    unmount();
    showPluginNotice("chat-after", {
      kind: "skipped",
      plugins: [
        {
          pluginId: "plg_bits",
          name: "bits",
          displayName: "BITS",
          reason: "needs_auth",
          partial: true,
          signIn: { pluginVersionId: "ver_bits", componentKey: "server:api" },
        },
      ],
    });
    expect(state.toastInfo.mock.calls.at(-1)).toHaveLength(1);
  });

  it("is not offered to someone who is not a member", () => {
    state.isMember = false;
    render();
    expect(state.signInProjectIds.every((id) => id === null)).toBe(true);
  });
});

describe("usePlaygroundHiddenEnvironment", () => {
  beforeEach(() => {
    state.plugins = [];
    state.activePluginsProjectIds = [];
    state.activePluginsVenues = [];
    state.activeLoading = false;
    state.activeFailed = false;
    state.hostedMode = false;
    state.clientRunsHere = false;
    state.pluginsEnabled = true;
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

  it("keeps plugins on an older backend that rejects the chat-purpose argument", async () => {
    state.plugins = [plugin("bits")];
    state.ensure.mockRejectedValueOnce(
      new Error(
        "ArgumentValidationError: Object contains extra field `purpose` that is not in the validator.",
      ),
    );
    const { result } = render();
    await waitFor(() => expect(result.current.environmentId).not.toBeNull());
    expect(state.ensure).toHaveBeenCalledTimes(2);
    expect(state.ensure.mock.calls[0][0].purpose).toBe("chat");
    expect(state.ensure.mock.calls[1][0]).not.toHaveProperty("purpose");
    expect(result.current.failed).toBe(false);
  });

  it("keeps a row-cap refusal distinct from plugin fallback", async () => {
    state.plugins = [plugin("bits")];
    state.ensure.mockRejectedValueOnce({
      data: {
        code: "ENV_ADHOC_LIMIT",
        message: "The setup limit was reached.",
      },
    });
    const { result } = render();
    await waitFor(() =>
      expect(result.current.blockingError).toBe("The setup limit was reached."),
    );
    expect(result.current.wanted).toBe(false);
    expect(result.current.environmentId).toBeNull();
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
      purpose: "chat",
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

  describe("the venue", () => {
    const localPlugin = () =>
      plugin("local", {
        servers: [
          {
            serverId: "srv_local",
            name: "local-server",
            componentKey: "server",
            placement: "local",
          },
        ],
      });

    it("reads the plugins for the hosted venue even where this build is local", () => {
      state.plugins = [plugin("bits")];
      render();
      expect(state.activePluginsVenues.at(-1)).toBe("hosted");
    });

    it("runs a local component for a client the member runs here", async () => {
      state.clientRunsHere = true;
      state.plugins = [localPlugin(), plugin("bits")];
      const { result } = render();
      await waitFor(() => expect(result.current.environmentId).toBe("env_1"));
      expect(state.activePluginsVenues.at(-1)).toBe("local");
      expect(result.current.venue).toBe("local");
      expect(state.ensure.mock.calls[0][0].pluginVersionIds).toEqual([
        "ver_local",
        "ver_bits",
      ]);
      expect(result.current.pluginServerIds).toEqual(["srv_local", "srv_bits"]);
    });

    it("keeps a plugin whose local server waits on setup, running its remote one", async () => {
      state.clientRunsHere = true;
      state.plugins = [
        plugin("waiting", {
          servers: [
            {
              serverId: "srv_w",
              name: "w",
              componentKey: "w",
              placement: "local",
              unavailable: "needs_setup",
            },
            {
              serverId: "srv_wr",
              name: "wr",
              componentKey: "wr",
              placement: "remote",
            },
          ],
        }),
        plugin("bits"),
      ];
      const { result } = render();
      await waitFor(() => expect(result.current.environmentId).toBe("env_1"));
      expect(result.current.venue).toBe("local");
      expect(state.ensure.mock.calls[0][0].pluginVersionIds).toEqual([
        "ver_waiting",
        "ver_bits",
      ]);
      expect(result.current.pluginServerIds).toEqual(["srv_wr", "srv_bits"]);
    });

    it("stays hosted for that client when no plugin needs this machine", async () => {
      state.clientRunsHere = true;
      state.plugins = [plugin("bits")];
      const { result } = render();
      await waitFor(() => expect(result.current.environmentId).toBe("env_1"));
      expect(result.current.venue).toBe("hosted");
    });

    it("never runs here from the hosted app", async () => {
      state.hostedMode = true;
      state.clientRunsHere = true;
      state.plugins = [localPlugin(), plugin("bits")];
      const { result } = render();
      await waitFor(() => expect(result.current.environmentId).toBe("env_1"));
      expect(state.activePluginsVenues.at(-1)).toBe("hosted");
      expect(result.current.venue).toBe("hosted");
      expect(state.ensure.mock.calls[0][0].pluginVersionIds).toEqual([
        "ver_bits",
      ]);
    });

    it("recovers for the venue it composed for", async () => {
      state.clientRunsHere = true;
      state.plugins = [localPlugin()];
      const { result } = render();
      await waitFor(() => expect(result.current.environmentId).toBe("env_1"));
      state.query.mockResolvedValue({
        enabled: true,
        plugins: [localPlugin()],
      });

      await act(async () => {
        await result.current.recover();
      });

      expect(state.query).toHaveBeenCalledWith(
        "plugins:resolveActivePlugins",
        expect.objectContaining({ runtimeVenue: "local" }),
      );
      expect(state.ensure.mock.calls[1][0].pluginVersionIds).toEqual([
        "ver_local",
      ]);
    });

    it("recovers a hosted composition into a plugin that now runs here", async () => {
      state.clientRunsHere = true;
      state.plugins = [plugin("bits")];
      const { result } = render();
      await waitFor(() => expect(result.current.environmentId).toBe("env_1"));
      expect(result.current.venue).toBe("hosted");
      // Only a read for this client admits the new version's local component.
      state.query.mockImplementation(
        async (_name: string, args: { runtimeVenue?: string }) => ({
          enabled: true,
          plugins:
            args.runtimeVenue === "local"
              ? [plugin("bits"), localPlugin()]
              : [plugin("bits")],
        }),
      );

      let recovery: unknown;
      await act(async () => {
        recovery = await result.current.recover();
      });

      expect(recovery).toMatchObject({ ok: true, environmentId: "env_2" });
      expect(state.ensure.mock.calls[1][0].pluginVersionIds).toEqual([
        "ver_bits",
        "ver_local",
      ]);
    });

    it("pins a remote plugin and skips a local one, which the chat names", async () => {
      // What the hosted-venue read answers for a plugin with a stdio
      // component: skipped as `placement`, never active.
      state.plugins = [
        plugin("local", {
          status: "skipped",
          reason: "placement",
          componentKey: "server",
          servers: [
            {
              serverId: "srv_local",
              name: "local-server",
              componentKey: "server",
              placement: "local",
            },
          ],
        }),
        plugin("bits"),
      ];
      const { result } = render();
      await waitFor(() => expect(result.current.environmentId).toBe("env_1"));
      expect(state.ensure).toHaveBeenCalledTimes(1);
      expect(state.ensure.mock.calls[0][0].pluginVersionIds).toEqual([
        "ver_bits",
      ]);
      expect(result.current.pluginServerIds).toEqual(["srv_bits"]);
      // Still listed, so the chat can say why it was skipped.
      expect(
        result.current.plugins.find((row) => row.pluginId === "plg_local"),
      ).toMatchObject({ status: "skipped", reason: "placement" });
    });

    it("never pins a local component, even if a read called it active", async () => {
      state.plugins = [
        plugin("local", {
          servers: [
            {
              serverId: "srv_local",
              name: "local-server",
              componentKey: "server",
              placement: "local",
            },
          ],
        }),
      ];
      const { result } = render();
      expect(result.current.wanted).toBe(false);
      await Promise.resolve();
      expect(state.ensure).not.toHaveBeenCalled();
    });
  });

  describe("before the plugin read has answered", () => {
    it("holds sends on a cold load until it answers, then composes", async () => {
      state.isMember = undefined;
      state.plugins = [plugin("bits")];
      const { result, rerender } = render();
      // Wanted with nothing composed: the chat hook holds the send.
      expect(result.current.wanted).toBe(true);
      expect(result.current.environmentId).toBeNull();
      expect(result.current.failed).toBe(false);

      state.isMember = true;
      state.activeLoading = true;
      rerender(PROPS_FOR_PENDING);
      expect(result.current.wanted).toBe(true);
      expect(result.current.environmentId).toBeNull();
      await Promise.resolve();
      expect(state.ensure).not.toHaveBeenCalled();

      state.activeLoading = false;
      rerender(PROPS_FOR_PENDING);
      await waitFor(() => expect(result.current.environmentId).toBe("env_1"));
    });

    it("lets sends go once the read answers that there are no plugins", () => {
      state.activeLoading = true;
      const { result, rerender } = render();
      expect(result.current.wanted).toBe(true);
      state.activeLoading = false;
      rerender(PROPS_FOR_PENDING);
      expect(result.current.wanted).toBe(false);
      expect(result.current.failed).toBe(false);
    });

    it("does not wait without the plugins flag", () => {
      state.pluginsEnabled = false;
      state.isMember = undefined;
      expect(render().result.current.wanted).toBe(false);
    });

    it("stops waiting after the bound and says the plugins couldn't load", () => {
      vi.useFakeTimers();
      try {
        state.activeLoading = true;
        const { result, rerender } = render();
        expect(result.current.wanted).toBe(true);
        act(() => {
          vi.advanceTimersByTime(HIDDEN_ENVIRONMENT_WAIT_MS);
        });
        expect(result.current.wanted).toBe(false);
        expect(result.current.failed).toBe(true);

        // A late answer still counts.
        state.activeLoading = false;
        state.plugins = [plugin("bits")];
        rerender(PROPS_FOR_PENDING);
        expect(result.current.wanted).toBe(true);
        expect(result.current.failed).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("runs as a client turn, saying so, when the read fails", () => {
      state.activeFailed = true;
      const { result } = render();
      expect(result.current.wanted).toBe(false);
      expect(result.current.failed).toBe(true);
    });
  });

  describe("a server joining or leaving under the same composition", () => {
    const twoServers = (unavailable?: "needs_auth") =>
      plugin("bits", {
        servers: [
          {
            serverId: "srv_bits",
            name: "bits-server",
            componentKey: "server",
            placement: "remote",
          },
          {
            serverId: "srv_crm",
            name: "crm-server",
            componentKey: "crm",
            placement: "remote",
            ...(unavailable ? { unavailable } : {}),
          },
        ],
      });

    it("names a server once the member signs in, without recomposing", async () => {
      state.plugins = [twoServers("needs_auth")];
      const { result, rerender } = render();
      await waitFor(() => expect(result.current.environmentId).toBe("env_1"));
      expect(result.current.pluginServerIds).toEqual(["srv_bits"]);

      state.plugins = [twoServers()];
      rerender(PROPS_FOR_PENDING);
      expect(result.current.pluginServerIds).toEqual(["srv_bits", "srv_crm"]);
      expect(result.current.environmentId).toBe("env_1");
      expect(state.ensure).toHaveBeenCalledTimes(1);
    });

    it("stops naming a server the member can no longer use", async () => {
      state.plugins = [twoServers()];
      const { result, rerender } = render();
      await waitFor(() => expect(result.current.environmentId).toBe("env_1"));

      state.plugins = [twoServers("needs_auth")];
      rerender(PROPS_FOR_PENDING);
      expect(result.current.pluginServerIds).toEqual(["srv_bits"]);
      expect(state.ensure).toHaveBeenCalledTimes(1);
    });
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
        componentAdmission: true,
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

    it.each([
      [
        "development",
        "ArgumentValidationError: Object contains extra field `componentAdmission` that is not in the validator.",
      ],
      [
        "production",
        "[CONVEX Q(plugins:resolveActivePlugins)] [Request ID: 6f2c3a9b1d4e5f60] Server Error\n  Called by client",
      ],
    ])(
      "asks a backend from before component admission the old way (%s)",
      async (_deployment, message) => {
        state.plugins = [plugin("bits")];
        const { result } = render();
        await waitFor(() => expect(result.current.environmentId).toBe("env_1"));
        state.query
          .mockRejectedValueOnce(new Error(message))
          .mockResolvedValueOnce({ enabled: true, plugins: [plugin("cad")] });

        let recovery: unknown;
        await act(async () => {
          recovery = await result.current.recover();
        });

        expect(state.query).toHaveBeenLastCalledWith(
          "plugins:resolveActivePlugins",
          { projectId: PROJECT_ID, content: false, runtimeVenue: "hosted" },
        );
        expect(recovery).toMatchObject({ ok: true, environmentId: "env_2" });
      },
    );

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
