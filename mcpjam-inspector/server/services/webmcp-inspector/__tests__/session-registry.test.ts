import { describe, it, expect, vi } from "vitest";
import {
  startWebMcpSession,
  WebMcpSessionCapacityError,
  WebMcpSessionNotFoundError,
  WebMcpSessionRegistry,
  WebMcpSessionUnavailableError,
} from "../session-registry";
import { WebMcpUnsupportedError } from "../provider";
import { deferred, FakeProvider } from "./fake-provider";

/** A registry with no background timer; these tests sweep on demand. */
function makeRegistry(
  overrides: Partial<
    ConstructorParameters<typeof WebMcpSessionRegistry>[0]
  > = {},
) {
  let clock = 1_000;
  const registry = new WebMcpSessionRegistry({
    maxSessions: 2,
    idleTimeoutMs: 10_000,
    maxLifetimeMs: 60_000,
    sweepIntervalMs: 0,
    now: () => clock,
    ...overrides,
  });
  return {
    registry,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}

describe("WebMcpSessionRegistry — capacity", () => {
  it("refuses a session beyond the cap", async () => {
    const { registry } = makeRegistry({ maxSessions: 1 });
    const provider = new FakeProvider();
    await startWebMcpSession({ url: "https://a.test/", provider, registry });

    await expect(
      startWebMcpSession({ url: "https://b.test/", provider, registry }),
    ).rejects.toBeInstanceOf(WebMcpSessionCapacityError);
    expect(provider.sessions).toHaveLength(1);
  });

  it("keeps the hosted and local ceilings independent", async () => {
    // They count different things — a Chromium window here versus a handle to
    // a browser on somebody's own desktop — so one filling up must not refuse
    // the other. The local inspector runs both at once whenever a person picks
    // a hosted browser, which is the case that made this visible: two hosted
    // handles, well inside a limit of 50, filled a local limit of 2.
    const { registry } = makeRegistry({
      maxSessions: 1,
      maxHostedSessions: 2,
    });
    const provider = new FakeProvider();
    const start = (sessionId?: string) =>
      startWebMcpSession({
        url: "https://a.test/",
        provider,
        registry,
        ...(sessionId ? { sessionId } : {}),
      });

    await start("hosted:p1:c1");
    await start("hosted:p1:c2");
    // Hosted is now FULL, and a local window is still on offer.
    await expect(start("hosted:p1:c3")).rejects.toBeInstanceOf(
      WebMcpSessionCapacityError,
    );
    await start();

    // …and now local is full, which says nothing about hosted either: closing
    // one hosted handle frees a hosted slot and only a hosted slot.
    await expect(start()).rejects.toBeInstanceOf(WebMcpSessionCapacityError);
    await registry.close("hosted:p1:c1");
    await expect(start()).rejects.toBeInstanceOf(WebMcpSessionCapacityError);
    await start("hosted:p1:c3");
    expect(registry.size()).toBe(3);
  });

  it("puts no absolute ceiling on a hosted handle, and keeps one locally", async () => {
    // The ceiling bounds a real Chromium window. A hosted runtime is a HANDLE
    // to a browser on the member's own computer, rebuilt on every replica that
    // re-hydrates it — so the deadline restarted on each hop and silently
    // never arrived. Expiring it would drop the handle and leave the browser
    // running anyway; what bounds THAT is the computer's own hibernation. The
    // idle sweep still reclaims the handle when nobody is watching.
    const { registry, advance } = makeRegistry({
      maxSessions: 4,
      maxHostedSessions: 4,
      maxLifetimeMs: 1_000,
      idleTimeoutMs: 10_000,
    });
    const provider = new FakeProvider();
    await startWebMcpSession({ url: "https://a.test/", provider, registry });
    await startWebMcpSession({
      url: "https://a.test/",
      provider,
      registry,
      sessionId: "hosted:p1:c1",
    });

    advance(2_000);
    registry.sweepExpired();
    // The local window is gone on lifetime alone; the hosted handle is not,
    // because it is still well inside its idle window.
    expect(registry.peek("hosted:p1:c1")).toBeDefined();
    expect(registry.size()).toBe(1);

    // …and the idle sweep still takes it.
    advance(20_000);
    registry.sweepExpired();
    expect(registry.peek("hosted:p1:c1")).toBeUndefined();
  });

  it("counts in-flight launches, so concurrent starts cannot both pass the cap", async () => {
    const { registry } = makeRegistry({ maxSessions: 1 });
    const provider = new FakeProvider();
    // Hold the launch open: without a reservation taken BEFORE the async
    // launch, both starts would see an empty registry and launch a browser.
    provider.launchGate = deferred<void>();

    const first = startWebMcpSession({
      url: "https://a.test/",
      provider,
      registry,
    });
    const second = startWebMcpSession({
      url: "https://b.test/",
      provider,
      registry,
    });

    await expect(second).rejects.toBeInstanceOf(WebMcpSessionCapacityError);
    provider.launchGate.resolve();
    await first;
    expect(provider.sessions).toHaveLength(1);
  });

  it("frees the slot when a launch fails", async () => {
    const { registry } = makeRegistry({ maxSessions: 1 });
    const provider = new FakeProvider();
    provider.failWith = new Error("launch exploded");

    await expect(
      startWebMcpSession({ url: "https://a.test/", provider, registry }),
    ).rejects.toThrow("launch exploded");

    provider.failWith = undefined;
    const session = await startWebMcpSession({
      url: "https://b.test/",
      provider,
      registry,
    });
    expect(session.sessionId).toBeTruthy();
  });

  it("counts a still-disposing browser against the cap", async () => {
    const { registry } = makeRegistry({ maxSessions: 1 });
    const provider = new FakeProvider();
    // dispose() is async: the map entry disappears immediately, but the
    // Chromium process does not.
    provider.disposeGate = deferred<void>();
    const started = await startWebMcpSession({
      url: "https://a.test/",
      provider,
      registry,
    });

    const closing = registry.close(started.sessionId);
    await expect(
      startWebMcpSession({ url: "https://b.test/", provider, registry }),
    ).rejects.toBeInstanceOf(WebMcpSessionCapacityError);

    provider.disposeGate.resolve();
    await closing;
    await expect(
      startWebMcpSession({ url: "https://b.test/", provider, registry }),
    ).resolves.toBeTruthy();
  });
});

describe("WebMcpSessionRegistry — expiry", () => {
  it("reaps an idle session and leaves a fresh one alone", async () => {
    const { registry, advance } = makeRegistry();
    const provider = new FakeProvider();
    const idle = await startWebMcpSession({
      url: "https://a.test/",
      provider,
      registry,
    });

    advance(9_000);
    registry.sweepExpired();
    expect(registry.size()).toBe(1);

    advance(2_000); // now past the 10s idle TTL
    registry.sweepExpired();
    // Reaping is asynchronous: the browser has to be torn down first.
    await vi.waitFor(() => expect(registry.size()).toBe(0));
    expect(() => registry.get(idle.sessionId)).toThrow(
      WebMcpSessionNotFoundError,
    );
  });

  it("keeps a session alive while the browser reports activity", async () => {
    const { registry, advance } = makeRegistry();
    const provider = new FakeProvider();
    await startWebMcpSession({ url: "https://a.test/", provider, registry });
    const session = provider.sessions[0];

    advance(9_000);
    // Someone is using the window, even though no API call arrived.
    session.callbacks.onActivityObserved();
    advance(9_000);
    registry.sweepExpired();
    expect(registry.size()).toBe(1);
  });

  it("reaps on the absolute lifetime even when activity keeps arriving", async () => {
    const { registry, advance } = makeRegistry();
    const provider = new FakeProvider();
    await startWebMcpSession({ url: "https://a.test/", provider, registry });
    const session = provider.sessions[0];

    for (let elapsed = 0; elapsed < 60_000; elapsed += 5_000) {
      advance(5_000);
      session.callbacks.onActivityObserved();
    }
    advance(5_000);
    registry.sweepExpired();
    // Reaping is asynchronous: the browser has to be torn down first.
    await vi.waitFor(() => expect(registry.size()).toBe(0));
  });

  it("defers reaping a session with an invocation in flight", async () => {
    const { registry, advance } = makeRegistry();
    const provider = new FakeProvider();
    const started = await startWebMcpSession({
      url: "https://a.test/",
      provider,
      registry,
    });
    const runtime = registry.get(started.sessionId);
    const session = provider.sessions[0];
    session.hangOnInvoke = true;
    session.emitTools([
      {
        frameId: "frame-main",
        name: "echo",
        description: "Echoes",
        origin: "https://a.test",
        isMainFrame: true,
        registrationKind: "imperative",
      },
    ]);

    const { settled } = runtime.invoke("https://a.test::echo", {}, "manual");
    settled.catch(() => {});
    await vi.waitFor(() => expect(session.invocations).toHaveLength(1));

    advance(120_000);
    registry.sweepExpired();
    expect(registry.size()).toBe(1); // still running — not reaped mid-call

    session.pending?.resolve({ output: "done" });
    await settled;
    registry.sweepExpired();
    // Reaping is asynchronous: the browser has to be torn down first.
    await vi.waitFor(() => expect(registry.size()).toBe(0));
  });
});

describe("WebMcpSessionRegistry — shutdown", () => {
  it("refuses new sessions once a permanent disposeAll has run", async () => {
    const { registry } = makeRegistry();
    const provider = new FakeProvider();
    await startWebMcpSession({ url: "https://a.test/", provider, registry });

    await registry.disposeAll({ permanent: true });
    expect(registry.size()).toBe(0);
    expect(provider.sessions[0].disposed).toBe(true);

    await expect(
      startWebMcpSession({ url: "https://b.test/", provider, registry }),
    ).rejects.toBeInstanceOf(WebMcpSessionUnavailableError);
  });

  it("closes a browser that finishes launching during a permanent shutdown", async () => {
    const { registry } = makeRegistry({ maxSessions: 1 });
    const provider = new FakeProvider();
    provider.launchGate = deferred<void>();

    const starting = startWebMcpSession({
      url: "https://a.test/",
      provider,
      registry,
    });
    // Shutdown lands while the launch is still in flight: registration will be
    // refused, and the browser that arrives afterwards has no owner.
    await registry.disposeAll({ permanent: true });
    provider.launchGate.resolve();

    await expect(starting).rejects.toBeInstanceOf(
      WebMcpSessionUnavailableError,
    );
    await vi.waitFor(() => expect(provider.sessions[0].disposed).toBe(true));
  });

  it("disposes an unsupported browser instead of holding a slot with it", async () => {
    const { registry } = makeRegistry({ maxSessions: 1 });
    const provider = new FakeProvider();
    provider.failWith = new WebMcpUnsupportedError("no WebMCP here");

    await expect(
      startWebMcpSession({ url: "https://a.test/", provider, registry }),
    ).rejects.toBeInstanceOf(WebMcpUnsupportedError);
    expect(registry.size()).toBe(0);

    provider.failWith = undefined;
    await expect(
      startWebMcpSession({ url: "https://b.test/", provider, registry }),
    ).resolves.toBeTruthy();
  });
});

describe("WebMcpSessionRegistry — viewport mode", () => {
  it("passes no viewport mode when the caller omits one", async () => {
    const { registry } = makeRegistry();
    const provider = new FakeProvider();
    await startWebMcpSession({ url: "https://a.test/", provider, registry });
    // Absent, not `"window"`: a provider written before this field existed sees
    // exactly the options it has always seen.
    expect(provider.createOptions[0]).not.toHaveProperty("viewportMode");
    await registry.disposeAll();
  });

  it("passes the embedded mode straight through to the provider", async () => {
    const { registry } = makeRegistry();
    const provider = new FakeProvider();
    await startWebMcpSession({
      url: "https://a.test/",
      provider,
      registry,
      viewportMode: "embedded",
    });
    expect(provider.createOptions[0].viewportMode).toBe("embedded");
    await registry.disposeAll();
  });

  it("passes the viewer's device pixel ratio through, and omits it otherwise", async () => {
    const { registry } = makeRegistry();
    const provider = new FakeProvider();
    await startWebMcpSession({ url: "https://a.test/", provider, registry });
    // Absent rather than 1: a provider that never heard of the field should
    // see a request that does not mention it.
    expect(provider.createOptions[0]).not.toHaveProperty("devicePixelRatio");

    await startWebMcpSession({
      url: "https://b.test/",
      provider,
      registry,
      devicePixelRatio: 2,
    });
    // The browser runs headless with no display to ask, so the only place this
    // number can come from is the viewer's own client.
    expect(provider.createOptions[1].devicePixelRatio).toBe(2);
    await registry.disposeAll();
  });
});
