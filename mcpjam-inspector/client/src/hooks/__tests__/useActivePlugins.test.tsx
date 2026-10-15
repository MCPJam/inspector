import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivePluginsResult } from "@/lib/plugins/active-plugins-types";

const state = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; args: unknown }>,
  next: undefined as unknown,
  flag: true as boolean | undefined,
  isAuthenticated: true,
  hostedMode: false,
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({
    isAuthenticated: state.isAuthenticated,
    isLoading: false,
  }),
  // `useSoftQuery` reads through `useQueries`, which hands an error back
  // rather than throwing it.
  useQueries: (queries: Record<string, { query: unknown; args: unknown }>) =>
    Object.fromEntries(
      Object.entries(queries).map(([key, { args }]) => {
        state.calls.push({ name: "plugins:resolveActivePlugins", args });
        return [
          key,
          typeof state.next === "function" ? state.next(args) : state.next,
        ];
      }),
    ),
}));

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => state.flag,
}));

vi.mock("@/lib/config", () => ({
  get HOSTED_MODE() {
    return state.hostedMode;
  },
}));

import { useActivePlugins } from "../useActivePlugins";

const PROJECT_ID = "j57abcdefghijklmnopqrstuvwxyz012";

function result(plugins: ActivePluginsResult["plugins"]): ActivePluginsResult {
  return {
    enabled: true,
    pluginVersions: [],
    servers: {
      selectedServerIds: [],
      pluginServerIds: [],
      baseEffectiveServerIds: [],
      effectiveServerIds: [],
      connectable: [],
    },
    skills: [],
    serverSkills: [],
    attribution: {
      pluginVersions: [],
      effectiveServerIds: [],
      serverComponents: [],
      pluginSkills: [],
      unavailableComponents: [],
    },
    plugins,
  };
}

const bits = {
  pluginId: "plg_bits",
  pluginVersionId: "ver_bits",
  name: "bits-and-bolts",
  displayName: "Bits & Bolts",
  status: "active" as const,
  servers: [
    {
      serverId: "srv_bits",
      name: "bits-cad",
      componentKey: "cad",
      placement: "remote" as const,
    },
  ],
  skills: [],
};

const skipped = {
  pluginId: "plg_mail",
  pluginVersionId: "ver_mail",
  name: "mail",
  displayName: null,
  status: "skipped" as const,
  reason: "needs_auth",
  componentKey: "inbox",
  servers: [
    {
      serverId: "srv_mail",
      name: "mail",
      componentKey: "inbox",
      placement: "remote" as const,
    },
  ],
  skills: [],
};

