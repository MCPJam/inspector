import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { ConvexError } from "convex/values";
import type { HostListItem } from "@/hooks/useClients";
import {
  usePlaygroundClientInitialization,
  type PlaygroundSelectionTarget,
} from "../use-playground-client-initialization";
import { playgroundClientInitNotice } from "../playground-client-init-notice";
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
  report: vi.fn(),
  role: { canManage: true, isLoading: false },
}));
vi.mock("@/hooks/useClients", () => ({
  useHostMutations: () => ({ ensureProjectClient: mocks.ensure }),
}));
vi.mock("@/hooks/useProjects", () => ({
  useCanManageProjectClients: () => mocks.role,
}));
vi.mock("@/lib/error-reporting", () => ({ reportCaught: mocks.report }));
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

type InitProps = Parameters<typeof usePlaygroundClientInitialization>[0];

function initProps(
  hostList: HostListItem[],
  live = liveTarget(),
  restoringAdhoc = false,
): InitProps {
  return {
    isAuthenticated: true,
    projectId: "p1",
    hostList,
    hostListLoading: false,
    restoringAdhoc,
    live,
  };
}

function renderInit(...args: Parameters<typeof initProps>) {
  const initialProps = initProps(...args);
  const view = renderHook(
    (props: InitProps) => usePlaygroundClientInitialization(props),
    { initialProps },
  );
  return {
    ...view,
    update: (changes: Partial<InitProps>) =>
      view.rerender({ ...initialProps, ...changes }),
  };
}

