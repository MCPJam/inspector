import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatHistorySession } from "@/lib/apis/web/chat-history-api";
import type { ComparisonAuthRecovery } from "@/lib/comparison-auth-recovery";
import type { MultiModelRestore } from "@/lib/multi-model-session-restore";

const flag = vi.hoisted(() => ({ enabled: false }));
const fetchRestore = vi.hoisted(() => vi.fn());

vi.mock("../useMultiModelSessionsEnabled", () => ({
  useMultiModelSessionsEnabled: () => flag.enabled,
}));
vi.mock("@/lib/multi-model-session-restore", () => ({
  fetchMultiModelRestore: fetchRestore,
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
  initial: Partial<{ projectId: string; serverCatalog: ServerCatalog }> = {},
) {
  const applyRestore = vi.fn();
  const hook = renderHook(
    ({ projectId, serverCatalog }) =>
      useMultiModelSessions({
        groupId: "live",
        projectId,
        selectedServers: ["linear"],
        serverCatalog,
        liveColumnKeys: [],
        applyRestore,
      }),
    {
      initialProps: {
        projectId: initial.projectId ?? "p1",
        serverCatalog: initial.serverCatalog ?? loadedCatalog,
      },
    },
  );
  return { applyRestore, hook };
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
});
