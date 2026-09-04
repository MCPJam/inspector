/**
 * Re-hydration: the property that makes a hosted session survive a fleet with
 * no request affinity.
 *
 * The scenario is a session created on replica A and asked for on replica B.
 * B is what these tests build: a registry that starts EMPTY, standing in for
 * the replica that never saw the session. A does not need to be constructed at
 * all — nothing of A's reaches B except the session id, which is the point.
 * The old behaviour was a 404 for a browser that was running perfectly well.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCESS_RECHECK_MS,
  HostedDesktopUnavailableError,
  MAX_TRACKED_ACCESS_SESSIONS,
  noteAccessProved,
  trackedAccessCountForTests,
  resetAccessRecheckForTests,
  resolveHostedSession,
} from "../hosted-session-resolver";
import {
  hostedSessionId,
  parseHostedSessionId,
  WebMcpSessionNotFoundError,
  WebMcpSessionRegistry,
} from "../session-registry";
import type { HostedBrowserSessionHandle } from "../../browserd/browser-session";
import type { BrowserCommand } from "../../browserd/protocol";

const PROJECT = "proj-1";
const COMPUTER = "comp-1";
const OWNER = "user-1";
const SESSION_ID = hostedSessionId(PROJECT, COMPUTER);

/** A daemon that reports one page and one tool on it. */
function fakeDaemon(
  tools = [{ frameId: "f1", name: "checkout", origin: "https://shop.test" }],
) {
  const commands: BrowserCommand[] = [];
  const sendCommand = vi.fn(async (command: BrowserCommand) => {
    commands.push(command);
    const action = command.action as { kind: string; mode?: string };
    if (action.kind === "observe" && action.mode === "webmcp_tools") {
      return {
        status: "ok",
        result: { ok: true, output: { tools } },
        bootId: "b",
      };
    }
    if (action.kind === "observe" && action.mode === "url") {
      return {
        status: "ok",
        result: { ok: true, output: { url: "https://shop.test/cart" } },
        bootId: "b",
      };
    }
    return { status: "ok", result: { ok: true, output: {} }, bootId: "b" };
  });
  const handle = {
    sessionId: "browser-session-1",
    computerId: COMPUTER,
    bootId: "b",
    client: { sendCommand },
    streamUrl: "https://stream.test/vnc.html",
    streamPassword: "hunter2",
    contextMode: "persistent",
    reused: true,
  } as unknown as HostedBrowserSessionHandle;
  return { handle, commands, sendCommand };
}

function deps(
  overrides: Partial<Parameters<typeof resolveHostedSession>[0]["deps"]> = {},
) {
  const daemon = fakeDaemon();
  const attach = vi.fn(async () => daemon.handle);
  const statusOf = vi.fn(async () => ({
    computerId: COMPUTER,
    status: "ready",
  }));
  return {
    daemon,
    attach,
    statusOf,
    deps: { attach, statusOf, toolPollMs: 0, ...overrides },
  };
}

// The access-recheck throttle is module state, so it outlives a test.
beforeEach(() => resetAccessRecheckForTests());

