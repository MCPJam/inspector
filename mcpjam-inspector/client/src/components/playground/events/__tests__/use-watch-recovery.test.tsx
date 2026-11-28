import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaygroundEventBinding } from "../PlaygroundEventsProvider";
import { useWatchRecovery } from "../use-watch-recovery";

const mocks = vi.hoisted(() => ({
  ensureServersReady: vi.fn(),
}));
vi.mock("@/state/server-actions-context", () => ({
  useServerActionsOptional: () => ({
    ensureServersReady: mocks.ensureServersReady,
  }),
}));

function binding(
  overrides: Partial<PlaygroundEventBinding> = {},
): PlaygroundEventBinding {
  return {
    id: "watch-1",
    saved: true,
    subscriptionId: "sub-1",
    logicalId: "esub_1",
    serverName: "flights",
    eventName: "flight.delayed",
    instructions: "Rebook me",
    enabled: true,
    afterSeq: 10,
    agentScope: "chat-1:",
    ownerScope: "project::true",
    event: { name: "flight.delayed", delivery: [] },
    ...overrides,
  };
}

function setup(overrides: Partial<Parameters<typeof useWatchRecovery>[0]> = {}) {
  const notice = vi.fn();
  const advance = vi.fn(async () => undefined);
  const props: Parameters<typeof useWatchRecovery>[0] = {
    hosted: true,
    conversationId: "chat-1",
    bindings: [binding()],
    servers: { flights: { connectionStatus: "disconnected" } },
    localSubscriptions: null,
    gaps: [],
    head: undefined,
    queued: () => 0,
    notice,
    advance,
    ...overrides,
  };
  const hook = renderHook((current) => useWatchRecovery(current), {
    initialProps: props,
  });
  return { ...hook, props, notice, advance };
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.ensureServersReady.mockResolvedValue({
    readyServerNames: ["flights"],
    missingServerNames: [],
    failedServerNames: [],
    reauthServerNames: [],
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("bringing saved connections back after a reload", () => {
  it("reconnects a saved connection's server once in hosted mode", async () => {
    const { rerender, props } = setup();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.ensureServersReady).toHaveBeenCalledWith(["flights"]);
    rerender({ ...props, servers: { flights: { connectionStatus: "failed" } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.ensureServersReady).toHaveBeenCalledTimes(1);
  });

  it("never reconnects in local mode, where a reload keeps the connection", async () => {
    setup({ hosted: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.ensureServersReady).not.toHaveBeenCalled();
  });

  it("says what to do when the server needs sign-in again", async () => {
    mocks.ensureServersReady.mockResolvedValue({
      readyServerNames: [],
      missingServerNames: [],
      failedServerNames: [],
      reauthServerNames: ["flights"],
    });
    const { notice } = setup();
    await vi.advanceTimersByTimeAsync(0);
    expect(notice).toHaveBeenCalledWith(
      "watch-1",
      "Sign in to flights again to run its events.",
    );
  });

  it("says when this local app isn't running a saved connection's subscription", async () => {
    const { notice } = setup({
      hosted: false,
      servers: { flights: { connectionStatus: "connected" } },
      localSubscriptions: new Set(["another-subscription"]),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(notice).toHaveBeenCalledWith(
      "watch-1",
      expect.stringContaining("This local app isn't running this subscription"),
    );
  });

  it("says once when the inbox may have dropped events past a connection's position", async () => {
    const { notice, rerender, props } = setup({
      servers: { flights: { connectionStatus: "connected" } },
      gaps: [{ fromSeq: 11, toSeq: 40, at: 0 }],
    });
    await vi.advanceTimersByTimeAsync(0);
    rerender({ ...props, gaps: [...props.gaps] });
    await vi.advanceTimersByTimeAsync(0);
    expect(
      notice.mock.calls.filter(([, text]) => text.includes("may have expired")),
    ).toHaveLength(1);
  });

  it("moves a quiet connection's position up once the feed settles", async () => {
    const { advance } = setup({
      servers: { flights: { connectionStatus: "connected" } },
      head: 25,
    });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(advance).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(advance).toHaveBeenCalledWith("watch-1", 25);
  });

  it("leaves the position alone while events still wait", async () => {
    const { advance } = setup({
      servers: { flights: { connectionStatus: "connected" } },
      head: 25,
      queued: () => 2,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(advance).not.toHaveBeenCalled();
  });
});
