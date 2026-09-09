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
  explicitHost: null as { config?: { builtInToolIds?: string[] } } | null,
  projectDefault: null as { builtInToolIds?: string[] } | null,
  selectedEngine: "cloud" as "cloud" | "local",
  consentToken: null as string | null,
  definitions: [{ name: "browser_navigate", description: "Open a URL." }],
  definitionCalls: [] as string[],
  pageCalls: [] as string[],
  pageTabIds: [] as Array<string | undefined>,
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  useQuery: () => state.projectDefault ?? undefined,
  useAction: () => vi.fn(),
}));

vi.mock("@/hooks/useClients", () => ({
  useHost: () => ({ host: state.explicitHost, isLoading: false }),
}));

vi.mock("@/hooks/useComputerEngine", () => ({
  useComputerEngine: () => ({
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
  fetchHostedPageTools: vi.fn(async (_tokens: unknown, _signal: unknown, tabId?: string) => {
    state.pageCalls.push("hosted");
    state.pageTabIds.push(tabId);
    return {
      ok: true,
      url: "https://webmcp.dev/",
      webmcpSupported: true,
      tools: [],
    };
  }),
  fetchLocalPageTools: vi.fn(async (args: { tabId?: string }) => {
    state.pageCalls.push("local");
    state.pageTabIds.push(args?.tabId);
    return {
      ok: true,
      url: "http://localhost/",
      webmcpSupported: false,
      tools: [],
    };
  }),
}));

import { useBrowserTools } from "../useBrowserTools";
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
  state.pageCalls = [];
  state.pageTabIds = [];
  useBrowserPageToolsStore.setState({ live: {}, epoch: {} });
});

afterEach(() => vi.clearAllMocks());

describe("useBrowserTools — which host it describes", () => {
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
    // The definitions differ per engine — they say whose browser this is.
    expect(state.definitionCalls).toEqual(["local"]);
    expect(result.current.engine).toBe("local");
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
    await waitFor(() =>
      expect(state.pageCalls.length).toBeGreaterThan(before),
    );
    expect(state.pageTabIds.at(-1)).toBe("t2");
    expect(result.current.attached).toBe(true);
  });
});
