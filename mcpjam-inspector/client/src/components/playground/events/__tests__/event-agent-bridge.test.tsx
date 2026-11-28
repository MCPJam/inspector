import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEventAgentBridge, usePublishEventAgent } from "../event-agent-bridge";
import type { EventAgent } from "../event-dispatch";

afterEach(() => {
  useEventAgentBridge.getState().set(null);
});

describe("Playground event agent publication", () => {
  it("does not notify consumers when a render recreates the same agent", () => {
    const agent: EventAgent = {
      scope: "chat:client",
      blockedReason: null,
      send: vi.fn(async () => true),
    };
    const { rerender, unmount } = renderHook(usePublishEventAgent, {
      initialProps: agent,
    });
    const published = useEventAgentBridge.getState().agent;
    expect(published).toEqual(agent);
    rerender({ ...agent });
    expect(useEventAgentBridge.getState().agent).toBe(published);
    unmount();
    expect(useEventAgentBridge.getState().agent).toBeNull();
  });

  it("publishes changed readiness, scope and send behavior", async () => {
    const originalSend = vi.fn(async () => true);
    const agent: EventAgent = {
      scope: "chat:client",
      blockedReason: null,
      send: originalSend,
    };
    const { rerender } = renderHook(usePublishEventAgent, {
      initialProps: agent,
    });
    rerender({ ...agent, blockedReason: "Agent is busy" });
    expect(useEventAgentBridge.getState().agent?.blockedReason).toBe(
      "Agent is busy",
    );
    const nextSend = vi.fn(async () => false);
    rerender({ ...agent, scope: "other-chat:client", send: nextSend });
    const published = useEventAgentBridge.getState().agent;
    expect(published?.scope).toBe("other-chat:client");
    expect(published?.blockedReason).toBeNull();
    expect(await published?.send("event", () => true)).toBe(false);
    expect(nextSend).toHaveBeenCalledOnce();
    expect(originalSend).not.toHaveBeenCalled();
  });
});
