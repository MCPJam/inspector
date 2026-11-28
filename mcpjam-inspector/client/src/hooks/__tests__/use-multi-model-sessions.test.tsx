import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatHistorySession } from "@/lib/apis/web/chat-history-api";
import type { ComparisonAuthRecovery } from "@/lib/comparison-auth-recovery";
import type { MultiModelRestore } from "@/lib/multi-model-session-restore";

// `undefined` while PostHog is still loading flags.
const flag = vi.hoisted(() => ({ enabled: false as boolean | undefined }));
const fetchRestore = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock("../useMultiModelSessionsEnabled", () => ({
  useMultiModelSessionsEnabled: () => flag.enabled === true,
  useMultiModelSessionsDisabled: () => flag.enabled === false,
}));
vi.mock("@/lib/multi-model-session-restore", () => ({
  fetchMultiModelRestore: fetchRestore,
}));
vi.mock("../use-hosted-model-catalog", () => ({
  useHostedModelCatalog: () => ({ hostedCatalog: [] }),
}));
const trackMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analytics", () => ({ track: trackMock }));
vi.mock("sonner", () => ({
  toast: { error: toastError, success: vi.fn() },
}));

import {
  useMultiModelSessions,
  type ServerCatalog,
} from "../use-multi-model-sessions";

const session = {
  _id: "row-a",
  chatSessionId: "a",
  multiModel: {
    groupId: "g1",
    position: 0,
    columnKind: "model",
    compareId: "m",
  },
} as ChatHistorySession;

const restored: MultiModelRestore = {
  record: { id: "g1" } as ComparisonAuthRecovery,
  positions: [{ columnKey: "model:m", position: 4 }],
  highestPosition: 6,
  columnSessions: [session],
};

const loadedCatalog: ServerCatalog = {
  serversById: new Map([["srv-linear", "linear"]]),
  serversByName: new Map([["linear", "srv-linear"]]),
  loaded: true,
  signedIn: true,
};

function setup(
  options: {
    branchBlockedBy?: string;
    projectId?: string;
    serverCatalog?: ServerCatalog;
  } = {},
) {
  const applyRestore = vi.fn();
  const branchFromThread = vi
    .fn()
    .mockResolvedValue({ previousChatSessionId: "a" });
  const hook = renderHook(
    ({ projectId, serverCatalog }) => {
      // As in the Playground, the restored record's id becomes the group.
      const [groupId, setGroupId] = useState("live");
      return useMultiModelSessions({
        groupId,
        projectId,
        selectedServers: ["linear"],
        serverCatalog,
        compareActive: false,
        generation: 0,
        liveColumnKeys: [],
        configuredColumnKeys: [],
        applyRestore: (record) => {
          applyRestore(record);
          setGroupId(record.id);
        },
        branchFromThread,
        detachForBranch: vi.fn(),
        showSingleChat: vi.fn(),
        unavailableHostIds: [],
        modelsReady: true,
        openColumnAlone: vi.fn(),
        branchBlockedBy: options.branchBlockedBy ?? null,
      });
    },
    {
      initialProps: {
        projectId: options.projectId ?? "p1",
        serverCatalog: options.serverCatalog ?? loadedCatalog,
      },
    },
  );
  return { applyRestore, branchFromThread, hook };
}

