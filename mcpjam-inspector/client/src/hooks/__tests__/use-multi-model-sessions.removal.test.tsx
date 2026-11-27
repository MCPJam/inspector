import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerComparisonColumn } from "@/lib/comparison-auth-recovery";

const markRemoved = vi.hoisted(() => vi.fn());

vi.mock("../useMultiModelSessionsEnabled", () => ({
  useMultiModelSessionsEnabled: () => true,
  useMultiModelSessionsDisabled: () => false,
}));
vi.mock("@/lib/apis/web/chat-history-api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  markMultiModelColumnRemoved: markRemoved,
}));
vi.mock("@/lib/multi-model-session-restore", () => ({
  fetchMultiModelRestore: vi.fn(),
}));
vi.mock("../use-hosted-model-catalog", () => ({
  useHostedModelCatalog: () => ({ hostedCatalog: [] }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { useMultiModelSessions } from "../use-multi-model-sessions";

const GROUP = "group-1";

type Lineup = {
  configured: string[];
  live: string[];
  compareActive?: boolean;
  generation?: number;
};

function setup(initial: Lineup) {
  return renderHook(
    ({ configured, live, compareActive = true, generation = 0 }: Lineup) =>
      useMultiModelSessions({
        groupId: GROUP,
        projectId: "p1",
        selectedServers: [],
        serverCatalog: {
          serversById: new Map(),
          serversByName: new Map(),
          loaded: true,
          signedIn: true,
        },
        compareActive,
        generation,
        liveColumnKeys: live,
        configuredColumnKeys: configured,
        applyRestore: vi.fn(),
        branchFromThread: vi.fn(),
        detachForBranch: vi.fn(),
        showSingleChat: vi.fn(),
        unavailableHostIds: [],
        modelsReady: true,
        openColumnAlone: vi.fn(),
        branchBlockedBy: null,
      }),
    { initialProps: initial },
  );
}

const unregister: Array<() => void> = [];
function mountColumn(
  kind: "model" | "host",
  compareId: string,
  hasMessages = true,
) {
  const off = registerComparisonColumn(GROUP, {
    compareId,
    kind,
    order: unregister.length,
    chatSessionId: `chat-${compareId}`,
    hasMessages,
  });
  unregister.push(off);
  return off;
}

describe("marking removed multi-model columns", () => {
  afterEach(() => {
    while (unregister.length) unregister.pop()?.();
    markRemoved.mockReset();
  });

  it("marks a saved column removed when it leaves the lineup", () => {
    markRemoved.mockResolvedValue(undefined);
    mountColumn("model", "a");
    mountColumn("model", "b");
    const hook = setup({
      configured: ["model:a", "model:b"],
      live: ["model:a", "model:b"],
    });
    hook.rerender({ configured: ["model:a"], live: ["model:a"] });
    expect(markRemoved).toHaveBeenCalledTimes(1);
    expect(markRemoved).toHaveBeenCalledWith("chat-b");
  });

  it("marks the old column when an effort change replaces it", () => {
    markRemoved.mockResolvedValue(undefined);
    mountColumn("model", "a:low");
    const hook = setup({ configured: ["model:a:low"], live: ["model:a:low"] });
    hook.rerender({ configured: ["model:a:high"], live: ["model:a:high"] });
    expect(markRemoved).toHaveBeenCalledWith("chat-a:low");
  });

  it("keeps a client that is only briefly unavailable", () => {
    const off = mountColumn("host", "h2");
    mountColumn("host", "h1");
    const hook = setup({
      configured: ["host:h1", "host:h2"],
      live: ["host:h1", "host:h2"],
    });
    // h2 stops being ready: its card unmounts but it stays in the lineup.
    off();
    hook.rerender({ configured: ["host:h1", "host:h2"], live: ["host:h1"] });
    expect(markRemoved).not.toHaveBeenCalled();
  });

  it("still marks an unavailable client once it is taken out of the lineup", () => {
    markRemoved.mockResolvedValue(undefined);
    const off = mountColumn("host", "h2");
    mountColumn("host", "h1");
    const hook = setup({
      configured: ["host:h1", "host:h2"],
      live: ["host:h1", "host:h2"],
    });
    off();
    hook.rerender({ configured: ["host:h1", "host:h2"], live: ["host:h1"] });
    hook.rerender({ configured: ["host:h1"], live: ["host:h1"] });
    expect(markRemoved).toHaveBeenCalledWith("chat-h2");
  });

  it("skips a column that never saved a row", () => {
    mountColumn("model", "a");
    mountColumn("model", "b", false);
    const hook = setup({
      configured: ["model:a", "model:b"],
      live: ["model:a", "model:b"],
    });
    hook.rerender({ configured: ["model:a"], live: ["model:a"] });
    expect(markRemoved).not.toHaveBeenCalled();
  });

  it("removes nothing when compare turns off or a new chat starts", () => {
    mountColumn("model", "a");
    mountColumn("model", "b");
    const hook = setup({
      configured: ["model:a", "model:b"],
      live: ["model:a", "model:b"],
    });
    hook.rerender({ configured: [], live: [], compareActive: false });
    hook.rerender({
      configured: ["model:a", "model:b"],
      live: ["model:a", "model:b"],
    });
    hook.rerender({ configured: [], live: [], generation: 1 });
    expect(markRemoved).not.toHaveBeenCalled();
  });
});
