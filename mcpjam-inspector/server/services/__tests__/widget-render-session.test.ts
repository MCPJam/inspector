import { describe, it, expect, vi } from "vitest";
import {
  WidgetRenderSessionRegistry,
  WidgetSessionCapacityError,
  WidgetSessionNotFoundError,
  type SessionHarness,
} from "../widget-render-session";

/**
 * Lifecycle tests for the interactive widget-session registry. The registry is
 * render-agnostic — it only owns the harness lifecycle — so these drive it with
 * fake harnesses (no browser) and an injected clock (no real timers).
 */

function makeFakeHarness(): SessionHarness & {
  executeAction: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
} {
  return {
    executeAction: vi.fn(
      async (input: { toolCallId: string; action: unknown }) => ({
        action: input.action,
        screenshotBase64: "shot",
        widgetToolCalls: [
          { name: "reserve", args: { seat: 1 }, ok: true, elapsedMs: 1 },
        ],
        elapsedMs: 2,
      }),
    ),
    dispose: vi.fn(async () => {}),
  } as unknown as SessionHarness & {
    executeAction: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  };
}

function register(
  registry: WidgetRenderSessionRegistry,
  harness: SessionHarness,
  widgetId = "widget-1",
) {
  return registry.register({
    harness,
    serverId: "srv",
    mountedWidgetId: widgetId,
    viewport: { width: 800, height: 600 },
  });
}

describe("WidgetRenderSessionRegistry", () => {
  it("registers a session and exposes a public (harness-free) view", () => {
    let now = 1_000;
    const registry = new WidgetRenderSessionRegistry({
      now: () => now,
      idleTimeoutMs: 5_000,
      sweepIntervalMs: 0,
    });
    const harness = makeFakeHarness();

    const session = register(registry, harness);
    expect(session.sessionId).toBeTruthy();
    expect(session.serverId).toBe("srv");
    expect(session.mountedWidgetId).toBe("widget-1");
    expect(session.viewport).toEqual({ width: 800, height: 600 });
    expect(session.expiresAt).toBe(now + 5_000);
    expect((session as unknown as Record<string, unknown>).harness).toBeUndefined();
    expect(registry.size()).toBe(1);
  });

  it("drives an action on the mounted widget and refreshes the TTL", async () => {
    let now = 1_000;
    const registry = new WidgetRenderSessionRegistry({
      now: () => now,
      idleTimeoutMs: 5_000,
      sweepIntervalMs: 0,
    });
    const harness = makeFakeHarness();
    const session = register(registry, harness, "widget-xyz");

    now = 3_000;
    const { result, expiresAt } = await registry.executeAction(
      session.sessionId,
      { action: "left_click", coordinate: [10, 20] },
    );

    expect(harness.executeAction).toHaveBeenCalledWith({
      toolCallId: "widget-xyz",
      action: { action: "left_click", coordinate: [10, 20] },
    });
    expect(result.screenshotBase64).toBe("shot");
    expect(result.widgetToolCalls).toHaveLength(1);
    // TTL refreshed off the action time (now=3000), not the create time.
    expect(expiresAt).toBe(3_000 + 5_000);
  });

  it("closes a session and disposes its harness", async () => {
    const registry = new WidgetRenderSessionRegistry({ sweepIntervalMs: 0 });
    const harness = makeFakeHarness();
    const session = register(registry, harness);

    expect(await registry.close(session.sessionId)).toBe(true);
    expect(harness.dispose).toHaveBeenCalledTimes(1);
    expect(registry.size()).toBe(0);
    // Closing an unknown session is a no-op.
    expect(await registry.close(session.sessionId)).toBe(false);
  });

  it("enforces the max-session cap", () => {
    const registry = new WidgetRenderSessionRegistry({
      maxSessions: 2,
      sweepIntervalMs: 0,
    });
    register(registry, makeFakeHarness());
    register(registry, makeFakeHarness());

    expect(() => registry.assertCapacity()).toThrow(WidgetSessionCapacityError);
    expect(() => register(registry, makeFakeHarness())).toThrow(
      WidgetSessionCapacityError,
    );
    expect(registry.size()).toBe(2);
  });

  it("reclaims idle sessions on sweep and frees capacity", async () => {
    let now = 0;
    const registry = new WidgetRenderSessionRegistry({
      now: () => now,
      idleTimeoutMs: 1_000,
      maxSessions: 1,
      sweepIntervalMs: 0,
    });
    const harness = makeFakeHarness();
    const session = register(registry, harness);

    // Within TTL: still live.
    now = 999;
    registry.sweepExpired();
    expect(registry.size()).toBe(1);

    // Past TTL: swept + disposed.
    now = 1_001;
    registry.sweepExpired();
    // sweepExpired schedules disposal asynchronously; flush microtasks.
    await Promise.resolve();
    expect(harness.dispose).toHaveBeenCalledTimes(1);
    expect(registry.size()).toBe(0);
    expect(registry.get(session.sessionId)).toBeUndefined();

    // Capacity freed.
    expect(() => registry.assertCapacity()).not.toThrow();
  });

  it("keeps a session alive when an action refreshes the TTL before expiry", async () => {
    let now = 0;
    const registry = new WidgetRenderSessionRegistry({
      now: () => now,
      idleTimeoutMs: 1_000,
      sweepIntervalMs: 0,
    });
    const session = register(registry, makeFakeHarness());

    now = 800;
    await registry.executeAction(session.sessionId, { action: "screenshot" });

    // Past the ORIGINAL expiry (1000) but within the refreshed one (1800).
    now = 1_500;
    registry.sweepExpired();
    await Promise.resolve();
    expect(registry.size()).toBe(1);
  });

  it("rejects actions on unknown or expired sessions", async () => {
    let now = 0;
    const registry = new WidgetRenderSessionRegistry({
      now: () => now,
      idleTimeoutMs: 1_000,
      sweepIntervalMs: 0,
    });

    await expect(
      registry.executeAction("nope", { action: "screenshot" }),
    ).rejects.toBeInstanceOf(WidgetSessionNotFoundError);

    const session = register(registry, makeFakeHarness());
    now = 2_000; // expired
    await expect(
      registry.executeAction(session.sessionId, { action: "screenshot" }),
    ).rejects.toBeInstanceOf(WidgetSessionNotFoundError);
  });

  it("disposes every session on shutdown (orphan cleanup)", async () => {
    const registry = new WidgetRenderSessionRegistry({ sweepIntervalMs: 0 });
    const harnesses = [makeFakeHarness(), makeFakeHarness(), makeFakeHarness()];
    harnesses.forEach((h, i) => register(registry, h, `widget-${i}`));
    expect(registry.size()).toBe(3);

    await registry.disposeAll();

    for (const h of harnesses) {
      expect(h.dispose).toHaveBeenCalledTimes(1);
    }
    expect(registry.size()).toBe(0);
  });
});
