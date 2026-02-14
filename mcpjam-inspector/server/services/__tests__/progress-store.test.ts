import { describe, expect, it, vi } from "vitest";
import { ProgressStore } from "../progress-store.js";

describe("ProgressStore", () => {
  it("isolates progress entries by session and server", () => {
    const store = new ProgressStore();
    store.stopCleanupInterval();

    store.publish({
      sessionId: "session-a",
      serverId: "server-1",
      progressToken: "token-a",
      progress: 10,
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    store.publish({
      sessionId: "session-b",
      serverId: "server-1",
      progressToken: "token-b",
      progress: 90,
      timestamp: "2026-01-01T00:00:01.000Z",
    });

    const sessionA = store.getAllProgress("server-1", "session-a");
    const sessionB = store.getAllProgress("server-1", "session-b");

    expect(sessionA).toHaveLength(1);
    expect(sessionA[0].progressToken).toBe("token-a");
    expect(sessionB).toHaveLength(1);
    expect(sessionB[0].progressToken).toBe("token-b");
  });

  it("does not emit subscribed progress when server filter is empty", () => {
    const store = new ProgressStore();
    store.stopCleanupInterval();

    const listener = vi.fn();
    const unsubscribe = store.subscribe(
      { serverIds: [], sessionId: "session-a" },
      listener,
    );

    store.publish({
      sessionId: "session-a",
      serverId: "server-1",
      progressToken: "token-a",
      progress: 50,
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    unsubscribe();

    expect(listener).not.toHaveBeenCalled();
  });
});
