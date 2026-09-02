/**
 * Re-hydration: the property that makes a hosted session survive a fleet with
 * no request affinity.
 *
 * Every test here uses TWO registries standing in for two replicas, because
 * one registry cannot express the failure this code exists to prevent — a
 * session created on A and asked for on B. The old behaviour was a 404 for a
 * browser that was running perfectly well.
 */
import { describe, expect, it, vi } from "vitest";
import {
  HostedDesktopAsleepError,
  resolveHostedSession,
} from "../hosted-session-resolver";
import {
  hostedSessionId,
  parseHostedSessionId,
  WebMcpSessionNotFoundError,
  WebMcpSessionRegistry,
} from "../session-registry";
import type { BrowserSessionHandle } from "../../browserd/browser-session";
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
  } as unknown as BrowserSessionHandle;
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
    ).rejects.toBeInstanceOf(HostedDesktopAsleepError);
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
    // Not even a status read on the hit path: it is a map lookup.
    expect(statusOf).toHaveBeenCalledTimes(1);
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
