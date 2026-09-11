vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: { id: "member" } }),
}));
/**
 * `useBrowserTools` — which host the Tools panel's Browser section believes it
 * is describing, and when it asks the server anything at all.
 *
 * The bug this pins: the hook keyed on the EXPLICITLY previewed host, while the
 * Browser pane in the right rail resolves explicit-pick-else-project-default
 * like the rest of the app. On a project whose DEFAULT host carries the browser
 * and nothing was explicitly picked, the pane offered a live browser while the
 * panel beside it said no server was connected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const state = vi.hoisted(() => ({
  setting: undefined as { enabled: boolean | null } | undefined,
  explicitHost: null as {
    config?: { builtInToolIds?: string[]; localBrowserEnabled?: boolean };
  } | null,
  projectDefault: null as {
    builtInToolIds?: string[];
    localBrowserEnabled?: boolean;
  } | null,
  selectedEngine: "cloud" as "cloud" | "local",
  consentToken: null as string | null,
  definitions: [{ name: "browser_navigate", description: "Open a URL." }],
  definitionCalls: [] as string[],
  pageCalls: [] as string[],
  pageTabIds: [] as Array<string | undefined>,
  pageSessionIds: [] as Array<string | undefined>,
  pageHolders: [] as Array<string | undefined>,
  projectDefaultQueryArgs: [] as unknown[],
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  // Records what the hook ASKS FOR, not just what it gets back. The
  // project-default query is the one place this hook hands a caller-supplied
  // project scope to a `v.id("projects")` validator, and "skip" vs. an
  // argument object is the whole difference between a quiet render and a
  // server-side throw.
  useQuery: (_name: unknown, args: unknown) => {
    if (_name === "hosts:getLocalBrowserSettings")
      return (
        state.setting ?? {
          enabled:
            state.explicitHost?.config?.localBrowserEnabled ??
            state.projectDefault?.localBrowserEnabled ??
            null,
        }
      );
    state.projectDefaultQueryArgs.push(args);
    return state.projectDefault ?? undefined;
  },
  useAction: () => vi.fn(),
}));

vi.mock("@/hooks/useClients", () => ({
  useHost: () => ({ host: state.explicitHost, isLoading: false }),
}));

vi.mock("@/hooks/useBrowserEngine", () => ({
  useBrowserEngine: () => ({
    localAvailable: true,
    engine: state.selectedEngine,
    selectedEngine: state.selectedEngine,
    consent: { token: state.consentToken, granted: !!state.consentToken },
  }),
}));

vi.mock("@/hooks/useProjectComputer", () => ({
  useMintBrowserToken: () =>
    vi.fn(async () => ({
      token: "tok",
      expiresAt: Date.now() + 60_000,
    })),
  useMintConversationBrowserToken: () =>
    vi.fn(async () => ({
      token: "tok-conversation",
      expiresAt: Date.now() + 60_000,
    })),
}));

vi.mock("@/lib/hosted-browser/client", () => ({
  createBrowserTokenCache: () => ({
    get: async () => "tok",
    invalidate: vi.fn(),
    invalidateIf: vi.fn(),
  }),
}));

vi.mock("@/lib/browser-page-tools/client", () => ({
  fetchBrowserToolDefinitions: vi.fn(async (engine: string) => {
    state.definitionCalls.push(engine);
    return state.definitions;
  }),
  fetchHostedPageTools: vi.fn(
    async (_tokens: unknown, _signal: unknown, tabId?: string) => {
      state.pageCalls.push("hosted");
      state.pageTabIds.push(tabId);
      return {
        ok: true,
        url: "https://webmcp.dev/",
        webmcpSupported: true,
        tools: [],
      };
    },
  ),
  fetchLocalPageTools: vi.fn(
    async (args: { tabId?: string; sessionId?: string; holder?: string }) => {
      state.pageCalls.push("local");
      state.pageTabIds.push(args?.tabId);
      state.pageSessionIds.push(args?.sessionId);
      state.pageHolders.push(args?.holder);
      return {
        ok: true,
        url: "http://localhost/",
        webmcpSupported: false,
        tools: [],
      };
    },
  ),
  fetchHostedPageToolInvoke: vi.fn(async () => ({
    ok: true,
    output: {},
  })),
  fetchLocalPageToolInvoke: vi.fn(async () => ({
    ok: true,
    output: {},
  })),
}));

import { useBrowserTools } from "../useBrowserTools";
import { useActiveChatSessionStore } from "@/stores/active-chat-session-store";
import {
  browserPageToolsKey,
  noteWebmcpStats,
  useBrowserPageToolsStore,
} from "@/stores/browser-page-tools-store";

const WITH_BROWSER = { builtInToolIds: ["browser", "bash"] };
const WITHOUT_BROWSER = { builtInToolIds: ["bash"] };

beforeEach(() => {
  state.explicitHost = null;
  state.projectDefault = null;
  state.selectedEngine = "cloud";
  state.consentToken = null;
  state.definitionCalls = [];
  state.setting = undefined;
  state.pageCalls = [];
  state.pageTabIds = [];
  state.pageSessionIds = [];
  state.pageHolders = [];
  state.projectDefaultQueryArgs = [];
  sessionStorage.clear();
  useBrowserPageToolsStore.setState({ live: {}, epoch: {} });
  useActiveChatSessionStore.setState({
    sessionId: null,
    browserLocation: null,
    browserSessionId: null,
  });
});

afterEach(() => vi.clearAllMocks());

describe("useBrowserTools — which host it describes", () => {
  it("lists Browser after shared local setup without requiring a legacy tool attachment", async () => {
    state.selectedEngine = "local";
    state.consentToken = "saved-device-consent";
    state.projectDefault = { ...WITHOUT_BROWSER, localBrowserEnabled: true };
    const { result } = renderHook(() =>
      useBrowserTools({ projectId: "proj_1", hostId: null }),
    );
    await waitFor(() => expect(result.current.tools).toHaveLength(1));
    expect(result.current.attached).toBe(true);
    expect(state.definitionCalls).toEqual(["local"]);
  });

  it("stops exposing tools when this client's local override is disabled", async () => {
    state.selectedEngine = "local";
    state.consentToken = "saved-device-consent";
    state.explicitHost = {
      config: { ...WITH_BROWSER, localBrowserEnabled: false },
    };
    const { result } = renderHook(() =>
      useBrowserTools({ projectId: "proj_1", hostId: "host_1" }),
    );
    expect(result.current.attached).toBe(false);
    expect(state.definitionCalls).toEqual([]);
    expect(state.pageCalls).toEqual([]);
  });

  it("falls back to the PROJECT DEFAULT when no host is explicitly previewed", async () => {
    // The reported bug, exactly: the Browser pane was live and the Tools panel
    // was empty, because only the pane looked at the default host.
    state.projectDefault = WITH_BROWSER;
    const { result } = renderHook(() =>
      useBrowserTools({ projectId: "proj_1", hostId: null }),
    );
    await waitFor(() => expect(result.current.tools).toHaveLength(1));
    expect(result.current.attached).toBe(true);
  });

  it("prefers an explicitly previewed host over the project default", async () => {
    // Picking a host without the browser must HIDE the section, even on a
    // project whose default has one — otherwise the panel describes tools this
    // turn will not be given.
    state.explicitHost = { config: WITHOUT_BROWSER };
    state.projectDefault = WITH_BROWSER;
    const { result } = renderHook(() =>
      useBrowserTools({ projectId: "proj_1", hostId: "host_1" }),
    );
    await waitFor(() => expect(result.current.attached).toBe(false));
    expect(result.current.tools).toEqual([]);
    expect(state.definitionCalls).toEqual([]);
  });

  it("describes the browser when the explicit host carries it", async () => {
    state.explicitHost = { config: WITH_BROWSER };
    state.projectDefault = WITHOUT_BROWSER;
    const { result } = renderHook(() =>
      useBrowserTools({ projectId: "proj_1", hostId: "host_1" }),
    );
    await waitFor(() => expect(result.current.tools).toHaveLength(1));
  });

  it("asks for nothing when no host has a browser", async () => {
    // Not merely empty output: a panel that fetched a catalog and read a live
    // page for every project would be spending requests to render nothing.
    state.projectDefault = WITHOUT_BROWSER;
    const { result } = renderHook(() =>
      useBrowserTools({ projectId: "proj_1", hostId: null }),
    );
    await waitFor(() => expect(result.current.attached).toBe(false));
    expect(state.definitionCalls).toEqual([]);
    expect(state.pageCalls).toEqual([]);
  });
});

describe("useBrowserTools — which browser it reads", () => {
  it("reads the hosted browser under the cloud engine", async () => {
    state.projectDefault = WITH_BROWSER;
    const { result } = renderHook(() =>
      useBrowserTools({ projectId: "proj_1", hostId: null }),
    );
    await waitFor(() => expect(state.pageCalls).toEqual(["hosted"]));
    expect(result.current.engine).toBe("hosted");
    // Definitions are NOT asserted by call here: they are cached per engine for
    // the session, so by this point an earlier test has already warmed
    // `hosted`. That caching is the behaviour, not an obstacle to it — the
    // panel is remounted on every rail tab switch, and re-fetching a constant
    // each time is noise on the wire and a flicker in the list.
    expect(result.current.tools).toHaveLength(1);
  });

  it("reads this machine's browser once consent exists", async () => {
    state.projectDefault = WITH_BROWSER;
    state.selectedEngine = "local";
    state.consentToken = "consent-tok";
    const { result } = renderHook(() =>
      useBrowserTools({ projectId: "proj_1", hostId: null }),
    );
    await waitFor(() => expect(state.pageCalls).toEqual(["local"]));
    // Definitions may already be cached by an earlier local view.
    expect(result.current.tools).toHaveLength(1);
    expect(result.current.engine).toBe("local");
  });

  it("names the conversation whose browser the pane is listing", async () => {
    // Chat drives `<project>:session:<id>`. A read that omitted the id still
    // looked at the leftover project-wide Chromium, so the list stayed empty
    // while the model was already calling that page's tools.
    state.projectDefault = WITH_BROWSER;
    state.selectedEngine = "local";
    state.consentToken = "consent-tok";
    useActiveChatSessionStore.setState({ sessionId: "chat-1" });
    renderHook(() => useBrowserTools({ projectId: "proj_1", hostId: null }));
    await waitFor(() => expect(state.pageCalls).toEqual(["local"]));
    expect(state.pageSessionIds).toEqual(["chat-1"]);
    expect(state.pageHolders[0]).toMatch(/^rail-/);
  });

  it("does not read the local browser before consent is granted", async () => {
    // The Browser pane is where a person authorizes this machine. Until they
    // do there is nothing to read, and asking would 403 on every render.
    state.projectDefault = WITH_BROWSER;
    state.selectedEngine = "local";
    state.consentToken = null;
    const { result } = renderHook(() =>
      useBrowserTools({ projectId: "proj_1", hostId: null }),
    );
    await waitFor(() =>
      expect(result.current.page).toEqual({
        ok: false,
        error: "no_browser_session",
      }),
    );
    expect(state.pageCalls).toEqual([]);
  });

  it("re-reads the page on request, without re-fetching the definitions", async () => {
    // The page changes every time the agent navigates; the definitions are
    // static, and re-fetching a constant on each refresh is pure noise.
    state.projectDefault = WITH_BROWSER;
    const { result } = renderHook(() =>
      useBrowserTools({ projectId: "proj_1", hostId: null }),
    );
    await waitFor(() => expect(state.pageCalls).toEqual(["hosted"]));
    const definitionsBefore = state.definitionCalls.length;

    result.current.refreshPage();

    await waitFor(() => expect(state.pageCalls).toEqual(["hosted", "hosted"]));
    expect(state.definitionCalls).toHaveLength(definitionsBefore);
  });
});

describe("useBrowserTools — the read follows the tab the signal came from", () => {
  it("sends the beat's active tab, so the pane is not the default tab's list", async () => {
    // The heartbeat measures the ACTIVE tab. The page-tools read is a separate
    // request, and one sent with no tab observes `@session` — a literal key,
    // not "whichever tab is active". Without this the pane refreshed to the
    // DEFAULT tab's definitions and put a live badge on them, beside a view of
    // the tab the person was actually in.
    state.projectDefault = WITH_BROWSER;
    const { result } = renderHook(() =>
      useBrowserTools({ projectId: "proj_1", hostId: null }),
    );
    await waitFor(() => expect(state.pageCalls.length).toBeGreaterThan(0));
    // The opening read has no signal yet, so no tab: today's behaviour.
    expect(state.pageTabIds.at(-1)).toBeUndefined();

    const before = state.pageCalls.length;
    noteWebmcpStats(
      browserPageToolsKey("proj_1", "hosted"),
      { webmcp: { revision: 7, hash: "h7", count: 1 }, tabs: { active: "t2" } },
      "boot-1",
    );
    await waitFor(() => expect(state.pageCalls.length).toBeGreaterThan(before));
    expect(state.pageTabIds.at(-1)).toBe("t2");
    expect(result.current.attached).toBe(true);
  });
});

describe("useBrowserTools — what it sends to Convex", () => {
  /**
   * The Playground passes `sharedProjectId ?? activeProjectId`, so a guest with
   * no cloud project reaches this hook with the string sentinel "none". It is
   * truthy, so the old guard forwarded it to `hostConfigsV2:getProjectDefault`,
   * whose `v.id("projects")` validator rejects it BEFORE the handler runs —
   * unhandleable client-side, and the top Convex error in production
   * (Sentry CONVEX-HQ, 636 users).
   */
  it.each(["none", "null", "undefined", "local_abc", "project_abc", "  "])(
    "skips the project-default query for the non-Convex id %j",
    async (projectId) => {
      renderHook(() => useBrowserTools({ projectId, hostId: null }));

      await waitFor(() =>
        expect(state.projectDefaultQueryArgs.length).toBeGreaterThan(0),
      );
      expect(state.projectDefaultQueryArgs).not.toContainEqual({ projectId });
      expect(new Set(state.projectDefaultQueryArgs)).toEqual(new Set(["skip"]));
    },
  );

  it("still asks for a real Convex project id", async () => {
    renderHook(() =>
      useBrowserTools({ projectId: "v97cz533abc", hostId: null }),
    );

    await waitFor(() =>
      expect(state.projectDefaultQueryArgs).toContainEqual({
        projectId: "v97cz533abc",
      }),
    );
  });
});

it("lists tools after Allow in a project with no saved client configuration", async () => {
  state.selectedEngine = "local";
  state.consentToken = "saved-device-consent";
  state.projectDefault = null;
  state.explicitHost = null;
  state.setting = { enabled: true };
  const { result } = renderHook(() =>
    useBrowserTools({ projectId: "proj_1", hostId: null }),
  );
  await waitFor(() => expect(result.current.tools).toHaveLength(1));
  expect(result.current.attached).toBe(true);
});