describe("useActivePlugins", () => {
  beforeEach(() => {
    state.calls = [];
    state.next = undefined;
    state.flag = true;
    state.isAuthenticated = true;
    state.hostedMode = false;
  });

  it("does not ask while the plugins flag is off", () => {
    state.flag = false;
    const { result: hook } = renderHook(() => useActivePlugins(PROJECT_ID));
    expect(state.calls).toEqual([]);
    expect(hook.current.plugins).toEqual([]);
    expect(hook.current.isLoading).toBe(false);
  });

  it("does not ask while the flag is still loading", () => {
    state.flag = undefined;
    renderHook(() => useActivePlugins(PROJECT_ID));
    expect(state.calls).toEqual([]);
  });

  it("does not ask without a Convex project or before auth resolves", () => {
    renderHook(() => useActivePlugins(null));
    renderHook(() => useActivePlugins("local_project"));
    state.isAuthenticated = false;
    renderHook(() => useActivePlugins(PROJECT_ID));
    expect(state.calls).toEqual([]);
  });

  it("asks without content, for the venue the chat route uses", () => {
    renderHook(() => useActivePlugins(PROJECT_ID));
    expect(state.calls.at(-1)?.args).toEqual({
      projectId: PROJECT_ID,
      content: false,
      runtimeVenue: "local",
      componentAdmission: true,
    });

    state.hostedMode = true;
    renderHook(() => useActivePlugins(PROJECT_ID));
    expect(state.calls.at(-1)?.args).toEqual({
      projectId: PROJECT_ID,
      content: false,
      runtimeVenue: "hosted",
      componentAdmission: true,
    });
  });

  it("asks for the venue a caller names instead, in any build", () => {
    renderHook(() => useActivePlugins(PROJECT_ID, { runtimeVenue: "hosted" }));
    expect(state.calls.at(-1)?.args).toEqual({
      projectId: PROJECT_ID,
      content: false,
      runtimeVenue: "hosted",
      componentAdmission: true,
    });
  });

  it("is loading until the answer arrives", () => {
    const { result: hook } = renderHook(() => useActivePlugins(PROJECT_ID));
    expect(hook.current.isLoading).toBe(true);
    expect(hook.current.failed).toBe(false);
  });

  it("splits active plugins from skipped ones and lists only active servers", () => {
    state.next = result([bits, skipped]);
    const { result: hook } = renderHook(() => useActivePlugins(PROJECT_ID));
    expect(hook.current.plugins.map((p) => p.pluginId)).toEqual([
      "plg_bits",
      "plg_mail",
    ]);
    expect(hook.current.activePlugins.map((p) => p.pluginId)).toEqual([
      "plg_bits",
    ]);
    expect(hook.current.activeServers).toEqual([
      {
        serverId: "srv_bits",
        name: "bits-cad",
        pluginId: "plg_bits",
        pluginLabel: "Bits & Bolts",
      },
    ]);
    expect(hook.current.isLoading).toBe(false);
  });

  it("leaves out a server the member can't use yet", () => {
    state.next = result([
      {
        ...bits,
        servers: [
          ...bits.servers,
          {
            serverId: "srv_crm",
            name: "bits-crm",
            componentKey: "crm",
            placement: "remote",
            unavailable: "needs_auth",
          },
        ],
      },
    ]);
    const { result: hook } = renderHook(() => useActivePlugins(PROJECT_ID));
    expect(hook.current.activeServers.map((s) => s.serverId)).toEqual([
      "srv_bits",
    ]);
  });

  // What the browser client throws: the deployment's message between its
  // `[CONVEX Q(…)]` prefix and "Called by client" line.
  const thrown = (body: string) =>
    new Error(
      `[CONVEX Q(plugins:resolveActivePlugins)] [Request ID: 6f2c3a9b1d4e5f60] ${body}\n  Called by client`,
    );

  it.each([
    [
      "development",
      thrown(
        "Server Error\nArgumentValidationError: Object contains extra field `componentAdmission` that is not in the validator.",
      ),
    ],
    ["production", thrown("Server Error")],
  ])(
    "asks a backend from before component admission the old way, without failing (%s)",
    (_deployment, refusal) => {
      state.next = (args: { componentAdmission?: boolean }) =>
        args.componentAdmission ? refusal : result([bits]);
      const { result: hook } = renderHook(() => useActivePlugins(PROJECT_ID));
      expect(state.calls.at(-1)?.args).not.toHaveProperty("componentAdmission");
      expect(hook.current.failed).toBe(false);
      expect(hook.current.activePlugins.map((p) => p.pluginId)).toEqual([
        "plg_bits",
      ]);
    },
  );

  it.each([
    [
      "another error naming the field",
      thrown("Server Error\nUncaught Error: componentAdmission needs a venue"),
    ],
    [
      "a ConvexError",
      Object.assign(thrown("Server Error"), { data: { code: "FORBIDDEN" } }),
    ],
  ])("fails without asking again on %s", (_case, error) => {
    state.next = error;
    const { result: hook } = renderHook(() => useActivePlugins(PROJECT_ID));
    expect(state.calls.at(-1)?.args).toHaveProperty("componentAdmission", true);
    expect(hook.current.failed).toBe(true);
  });

  it("reads a gate denial as no plugins", () => {
    state.next = { ...result([bits]), enabled: false };
    const { result: hook } = renderHook(() => useActivePlugins(PROJECT_ID));
    expect(hook.current.plugins).toEqual([]);
    expect(hook.current.activeServers).toEqual([]);
  });

  it("reads a backend without the function as no plugins instead of throwing", () => {
    state.next = new Error(
      "[CONVEX Q(plugins:resolveActivePlugins)] Could not find public function for 'plugins:resolveActivePlugins'",
    );
    const { result: hook } = renderHook(() => useActivePlugins(PROJECT_ID));
    expect(hook.current.plugins).toEqual([]);
    expect(hook.current.activeServers).toEqual([]);
    expect(hook.current.isLoading).toBe(false);
    // Distinguishable from "no plugins" for a caller that must not guess.
    expect(hook.current.failed).toBe(true);
  });
});
