import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("@/lib/session-token", () => ({
  addTokenToUrl: vi.fn((url: string) => url),
}));

import { subscribeToRpcStream, useTrafficLogStore } from "../traffic-log-store";

describe("traffic-log-store hosted mode", () => {
  beforeEach(() => {
    useTrafficLogStore.getState().clear();
  });

  it("does not create the local rpc EventSource subscription in hosted mode", () => {
    const eventSourceSpy = vi.fn();
    const originalEventSource = globalThis.EventSource;
    Object.assign(globalThis, { EventSource: eventSourceSpy });

    try {
      const unsubscribe = subscribeToRpcStream();

      expect(eventSourceSpy).not.toHaveBeenCalled();
      expect(typeof unsubscribe).toBe("function");
    } finally {
      Object.assign(globalThis, { EventSource: originalEventSource });
    }
  });
});