async function openAlone(hook: ReturnType<typeof setup>["hook"]) {
  await act(async () => {
    await hook.result.current.openFromHistory(session, undefined, () => true);
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe("useMultiModelSessions", () => {
  beforeEach(() => {
    flag.enabled = false;
    fetchRestore.mockReset();
  });

  it("saves no group and opens rows on their own while the flag is off", async () => {
    const { applyRestore, hook } = setup();
    expect(hook.result.current.positionFor("model:m")).toBeUndefined();
    const opened = await hook.result.current.openFromHistory(
      session,
      [session],
      () => true,
    );
    expect(opened).toBeNull();
    expect(fetchRestore).not.toHaveBeenCalled();
    expect(applyRestore).not.toHaveBeenCalled();
  });

  it("branches a column opened before the flag loaded once the flag turns on", async () => {
    const { hook } = setup();
    await openAlone(hook);
    expect(hook.result.current.sendInColumn).toBeNull();
    flag.enabled = true;
    hook.rerender({ projectId: "p1", serverCatalog: loadedCatalog });
    expect(hook.result.current.sendInColumn).not.toBeNull();
  });

  it("reopens the whole session and keeps its positions with the flag on", async () => {
    flag.enabled = true;
    fetchRestore.mockResolvedValue(restored);
    const { applyRestore, hook } = setup();
    let opened: string | null = null;
    await act(async () => {
      opened = await hook.result.current.openFromHistory(
        session,
        [session],
        () => true,
      );
    });
    expect(opened).toBe("restored");
    expect(applyRestore).toHaveBeenCalledWith(restored.record);
    expect(hook.result.current.positionFor("model:m")).toBe(4);
    expect(hook.result.current.positionFor("model:new")).toBe(7);
  });

  it("drops a restore that another selection replaced while it loaded", async () => {
    flag.enabled = true;
    fetchRestore.mockResolvedValue(restored);
    const { applyRestore, hook } = setup();
    const opened = await hook.result.current.openFromHistory(
      session,
      [session],
      () => false,
    );
    expect(opened).toBe("stale");
    expect(applyRestore).not.toHaveBeenCalled();
  });

  it("opens a row on its own when it is not a multi-model column", async () => {
    flag.enabled = true;
    const { hook } = setup();
    const single = { ...session, multiModel: undefined };
    expect(
      await hook.result.current.openFromHistory(single, [single], () => true),
    ).toBeNull();
  });

  it("waits for sign-in and the server catalog, then maps saved servers", async () => {
    flag.enabled = true;
    fetchRestore.mockResolvedValue(restored);
    const loading: ServerCatalog = {
      serversById: new Map(),
      serversByName: new Map(),
      loaded: false,
      signedIn: true,
    };
    const { applyRestore, hook } = setup({ serverCatalog: loading });
    let opened: Promise<string | null> | undefined;
    act(() => {
      opened = hook.result.current.openFromHistory(
        session,
        [session],
        () => true,
      );
    });
    await act(async () => {});
    expect(fetchRestore).not.toHaveBeenCalled();

    hook.rerender({ projectId: "p1", serverCatalog: loadedCatalog });
    await act(async () => {
      expect(await opened).toBe("restored");
    });
    expect(applyRestore).toHaveBeenCalledWith(restored.record);
    const { toServerIds } = fetchRestore.mock.calls[0][0];
    expect(toServerIds(["linear", "srv-linear", "gone"])).toEqual([
      "srv-linear",
      "srv-linear",
    ]);
  });

  it("drops a restore that finishes after a project switch", async () => {
    flag.enabled = true;
    const read = deferred<MultiModelRestore>();
    fetchRestore.mockReturnValue(read.promise);
    const { applyRestore, hook } = setup();
    let opened: Promise<string | null> | undefined;
    act(() => {
      opened = hook.result.current.openFromHistory(
        session,
        [session],
        () => true,
      );
    });
    hook.rerender({ projectId: "p2", serverCatalog: loadedCatalog });
    await act(async () => {
      read.resolve(restored);
      expect(await opened).toBe("stale");
    });
    expect(applyRestore).not.toHaveBeenCalled();
  });

  it("drops a restore that finishes after sign-in changes", async () => {
    flag.enabled = true;
    const read = deferred<MultiModelRestore>();
    fetchRestore.mockReturnValue(read.promise);
    const { applyRestore, hook } = setup();
    let opened: Promise<string | null> | undefined;
    act(() => {
      opened = hook.result.current.openFromHistory(
        session,
        [session],
        () => true,
      );
    });
    hook.rerender({
      projectId: "p1",
      serverCatalog: { ...loadedCatalog, signedIn: false },
    });
    await act(async () => {
      read.resolve(restored);
      expect(await opened).toBe("stale");
    });
    expect(applyRestore).not.toHaveBeenCalled();
  });

  it("branches a column opened alone, carrying the composer context", async () => {
    flag.enabled = true;
    const { branchFromThread, hook } = setup();
    await openAlone(hook);
    const message = {
      text: "next",
      pluginMentions: [],
      extraParts: [],
      widgetModelContext: [],
    };
    await act(async () => {
      expect(await hook.result.current.sendInColumn?.(message)).toBe(true);
    });
    expect(branchFromThread).toHaveBeenCalledWith(
      expect.objectContaining(message),
    );
  });

  it("refuses to branch a column on a harness client", async () => {
    flag.enabled = true;
    const { branchFromThread, hook } = setup({ branchBlockedBy: "Claude Code" });
    await openAlone(hook);
    let sent: boolean | undefined;
    await act(async () => {
      sent = await hook.result.current.sendInColumn?.({ text: "next" });
    });
    expect(sent).toBe(false);
    expect(branchFromThread).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(
      expect.stringMatching(/^Claude Code can't continue a saved column/),
    );
  });

  it("branches a column sent from while the flag is still loading", async () => {
    flag.enabled = undefined;
    const { branchFromThread, hook } = setup();
    await openAlone(hook);
    let sent: boolean | undefined;
    await act(async () => {
      sent = await hook.result.current.sendInColumn?.({ text: "early" });
    });
    expect(sent).toBe(true);
    expect(branchFromThread).toHaveBeenCalledWith(
      expect.objectContaining({ text: "early" }),
    );
  });

  it("keeps a column opened while an earlier column's branch was pending", async () => {
    flag.enabled = true;
    const { branchFromThread, hook } = setup();
    const branch = deferred<{ previousChatSessionId: string }>();
    branchFromThread.mockReturnValueOnce(branch.promise);
    await openAlone(hook);
    let pending: Promise<boolean> | undefined;
    act(() => {
      pending = hook.result.current.sendInColumn?.({ text: "next" });
    });
    const other = { ...session, _id: "row-b", chatSessionId: "b" };
    await act(async () => {
      await hook.result.current.openFromHistory(other, undefined, () => true);
    });
    await act(async () => {
      branch.resolve({ previousChatSessionId: "a" });
      await pending;
    });
    expect(hook.result.current.sendInColumn).not.toBeNull();
  });

  it("drops an Open multi-model session that a reset overtook", async () => {
    flag.enabled = true;
    let resolve: (value: MultiModelRestore) => void = () => undefined;
    fetchRestore.mockReturnValue(
      new Promise<MultiModelRestore>((done) => {
        resolve = done;
      }),
    );
    const { applyRestore, hook } = setup();
    await openAlone(hook);
    render(<>{hook.result.current.notice}</>);
    fireEvent.click(screen.getByText("Open multi-model session"));
    act(() => hook.result.current.clearOpenedColumn());
    await act(async () => {
      resolve(restored);
    });
    expect(applyRestore).not.toHaveBeenCalled();
  });

  it("drops an Open multi-model session when sign-in changes mid-load", async () => {
    flag.enabled = true;
    const read = deferred<MultiModelRestore>();
    fetchRestore.mockReturnValue(read.promise);
    const { applyRestore, hook } = setup();
    await openAlone(hook);
    render(<>{hook.result.current.notice}</>);
    fireEvent.click(screen.getByText("Open multi-model session"));
    hook.rerender({
      projectId: "p1",
      serverCatalog: { ...loadedCatalog, signedIn: false },
    });
    await act(async () => {
      read.resolve(restored);
    });
    expect(fetchRestore).toHaveBeenCalledWith(
      expect.objectContaining({ toServerIds: expect.any(Function) }),
    );
    expect(applyRestore).not.toHaveBeenCalled();
  });

  it("drops an Open multi-model session when the project switches away and back mid-load", async () => {
    flag.enabled = true;
    const read = deferred<MultiModelRestore>();
    fetchRestore.mockReturnValue(read.promise);
    const { applyRestore, hook } = setup();
    await openAlone(hook);
    render(<>{hook.result.current.notice}</>);
    fireEvent.click(screen.getByText("Open multi-model session"));
    hook.rerender({ projectId: "p2", serverCatalog: loadedCatalog });
    hook.rerender({ projectId: "p1", serverCatalog: loadedCatalog });
    await act(async () => {
      read.resolve(restored);
    });
    expect(applyRestore).not.toHaveBeenCalled();
  });

  it("reports a session's start once, and never for a reopened one", async () => {
    flag.enabled = true;
    trackMock.mockClear();
    fetchRestore.mockResolvedValue(restored);
    const { hook } = setup();
    act(() => hook.result.current.trackStarted("first"));
    act(() => hook.result.current.trackStarted("second"));
    expect(trackMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await hook.result.current.openFromHistory(session, [session], () => true);
    });
    act(() => hook.result.current.trackStarted("after reopening"));
    expect(trackMock).toHaveBeenCalledTimes(1);
  });
});