function Notice(props: InitProps) {
  const init = usePlaygroundClientInitialization(props);
  return playgroundClientInitNotice({ projectId: props.projectId, ...init });
}

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function exhaustRetries() {
  for (const ms of [0, 1_000, 4_000, 10_000]) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }
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
    const { update } = renderInit([MCPJAM]);
    await settle();
    expect(mocks.ensure).not.toHaveBeenCalled();
    mocks.role = { canManage: true, isLoading: false };
    update({});
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
    mocks.ensure.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const live = liveTarget();
    const { update } = renderInit([MCPJAM], live);
    await settle();
    live.activeProjectIdRef.current = "p2";
    update({ projectId: "p2" });
    await settle();
    await act(async () => resolve(CREATED_LINEUP));
    expect(loadPreviewedHostId("p1")).toBe("h-claude");
    expect(loadSelectedHostIds("p1")).toEqual(LINEUP);
    expect(live.setPreviewedHostId).not.toHaveBeenCalled();
    expect(live.setSelectedHostIds).not.toHaveBeenCalled();
  });

  it("does not run while an ad-hoc conversation is being restored", async () => {
    renderInit([], liveTarget(), true);
    await settle();
    expect(mocks.ensure).not.toHaveBeenCalled();
  });

  it("leaves the selection alone when an ad-hoc restore starts mid-request", async () => {
    let resolve!: (value: unknown) => void;
    mocks.ensure.mockReturnValue(new Promise((r) => (resolve = r)));
    const live = liveTarget();
    renderInit([MCPJAM], live);
    await settle();
    live.restoringAdhocRef.current = true;
    await act(async () => resolve(CREATED_LINEUP));
    expect(loadPreviewedHostId("p1")).toBeNull();
    expect(loadSelectedHostIds("p1")).toEqual([]);
    expect(live.setSelectedHostIds).not.toHaveBeenCalled();
  });

  it("creates the default, then selects the lineup, in one visit", async () => {
    mocks.ensure
      .mockResolvedValueOnce({
        hostId: "h-mcpjam",
        created: true,
        comparison: null,
      })
      .mockResolvedValueOnce(CREATED_LINEUP);
    const live = liveTarget();
    const { update } = renderInit([], live);
    await settle();
    expect(loadSelectedHostIds("p1")).toEqual(["h-mcpjam"]);
    update({ hostList: [MCPJAM] });
    await settle();
    expect(mocks.ensure.mock.calls).toEqual([
      [{ projectId: "p1", themeMode: "dark" }],
      [{ projectId: "p1", themeMode: "dark", initializeComparison: true }],
    ]);
    expect(loadPreviewedHostId("p1")).toBe("h-claude");
    expect(loadSelectedHostIds("p1")).toEqual(LINEUP);
    expect(live.setSelectedHostIds).toHaveBeenLastCalledWith(LINEUP);
  });

  it("asks for a settled lineup once, however often loading flips", async () => {
    mocks.ensure.mockResolvedValue({
      ...CREATED_LINEUP,
      comparison: { ...CREATED_LINEUP.comparison, created: false },
    });
    const { update } = renderInit([MCPJAM]);
    await settle();
    update({ hostListLoading: true });
    update({ restoringAdhoc: true });
    update({});
    await settle();
    expect(mocks.ensure).toHaveBeenCalledTimes(1);
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

  it.each([
    ["no answer", null],
    ["an answer without a client", { created: true, comparison: null }],
  ])("fails on %s and writes no selection", async (_label, answer) => {
    mocks.role = { canManage: false, isLoading: false };
    mocks.ensure.mockResolvedValue(answer);
    const live = liveTarget();
    const { result } = renderInit([], live);
    await exhaustRetries();
    expect(result.current.defaultInit.state).toMatchObject({
      status: "failed",
      refused: false,
    });
    expect(loadPreviewedHostId("p1")).toBeNull();
    expect(loadSelectedHostIds("p1")).toEqual([]);
    expect(live.setPreviewedHostId).not.toHaveBeenCalled();
    expect(live.setSelectedHostIds).not.toHaveBeenCalled();
  });

  it("reports a failed comparison without touching the default", async () => {
    mocks.ensure.mockRejectedValue(new Error("network"));
    const { result } = renderInit([MCPJAM]);
    await exhaustRetries();
    expect(result.current.comparisonInit.state).toMatchObject({
      status: "failed",
      refused: false,
    });
    expect(result.current.defaultInit.state.status).toBe("idle");
  });

  it("settles for the default alone on a backend that predates initializeComparison", async () => {
    // The deploy-order window: this browser ships before mcpjam-backend#1996.
    mocks.ensure.mockRejectedValue(
      new Error(
        "[CONVEX M(projectClients:ensureProjectClient)] [Request ID: 0123456789abcdef] ArgumentValidationError: Object contains extra field `initializeComparison` that is not in the validator.",
      ),
    );
    const { result } = renderInit([MCPJAM]);
    await exhaustRetries();
    expect(mocks.ensure).toHaveBeenCalledTimes(1);
    expect(mocks.report).not.toHaveBeenCalled();
    expect(result.current.comparisonInit.state).toMatchObject({
      status: "failed",
      refused: true,
    });
    expect(result.current.defaultInit.state.status).toBe("idle");
  });
});

describe("playgroundClientInitNotice", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    localStorage.clear();
    mocks.role = { canManage: true, isLoading: false };
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a failed comparison, and Retry asks again", async () => {
    mocks.ensure.mockRejectedValue(new Error("network"));
    render(<Notice {...initProps([MCPJAM])} />);
    await exhaustRetries();
    expect(screen.getByRole("alert").textContent).toContain(
      "Could not set up the comparison clients. Try again.",
    );
    const calls = mocks.ensure.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(mocks.ensure).toHaveBeenCalledTimes(calls + 1);
  });

  it("says nothing when the comparison is refused", async () => {
    mocks.ensure.mockRejectedValue(new ConvexError({ code: "FORBIDDEN" }));
    const { container } = render(<Notice {...initProps([MCPJAM])} />);
    await settle();
    expect(mocks.ensure).toHaveBeenCalledTimes(1);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the default being prepared", async () => {
    mocks.ensure.mockReturnValue(new Promise(() => {}));
    render(<Notice {...initProps([])} />);
    await settle();
    expect(screen.getByRole("status").textContent).toContain(
      "Preparing a client",
    );
  });
});
