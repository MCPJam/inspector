import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { HostListItem } from "@/hooks/useClients";
import {
  usePlaygroundClientInitialization,
  type PlaygroundSelectionTarget,
} from "../use-playground-client-initialization";
import {
  loadSelectedHostIds,
  saveSelectedHostIds,
} from "@/lib/selected-host-storage";
import {
  loadPreviewedHostId,
  savePreviewedHostId,
} from "@/lib/previewed-client-storage";

const mocks = vi.hoisted(() => ({
  ensure: vi.fn(),
  role: { canManage: true, isLoading: false },
}));
vi.mock("@/hooks/useClients", () => ({
  useHostMutations: () => ({ ensureProjectClient: mocks.ensure }),
}));
vi.mock("@/hooks/useProjects", () => ({
  useCanManageProjectClients: () => mocks.role,
}));
vi.mock("@/lib/error-reporting", () => ({ reportCaught: vi.fn() }));
vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (select: (s: { themeMode: string }) => unknown) =>
    select({ themeMode: "dark" }),
}));

const MCPJAM: HostListItem = {
  hostId: "h-mcpjam",
  name: "MCPJam",
  hostConfigId: "hc-mcpjam",
  modelId: "anthropic/claude-haiku-5.5",
  serverCount: 0,
  createdAt: 1,
  updatedAt: 1,
};
const LINEUP = ["h-claude", "h-chatgpt", "h-cursor"];
const CREATED_LINEUP = {
  hostId: "h-mcpjam",
  created: false,
  comparison: { state: "complete", hostIds: LINEUP, created: true },
};

function liveTarget(projectId: string | null = "p1") {
  return {
    activeProjectIdRef: { current: projectId },
    restoringAdhocRef: { current: false },
    setPreviewedHostId: vi.fn(),
    setSelectedHostIds: vi.fn(),
  } satisfies PlaygroundSelectionTarget;
}

function renderInit(
  hostList: HostListItem[],
  live = liveTarget(),
  restoringAdhoc = false,
) {
  return renderHook(() =>
    usePlaygroundClientInitialization({
      isAuthenticated: true,
      projectId: "p1",
      hostList,
      hostListLoading: false,
      restoringAdhoc,
      live,
    }),
  );
}

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe("usePlaygroundClientInitialization", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    localStorage.clear();
    mocks.role = { canManage: true, isLoading: false };
    mocks.ensure.mockResolvedValue({
      hostId: "h-mcpjam",
      created: false,
      comparison: null,
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("repairs the default for a member and never asks for comparison", async () => {
    mocks.role = { canManage: false, isLoading: false };
    renderInit([]);
    await settle();
    renderInit([MCPJAM]);
    await settle();
    expect(mocks.ensure.mock.calls).toEqual([
      [{ projectId: "p1", themeMode: "dark" }],
    ]);
  });

  it("asks for comparison only once a client exists and the role is known", async () => {
    mocks.role = { canManage: false, isLoading: true };
    const { rerender } = renderInit([MCPJAM]);
    await settle();
    expect(mocks.ensure).not.toHaveBeenCalled();
    mocks.role = { canManage: true, isLoading: false };
    rerender();
    await settle();
    expect(mocks.ensure).toHaveBeenCalledWith({
      projectId: "p1",
      themeMode: "dark",
      initializeComparison: true,
    });
  });

  it("selects a lineup the backend just created, Claude leading", async () => {
    mocks.ensure.mockResolvedValue(CREATED_LINEUP);
    const live = liveTarget();
    renderInit([MCPJAM], live);
    await settle();
    expect(loadPreviewedHostId("p1")).toBe("h-claude");
    expect(loadSelectedHostIds("p1")).toEqual(LINEUP);
    expect(live.setPreviewedHostId).toHaveBeenCalledWith("h-claude");
    expect(live.setSelectedHostIds).toHaveBeenCalledWith(LINEUP);
  });

  it("leaves the selection alone when the lineup already existed", async () => {
    mocks.ensure.mockResolvedValue({
      ...CREATED_LINEUP,
      comparison: { ...CREATED_LINEUP.comparison, created: false },
    });
    const live = liveTarget();
    renderInit([MCPJAM], live);
    await settle();
    expect(loadSelectedHostIds("p1")).toEqual([]);
    expect(live.setSelectedHostIds).not.toHaveBeenCalled();
  });

  it("keeps a lineup the user changed while the request was out", async () => {
    let resolve!: (value: unknown) => void;
    mocks.ensure.mockReturnValue(new Promise((r) => (resolve = r)));
    const live = liveTarget();
    renderInit([MCPJAM], live);
    await settle();
    saveSelectedHostIds("p1", ["h-mine"]);
    await act(async () => resolve(CREATED_LINEUP));
    expect(loadSelectedHostIds("p1")).toEqual(["h-mine"]);
    expect(live.setSelectedHostIds).not.toHaveBeenCalled();
  });

  it("keeps a lead the user picked while the request was out", async () => {
    let resolve!: (value: unknown) => void;
    mocks.ensure.mockReturnValue(new Promise((r) => (resolve = r)));
    renderInit([MCPJAM]);
    await settle();
    savePreviewedHostId("p1", "h-other");
    await act(async () => resolve(CREATED_LINEUP));
    expect(loadPreviewedHostId("p1")).toBe("h-other");
  });

  it("saves the lineup for a project the user left, without touching the open one", async () => {
    let resolve!: (value: unknown) => void;
    mocks.ensure.mockReturnValue(new Promise((r) => (resolve = r)));
    const live = liveTarget();
    renderInit([MCPJAM], live);
    await settle();
    live.activeProjectIdRef.current = "p2";
    await act(async () => resolve(CREATED_LINEUP));
    expect(loadSelectedHostIds("p1")).toEqual(LINEUP);
    expect(live.setSelectedHostIds).not.toHaveBeenCalled();
  });

  it("does not run while an ad-hoc conversation is being restored", async () => {
    renderInit([], liveTarget(), true);
    await settle();
    expect(mocks.ensure).not.toHaveBeenCalled();
  });

  it("collapses a lineup of deleted clients onto a freshly created default", async () => {
    mocks.role = { canManage: false, isLoading: false };
    saveSelectedHostIds("p1", ["h-gone-1", "h-gone-2"]);
    mocks.ensure.mockResolvedValue({
      hostId: "h-mcpjam",
      created: true,
      comparison: null,
    });
    renderInit([]);
    await settle();
    expect(loadPreviewedHostId("p1")).toBe("h-mcpjam");
    expect(loadSelectedHostIds("p1")).toEqual(["h-mcpjam"]);
  });

  it("reports a failed comparison without touching the default", async () => {
    mocks.ensure.mockRejectedValue(new Error("network"));
    const { result } = renderInit([MCPJAM]);
    for (const ms of [0, 1_000, 4_000, 10_000]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    }
    expect(result.current.comparisonInit.state).toMatchObject({
      status: "failed",
      refused: false,
    });
    expect(result.current.defaultInit.state.status).toBe("idle");
  });
});
