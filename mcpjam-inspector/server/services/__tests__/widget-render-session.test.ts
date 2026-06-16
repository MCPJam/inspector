import { describe, it, expect, vi } from "vitest";
import {
  WidgetRenderSessionRegistry,
  WidgetSessionCapacityError,
  WidgetSessionNotFoundError,
  type SessionHarness,
} from "../widget-render-session";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type FakeHarness = SessionHarness & {
  executeAction: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
};

/** A harness whose action/dispose resolution is caller-controlled, for racing
 *  the registry's lifecycle against in-flight work. */
function makeControllableHarness(): {
  harness: FakeHarness;
  resolveAction: (result?: unknown) => void;
  resolveDispose: () => void;
} {
  const actionGate = deferred<unknown>();
  const disposeGate = deferred<void>();
  const harness = {
    executeAction: vi.fn(() => actionGate.promise),
    dispose: vi.fn(() => disposeGate.promise),
  } as unknown as FakeHarness;
  return {
    harness,
    resolveAction: (result) =>
      actionGate.resolve(
        result ?? { action: { action: "screenshot" }, widgetToolCalls: [], elapsedMs: 1 },
      ),
    resolveDispose: () => disposeGate.resolve(),
  };
}

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

/** Register a session that consumes a held reservation. */
function register2(
  registry: WidgetRenderSessionRegistry,
  reservation: import("../widget-render-session").WidgetSessionReservation,
  widgetId = "widget-r",
) {
  return registry.register(
    {
      harness: makeFakeHarness(),
      serverId: "srv",
      mountedWidgetId: widgetId,
      viewport: { width: 800, height: 600 },
    },
    reservation,
  );
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

    expect(() => registry.reserve()).toThrow(WidgetSessionCapacityError);
    expect(() => register(registry, makeFakeHarness())).toThrow(
      WidgetSessionCapacityError,
    );
    expect(registry.size()).toBe(2);
  });

  it("reserves slots so concurrent starts can't exceed the cap", () => {
    const registry = new WidgetRenderSessionRegistry({
      maxSessions: 2,
      sweepIntervalMs: 0,
    });
    // Both slots held before ANY register — a third start is rejected up front,
    // before a browser is launched (the real bug: parallel starts each passing
    // a point-in-time check).
    const r1 = registry.reserve();
    const r2 = registry.reserve();
    expect(() => registry.reserve()).toThrow(WidgetSessionCapacityError);

    // Releasing a held slot frees capacity.
    registry.release(r1);
    const r3 = registry.reserve();
    expect(r3.active).toBe(true);

    // Registering consumes a reservation without double-counting: cap is now
    // 1 live session + 1 reserved (r3) = 2, so the next reserve is rejected.
    register2(registry, r2);
    expect(registry.size()).toBe(1);
    expect(() => registry.reserve()).toThrow(WidgetSessionCapacityError);

    // release is idempotent.
    registry.release(r3);
    registry.release(r3);
    expect(() => registry.reserve()).not.toThrow();
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
    registry.release(registry.reserve());
    expect(registry.size()).toBe(0);
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

  it("counts still-disposing sessions against the cap", async () => {
    // A closed session's browser isn't freed until dispose() resolves, so a
    // concurrent start must not slip past the cap during teardown.
    const registry = new WidgetRenderSessionRegistry({
      maxSessions: 1,
      sweepIntervalMs: 0,
    });
    const { harness, resolveDispose } = makeControllableHarness();
    const session = register(registry, harness);

    // Begin close — dispose is pending (browser still tearing down).
    const closePromise = registry.close(session.sessionId);
    expect(registry.size()).toBe(0);
    // Capacity is still consumed by the disposing browser.
    expect(() => registry.reserve()).toThrow(WidgetSessionCapacityError);

    // Teardown finishes -> capacity freed.
    resolveDispose();
    await closePromise;
    registry.release(registry.reserve());
    expect(registry.size()).toBe(0);
  });

  it("does not idle-sweep a session with an in-flight action, and refreshes its TTL", async () => {
    let now = 0;
    const registry = new WidgetRenderSessionRegistry({
      now: () => now,
      idleTimeoutMs: 1_000,
      sweepIntervalMs: 0,
    });
    const { harness, resolveAction } = makeControllableHarness();
    const session = register(registry, harness);

    // Start a long action (pending), then let the clock pass the TTL.
    const actionPromise = registry.executeAction(session.sessionId, {
      action: "screenshot",
    });
    now = 5_000;
    registry.sweepExpired();
    await Promise.resolve();
    // Busy -> not swept.
    expect(registry.size()).toBe(1);
    expect(harness.dispose).not.toHaveBeenCalled();

    // Action settles -> TTL refreshed off the settle time.
    resolveAction();
    const { expiresAt } = await actionPromise;
    expect(expiresAt).toBe(5_000 + 1_000);
    expect(registry.size()).toBe(1);
  });

  it("rejects an action whose session is closed mid-flight (no false success)", async () => {
    const registry = new WidgetRenderSessionRegistry({ sweepIntervalMs: 0 });
    const { harness, resolveAction, resolveDispose } = makeControllableHarness();
    const session = register(registry, harness);

    const actionPromise = registry.executeAction(session.sessionId, {
      action: "left_click",
      coordinate: [1, 2],
    });
    // Close mid-action.
    resolveDispose();
    await registry.close(session.sessionId);
    expect(registry.size()).toBe(0);

    // The in-flight action now resolves — but the session is gone, so it must
    // not report success.
    resolveAction();
    await expect(actionPromise).rejects.toBeInstanceOf(
      WidgetSessionNotFoundError,
    );
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