describe("resolveHostedSession", () => {
  it("re-hydrates onto a replica that never saw the session", async () => {
    const replicaB = new WebMcpSessionRegistry({ sweepIntervalMs: 0 });
    const { deps: d, attach } = deps();

    const runtime = await resolveHostedSession({
      sessionId: SESSION_ID,
      bearer: "bearer",
      ownerId: OWNER,
      registry: replicaB,
      deps: d,
    });

    expect(runtime.sessionId).toBe(SESSION_ID);
    expect(attach).toHaveBeenCalledWith({ computerId: COMPUTER });
    // Registered, so the NEXT request on this replica is a map hit.
    expect(replicaB.peek(SESSION_ID)).toBe(runtime);
  });

  it("serves an invoke for a tool only the other replica had listed", async () => {
    // The reason the first tool snapshot is awaited before registering.
    // Invocations resolve their toolKey against the runtime's own map at
    // dequeue, so a runtime registered with an empty map answers "the page no
    // longer offers that" for a tool the user is looking at on their screen.
    const replicaB = new WebMcpSessionRegistry({ sweepIntervalMs: 0 });
    const { deps: d } = deps();

    const runtime = await resolveHostedSession({
      sessionId: SESSION_ID,
      bearer: "bearer",
      ownerId: OWNER,
      registry: replicaB,
      deps: d,
    });

    expect(runtime.currentTools().map((t) => t.name)).toEqual(["checkout"]);
    const { settled } = runtime.invoke(
      "https://shop.test::checkout",
      {},
      "manual",
    );
    await expect(settled).resolves.toBeDefined();
  });

  it("adopts the page the browser is on rather than navigating it", async () => {
    // Someone may be mid-checkout. Re-hydration happens on every replica that
    // ever serves a request, so navigating here would reload the page under
    // them, repeatedly.
    const replicaB = new WebMcpSessionRegistry({ sweepIntervalMs: 0 });
    const { deps: d, daemon } = deps();

    const runtime = await resolveHostedSession({
      sessionId: SESSION_ID,
      bearer: "bearer",
      ownerId: OWNER,
      registry: replicaB,
      deps: d,
    });

    expect(
      daemon.commands.some(
        (c) => (c.action as { kind: string }).kind === "navigate",
      ),
    ).toBe(false);
    expect(runtime.toPublic().url).toBe("https://shop.test/cart");
  });

  it("does not replay a second 'session started' into an existing timeline", async () => {
    const replicaB = new WebMcpSessionRegistry({ sweepIntervalMs: 0 });
    const { deps: d } = deps();
    const runtime = await resolveHostedSession({
      sessionId: SESSION_ID,
      bearer: "bearer",
      ownerId: OWNER,
      registry: replicaB,
      deps: d,
    });

    const seen: string[] = [];
    runtime.hub.subscribe((event) => {
      if (event.type === "activity") seen.push(event.entry.kind);
    }, 200);
    // A positive assertion first: without it, a replay that stopped arriving
    // at all would leave `seen` empty and the real check below would pass
    // having observed nothing.
    expect(seen).toContain("tools_added");
    expect(seen).not.toContain("session_started");
  });

  it("refuses a session id whose computer the caller does not own — as a 404", async () => {
    const replicaB = new WebMcpSessionRegistry({ sweepIntervalMs: 0 });
    const { deps: d, attach } = deps({
      // The control plane resolved a DIFFERENT computer from this caller's
      // bearer, so the id in the URL is not theirs.
      statusOf: vi.fn(async () => ({
        computerId: "somebody-elses-box",
        status: "ready",
      })),
    });

    await expect(
      resolveHostedSession({
        sessionId: SESSION_ID,
        bearer: "bearer",
        ownerId: OWNER,
        registry: replicaB,
        deps: d,
      }),
      // Not-found, never forbidden: a 403 would confirm the session exists.
    ).rejects.toBeInstanceOf(WebMcpSessionNotFoundError);
    expect(attach).not.toHaveBeenCalled();
  });

  it("refuses a live runtime that belongs to someone else", async () => {
    const replica = new WebMcpSessionRegistry({ sweepIntervalMs: 0 });
    const { deps: d } = deps();
    await resolveHostedSession({
      sessionId: SESSION_ID,
      bearer: "bearer",
      ownerId: OWNER,
      registry: replica,
      deps: d,
    });

    await expect(
      resolveHostedSession({
        sessionId: SESSION_ID,
        bearer: "other-bearer",
        ownerId: "intruder",
        registry: replica,
        deps: d,
      }),
    ).rejects.toBeInstanceOf(WebMcpSessionNotFoundError);
  });

  it("reports an asleep computer WITHOUT waking or attaching to it", async () => {
    // The whole reason this path may not reserve: it is reached from reads —
    // a page refresh, a reconnecting stream — and waking bills for a machine
    // its owner deliberately let sleep.
    const replicaB = new WebMcpSessionRegistry({ sweepIntervalMs: 0 });
    const { deps: d, attach } = deps({
      statusOf: vi.fn(async () => ({
        computerId: COMPUTER,
        status: "hibernating",
      })),
    });

    await expect(
      resolveHostedSession({
        sessionId: SESSION_ID,
        bearer: "bearer",
        ownerId: OWNER,
        registry: replicaB,
        deps: d,
      }),
    ).rejects.toBeInstanceOf(HostedDesktopUnavailableError);
    expect(attach).not.toHaveBeenCalled();
  });

  it("returns the live runtime without re-attaching when this replica has it", async () => {
    const replica = new WebMcpSessionRegistry({ sweepIntervalMs: 0 });
    const { deps: d, attach, statusOf } = deps();

    const first = await resolveHostedSession({
      sessionId: SESSION_ID,
      bearer: "bearer",
      ownerId: OWNER,
      registry: replica,
      deps: d,
    });
    const second = await resolveHostedSession({
      sessionId: SESSION_ID,
      bearer: "bearer",
      ownerId: OWNER,
      registry: replica,
      deps: d,
    });

    expect(second).toBe(first);
    expect(attach).toHaveBeenCalledTimes(1);
    // No second status read either. The hit path DOES re-prove access, but on
    // a throttle, and the re-hydration that just ran counts as the proof — so
    // the reconnect that always follows it is a map lookup and nothing more.
    expect(statusOf).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent rechecks, so neither request rides past a pending one", async () => {
    // The timestamp is recorded BEFORE the control plane answers — that is what
    // makes the throttle cheap. On its own it is also a hole: a second request
    // arriving mid-check sees a fresh timestamp, skips the check, and is served
    // from a runtime whose ownership is at that moment being disproved.
    let clock = 1_000;
    let release!: (
      value: { computerId: string; status: string } | null,
    ) => void;
    const replica = new WebMcpSessionRegistry({ sweepIntervalMs: 0 });
    const { deps: d, statusOf } = deps();
    const call = () =>
      resolveHostedSession({
        sessionId: SESSION_ID,
        bearer: "bearer",
        ownerId: OWNER,
        registry: replica,
        deps: { ...d, now: () => clock },
      });

    await call();
    clock += ACCESS_RECHECK_MS * 2;
    statusOf.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)) as never,
    );

    // Two requests, one check. The second must wait for it rather than pass.
    const first = call();
    const second = call();
    await Promise.resolve();
    expect(statusOf).toHaveBeenCalledTimes(2); // the re-hydration + this one

    release(null); // the computer is no longer theirs
    await expect(first).rejects.toBeInstanceOf(WebMcpSessionNotFoundError);
    await expect(second).rejects.toBeInstanceOf(WebMcpSessionNotFoundError);
  });

  it("stops serving a live runtime whose computer went to sleep under it", async () => {
    // Ownership can hold while the machine does not. Serving the stale handle
    // queues commands against a daemon that is not there.
    let clock = 1_000;
    const replica = new WebMcpSessionRegistry({ sweepIntervalMs: 0 });
    const { deps: d, statusOf } = deps();
    const call = () =>
      resolveHostedSession({
        sessionId: SESSION_ID,
        bearer: "bearer",
        ownerId: OWNER,
        registry: replica,
        deps: { ...d, now: () => clock },
      });

    await call();
    clock += ACCESS_RECHECK_MS * 2;
    statusOf.mockResolvedValueOnce({
      computerId: COMPUTER,
      status: "hibernating",
    } as never);
    await expect(call()).rejects.toBeInstanceOf(HostedDesktopUnavailableError);
    expect(replica.peek(SESSION_ID)).toBeUndefined();
  });

  it("tells someone to WAIT for a computer that is still coming up", async () => {
    // "Open the browser again to wake it" is wrong advice for a machine that
    // is already provisioning — including the `requested` status, which is the
    // first thing the control plane reports.
    const replica = new WebMcpSessionRegistry({ sweepIntervalMs: 0 });
    const { deps: d } = deps({
      statusOf: vi.fn(async () => ({
        computerId: COMPUTER,
        status: "requested",
      })),
    });
    await expect(
      resolveHostedSession({
        sessionId: SESSION_ID,
        bearer: "bearer",
        ownerId: OWNER,
        registry: replica,
        deps: d,
      }),
    ).rejects.toMatchObject({ code: "hosted-desktop-starting" });
  });

  it("re-proves project access on the hit path, and stops serving when it fails", async () => {
    // The owner id is recorded when the session is created, and access can be
    // taken away afterwards. Checked against that id alone, somebody removed
    // from a project keeps driving its browser until the runtime is evicted.
    let clock = 1_000;
    const replica = new WebMcpSessionRegistry({ sweepIntervalMs: 0 });
    const { deps: d, statusOf } = deps();
    const call = () =>
      resolveHostedSession({
        sessionId: SESSION_ID,
        bearer: "bearer",
        ownerId: OWNER,
        registry: replica,
        deps: { ...d, now: () => clock },
      });

    await call();
    // Inside the throttle window nothing is re-asked.
    clock += ACCESS_RECHECK_MS - 1;
    await call();
    expect(statusOf).toHaveBeenCalledTimes(1);

    // Past it, access is re-proved — and this time the control plane does not
    // return their computer, because it is not theirs any more.
    clock += ACCESS_RECHECK_MS;
    statusOf.mockResolvedValueOnce(null as never);
    await expect(call()).rejects.toBeInstanceOf(WebMcpSessionNotFoundError);

    // And the handle is gone, so the next request cannot ride the window.
    expect(replica.peek(SESSION_ID)).toBeUndefined();
  });
});

describe("hosted session ids", () => {
  it("round-trips, and is derived from what any replica can see", () => {
    expect(parseHostedSessionId(hostedSessionId("p", "c"))).toEqual({
      projectId: "p",
      computerId: "c",
    });
  });

  it("rejects anything that is not exactly one", () => {
    for (const bad of [
      "random-uuid",
      "hosted:",
      "hosted:only-one",
      "hosted:a:b:c",
      "",
    ]) {
      expect(parseHostedSessionId(bad)).toBeNull();
    }
  });
});

describe("what the replica remembers checking is bounded", () => {
  it("does not let a proved access grow the map past its cap", () => {
    // `noteAccessProved` records a session the CREATING replica already
    // authorized, so it fires once per hosted start — the one write path that
    // produces an entry for a session id never seen before. Writing the key
    // directly made it the way around the cap the recheck path respects, so
    // the bound held for the reader and not for the writer that grows it.
    const now = 10_000;
    for (let i = 0; i < MAX_TRACKED_ACCESS_SESSIONS + 500; i += 1) {
      noteAccessProved(hostedSessionId("p", `comp-${i}`), now);
    }
    expect(trackedAccessCountForTests()).toBe(MAX_TRACKED_ACCESS_SESSIONS);
  });

  it("evicts only entries already past their window", () => {
    // Everything inside its window is a check that has not been made yet.
    // Dropping one to make room is how a rotating set of ids skips the check
    // entirely — so a full map declines to record instead, and that session is
    // rechecked next command. More round trips, never fewer checks.
    const early = 10_000;
    for (let i = 0; i < MAX_TRACKED_ACCESS_SESSIONS; i += 1) {
      noteAccessProved(hostedSessionId("p", `comp-${i}`), early);
    }
    // A newcomer while every entry is still live: refused a slot, nothing
    // evicted to make one.
    noteAccessProved(hostedSessionId("p", "newcomer"), early + 1);
    expect(trackedAccessCountForTests()).toBe(MAX_TRACKED_ACCESS_SESSIONS);

    // Once the incumbents expire, the same newcomer is admitted.
    noteAccessProved(
      hostedSessionId("p", "newcomer"),
      early + ACCESS_RECHECK_MS * 2,
    );
    expect(trackedAccessCountForTests()).toBeLessThan(
      MAX_TRACKED_ACCESS_SESSIONS,
    );
  });
});
