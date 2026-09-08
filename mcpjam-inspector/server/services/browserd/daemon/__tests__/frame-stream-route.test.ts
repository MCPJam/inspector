/**
 * `GET /v1/frames` over a real socket.
 *
 * Loopback rather than a fake `ServerResponse`, because almost everything that
 * can go wrong with a streamed body is a property of the socket: whether the
 * headers flush before the first record, whether `server.close()` can complete
 * while a stream is open, whether a hangup unsubscribes. A hand-written double
 * would answer all of those the way the author expected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { connect } from "node:net";
import { EventEmitter } from "node:events";
import { createVideoEncoder } from "../video-encoder";
import { buildBrowserdStack, type BrowserdStack } from "../server";
import type { BrowserDriver } from "../browser-driver";
import type { BrowserCommandResult } from "../../protocol";
import type { TabViewport, ViewportFrame, ViewportListener } from "../viewport";
import { HandoffLease } from "../lease";
import {
  createFrameStreamDecoder,
  FRAME_STREAM_KIND,
  type FrameStreamRecord,
} from "../../frame-stream";

const TOKEN = "frames-token";

function jpegFrame(over: Partial<ViewportFrame> = {}): ViewportFrame {
  return {
    data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"),
    deviceWidth: 1024,
    deviceHeight: 768,
    scale: 1,
    ts: 1_700_000_000_000,
    seq: 1,
    ...over,
  };
}

/** A viewport whose frames the test publishes by hand. */
function fakeViewport() {
  const listeners = new Set<ViewportListener>();
  const counters = {
    framesIn: 0,
    framesOut: 0,
    bytesOut: 0,
    dropped: { dedupe: 0, oversize: 0, pacer: 0 },
  };
  const viewport: TabViewport = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscriberCount: () => listeners.size,
    dispatchInput: async () => {},
    boost: () => {},
    counters: () => ({ ...counters, dropped: { ...counters.dropped } }),
    noteTransportDrop: () => {
      counters.dropped.pacer += 1;
    },
    dispose: async () => {
      listeners.clear();
    },
  };
  return {
    viewport,
    publish: (frame: ViewportFrame) => {
      counters.framesIn += 1;
      counters.framesOut += 1;
      for (const listener of [...listeners]) listener(frame);
    },
    counters: () => counters,
    subscriberCount: () => listeners.size,
  };
}

function stubDriver(
  viewport: TabViewport | null | (() => TabViewport | null),
): BrowserDriver {
  const resolve = typeof viewport === "function" ? viewport : () => viewport;
  return {
    execute: async (): Promise<BrowserCommandResult> => ({
      ok: true,
      output: "ok",
      settled: true,
    }),
    currentStateToken: async () => undefined,
    health: async () => ({ ok: true }),
    close: async () => {},
    viewport: async () => resolve(),
  };
}

/**
 * A cursor over a live response.
 *
 * Reading and CLOSING are separate on purpose: several cases below need the
 * stream still open after they have read from it (the watcher cap, the hangup
 * test), and a helper that cancelled on its way out would quietly close the
 * very connections they are about. Nothing here reads to completion either —
 * these bodies do not end on their own, so awaiting the end would hang instead
 * of failing.
 */
function openCursor(res: Response, options: { video?: boolean } = {}) {
  const decoder = createFrameStreamDecoder(options);
  const reader = res.body!.getReader();
  const ready: FrameStreamRecord[] = [];

  async function next(timeoutMs = 4_000): Promise<FrameStreamRecord> {
    const deadline = Date.now() + timeoutMs;
    while (ready.length === 0) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("timed out waiting for a record");
      // RACED, not merely checked between reads. A deadline tested only in the
      // loop condition bounds nothing when the read itself never resolves —
      // which is exactly the regression these tests exist to catch, a daemon
      // that stops heartbeating. The suite would hang until vitest killed it
      // and report a generic timeout instead of naming the stream.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("timed out waiting for a record")),
            left,
          );
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (chunk.done) throw new Error("stream ended before a record arrived");
      const result = decoder.push(chunk.value);
      if (!result.ok) throw new Error(`decode failed: ${result.error}`);
      ready.push(...result.records);
    }
    return ready.shift()!;
  }

  return {
    next,
    async take(count: number, timeoutMs?: number) {
      const records: FrameStreamRecord[] = [];
      for (let i = 0; i < count; i += 1) records.push(await next(timeoutMs));
      return records;
    },
    /** Hang up, as a pane that was closed would. */
    cancel: () => reader.cancel().catch(() => {}),
  };
}

describe("GET /v1/frames", () => {
  let stack: BrowserdStack;
  let server: Server;
  let base: string;
  let vp: ReturnType<typeof fakeViewport>;
  let lease: HandoffLease;

  beforeEach(async () => {
    vp = fakeViewport();
    lease = new HandoffLease();
    stack = buildBrowserdStack(stubDriver(vp.viewport), {
      token: TOKEN,
      lease,
    });
    server = stack.server;
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    // Streams first, or this never resolves — which is the point of
    // `closeStreams` existing at all.
    stack.closeStreams();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const open = (query = "") =>
    fetch(`${base}/v1/frames${query}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

  it("refuses without the bearer, and refuses a browser outright", async () => {
    expect((await fetch(`${base}/v1/frames`)).status).toBe(401);
    // Any Origin at all is a browser talking to a daemon that only ever serves
    // servers — the rebinding defence, shared with every other route.
    const crossOrigin = await fetch(`${base}/v1/frames`, {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        origin: "https://evil.test",
      },
    });
    expect(crossOrigin.status).toBe(403);
  });

  it("answers 405 for a non-GET itself, rather than leaking a 404", async () => {
    // The route owns its own method contract; falling through to the handler's
    // catch-all would report "no such route" for a route that plainly exists.
    const res = await fetch(`${base}/v1/frames`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });

  it("does not let an unread body wedge the connection it arrived on", async () => {
    // A review flagged this branch as a slow-body hazard: it is taken on PATH,
    // so it bypasses the adapter's body reader and answers 405 without reading
    // the request — supposedly leaving the parser stuck and the connection
    // held by an unauthenticated caller.
    //
    // IT DOES NOT REPRODUCE, and this is the test that says so: it passes
    // identically with and without an added drain, because Node dumps an
    // unread request body itself once the RESPONSE finishes. Two pipelined
    // requests on one socket; the second is served, so the first was
    // completed. Kept as the pin on that property rather than deleted — the
    // day something here pauses the socket instead, this is what notices.
    //
    // The `req.resume()` further down is a different case and still load-
    // bearing: a streaming response never finishes, so Node's dump never
    // fires for it.
    const socket = connect(Number(new URL(base).port), "127.0.0.1");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const seen = new Promise<string>((resolve, reject) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if ((buffer.match(/HTTP\/1\.1 /g) ?? []).length >= 2) resolve(buffer);
      });
      socket.on("error", reject);
      timer = setTimeout(() => reject(new Error(`only got: ${buffer}`)), 4_000);
    });
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(
      `POST /v1/frames HTTP/1.1\r\nHost: x\r\n` +
        `Authorization: Bearer ${TOKEN}\r\nContent-Length: 4\r\n\r\nbody` +
        `GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
    );

    // Cleared and closed on EVERY path: a pending 4s timer holds the event
    // loop after the success case, and a socket left open on the failure case
    // is one `afterEach`'s `server.close()` then waits on.
    const replies = await seen.finally(() => {
      if (timer) clearTimeout(timer);
      socket.destroy();
    });
    expect(replies).toMatch(/HTTP\/1\.1 405/);
    expect(replies).toMatch(/HTTP\/1\.1 200/);
  });

  it("sends a heartbeat before anything has painted", async () => {
    // Until a record arrives, "the socket connected" and "the daemon
    // authorized me and subscribed" are indistinguishable — and on a static
    // page they stay that way indefinitely.
    const res = await open();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-length")).toBeNull();
    expect(res.headers.get("cache-control")).toContain("no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");

    const cursor = openCursor(res);
    expect(await cursor.next()).toEqual({ kind: FRAME_STREAM_KIND.heartbeat });
    await cursor.cancel();
  });

  it("streams a painted frame with its geometry intact", async () => {
    const cursor = openCursor(await open());
    expect(await cursor.next()).toEqual({ kind: FRAME_STREAM_KIND.heartbeat });
    await vi.waitFor(() => expect(vp.subscriberCount()).toBe(1));
    vp.publish(jpegFrame({ seq: 9, scale: 2, deviceWidth: 800 }));

    expect(await cursor.next()).toMatchObject({
      kind: FRAME_STREAM_KIND.frame,
      seq: 9,
      scale: 2,
      deviceWidth: 800,
      jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    });
    await cursor.cancel();
  });

  it("ends with a REASON when the lease moves, not just a dead socket", async () => {
    // The status code was spent when the headers went out, so "somebody took
    // control" has to arrive in-band. A pane that cannot tell this from a
    // network drop either reconnects into a refusal loop or gives up on a
    // browser that is fine.
    const cursor = openCursor(await open());
    await cursor.next(); // the opening heartbeat
    await vi.waitFor(() => expect(vp.subscriberCount()).toBe(1));

    lease.acquire("somebody-else");
    vp.publish(jpegFrame()); // the frame that trips the per-frame re-check

    expect(await cursor.next()).toEqual({
      kind: FRAME_STREAM_KIND.end,
      reason: "lease_held",
    });
  });

  it("refuses to start while somebody else holds the browser", async () => {
    lease.acquire("somebody-else");
    // Still a 200: the refusal is in the body, because by the time we know we
    // have to ask the lease we have already committed to a stream.
    const cursor = openCursor(await open());
    await cursor.next();
    expect(await cursor.next()).toEqual({
      kind: FRAME_STREAM_KIND.end,
      reason: "lease_held",
    });
  });

  it("says unknown_tab rather than hanging on a tab that is not there", async () => {
    stack.closeStreams();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    stack = buildBrowserdStack(stubDriver(null), { token: TOKEN });
    server = stack.server;
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const cursor = openCursor(await open());
    await cursor.next();
    expect(await cursor.next()).toEqual({
      kind: FRAME_STREAM_KIND.end,
      reason: "unknown_tab",
    });
  });

  it("unsubscribes when the reader hangs up", async () => {
    // Otherwise the screencast — and a JPEG encoder — keep running on a box the
    // agent is still using, for a pane nobody has open.
    const cursor = openCursor(await open());
    await cursor.next();
    await vi.waitFor(() => expect(vp.subscriberCount()).toBe(1));
    await cursor.cancel();
    await vi.waitFor(() => expect(vp.subscriberCount()).toBe(0));
  });

  it("caps concurrent watchers", async () => {
    const held = [];
    for (let i = 0; i < 4; i += 1) {
      const cursor = openCursor(await open());
      await cursor.next(); // held open: the cap counts live streams
      held.push(cursor);
    }
    const refused = await open();
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ error: "too_many_watchers" });
    await Promise.all(held.map((c) => c.cancel()));
  });

  it("closeStreams ends open streams so the server can actually close", async () => {
    // Without it `server.close()` waits on the connection forever — the hang
    // shows up first as a test suite that never finishes.
    const cursor = openCursor(await open());
    await cursor.next();
    await vi.waitFor(() => expect(vp.subscriberCount()).toBe(1));

    stack.closeStreams();
    expect(await cursor.next()).toEqual({
      kind: FRAME_STREAM_KIND.end,
      reason: "shutting_down",
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Re-listen so the shared afterEach has something to close.
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
  });

  it("evicts a watcher when the lease moves over a page that is NOT painting", async () => {
    // The hole this closes, and the reason the heartbeat exists at all.
    // `subscribeFrames` re-checks the lease on every FRAME, which is exactly
    // the wrong clock for a still page — and a still page is precisely when
    // somebody is reading it. With a one-way stream there is no client ping to
    // borrow, so the daemon has to ask on its own schedule or never ask.
    stack.closeStreams();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    lease = new HandoffLease();
    stack = buildBrowserdStack(stubDriver(vp.viewport), {
      token: TOKEN,
      lease,
      frames: { heartbeatMs: 25 },
    });
    server = stack.server;
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const cursor = openCursor(await open());
    await cursor.next();
    await vi.waitFor(() => expect(vp.subscriberCount()).toBe(1));

    lease.acquire("somebody-else");
    // NOT publishing a frame: that is the whole point.
    let last;
    for (let i = 0; i < 20; i += 1) {
      last = await cursor.next();
      if (last.kind === FRAME_STREAM_KIND.end) break;
    }
    expect(last).toEqual({ kind: FRAME_STREAM_KIND.end, reason: "lease_held" });
  });

  it("ends a stream whose tab went away, instead of looking merely quiet", async () => {
    // `TabViewport.dispose()` clears its listeners silently — no callback, no
    // terminal event — so a closed tab, a crashed renderer or a `driver.close()`
    // leaves a subscriber holding something that will never fire again. Over a
    // stream that is indistinguishable from a page nobody is touching.
    stack.closeStreams();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    let live: TabViewport | null = vp.viewport;
    stack = buildBrowserdStack(
      stubDriver(() => live),
      { token: TOKEN, frames: { heartbeatMs: 25 } },
    );
    server = stack.server;
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const cursor = openCursor(await open());
    await cursor.next();
    await vi.waitFor(() => expect(vp.subscriberCount()).toBe(1));

    // The tab is replaced by a different viewport, as a reopen would do.
    live = fakeViewport().viewport;
    let last;
    for (let i = 0; i < 20; i += 1) {
      last = await cursor.next();
      if (last.kind === FRAME_STREAM_KIND.end) break;
    }
    expect(last).toEqual({ kind: FRAME_STREAM_KIND.end, reason: "tab_gone" });
  });

  it("survives a driver that THROWS when asked whether the tab is still ours", async () => {
    // `stillCurrent()` asks the driver for the tab's viewport, and that throws
    // on ordinary paths: a closing context answers "this browser is shutting
    // down" rather than a value. Unhandled, the rejection did two things. The
    // tick never rescheduled, so the lease stopped being re-asked for the rest
    // of the stream — the privacy hole the heartbeat exists to close on a page
    // that does not paint. And an unhandled rejection ends a Node process, so
    // the thing that died was the daemon, with every hosted session on the box.
    stack.closeStreams();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    let live: TabViewport | null = vp.viewport;
    let throwOnResolve = false;
    const driver = stubDriver(() => live);
    stack = buildBrowserdStack(
      {
        ...driver,
        viewport: async () => {
          if (throwOnResolve) throw new Error("this browser is shutting down");
          return live;
        },
      },
      { token: TOKEN, frames: { heartbeatMs: 25 } },
    );
    server = stack.server;
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const cursor = openCursor(await open());
    await cursor.next();
    await vi.waitFor(() => expect(vp.subscriberCount()).toBe(1));

    throwOnResolve = true;
    let last;
    for (let i = 0; i < 20; i += 1) {
      last = await cursor.next();
      if (last.kind === FRAME_STREAM_KIND.end) break;
    }
    // Ended in band, saying why, rather than the process going down.
    expect(last).toEqual({ kind: FRAME_STREAM_KIND.end, reason: "tab_gone" });
    // And the subscription it held is released, not leaked behind a tick that
    // will never run again.
    await vi.waitFor(() => expect(vp.subscriberCount()).toBe(0));
  });
});

/**
 * `POST /v1/input` over the same socket.
 *
 * Its own describe because the gate being tested is the ROUTE, not the method
 * behind it. Every existing case called `handler.dispatchInput()` directly, so
 * the wiring between a public endpoint and the lease — the only part anyone
 * reaching this daemon actually touches — was unpinned: the event cap could be
 * deleted, or a 423 turned into a 200, and the suite stayed green.
 */
describe("POST /v1/input", () => {
  let stack: BrowserdStack;
  let server: Server;
  let base: string;
  let vp: ReturnType<typeof fakeViewport>;
  let lease: HandoffLease;

  beforeEach(async () => {
    vp = fakeViewport();
    lease = new HandoffLease();
    stack = buildBrowserdStack(stubDriver(vp.viewport), {
      token: TOKEN,
      lease,
    });
    server = stack.server;
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    stack.closeStreams();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/v1/input`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  const move = { type: "mouse_move", x: 1, y: 1 };

  it("refuses without the bearer, and refuses a browser outright", async () => {
    const noToken = await fetch(`${base}/v1/input`, {
      method: "POST",
      body: JSON.stringify({ holder: "rail-1", events: [move] }),
    });
    expect(noToken.status).toBe(401);
    // This route puts KEYSTROKES in the page. The rebinding defence matters
    // here more than anywhere: a page in someone's browser must never be able
    // to reach it.
    const fromBrowser = await post(
      { holder: "rail-1", events: [move] },
      { origin: "https://evil.test" },
    );
    expect(fromBrowser.status).toBe(403);
  });

  it("refuses input from someone who does not hold the lease", async () => {
    lease.acquire("rail-1", 60_000);
    const res = await post({ holder: "rail-2", events: [move] });
    expect(res.status).toBe(423);
    expect(await res.json()).toMatchObject({ error: expect.any(String) });
  });

  it("refuses input when NOBODY holds the lease", async () => {
    // Taking control is explicit. Input that arrives without it is the agent's
    // page being typed into by a caller with no claim to it.
    const res = await post({ holder: "rail-1", events: [move] });
    expect(res.status).toBe(423);
  });

  it("accepts input from the holder", async () => {
    lease.acquire("rail-1", 60_000);
    const res = await post({ holder: "rail-1", events: [move] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("caps the batch at the daemon, not only at the caller", async () => {
    // The daemon is reachable on its own public host, so a cap that lives only
    // in the inspector is a cap that is skipped by talking to the daemon.
    lease.acquire("rail-1", 60_000);
    const res = await post({
      holder: "rail-1",
      events: Array.from({ length: 65 }, () => move),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: "too_many_events" });
  });

  it("takes a batch exactly at the cap", async () => {
    lease.acquire("rail-1", 60_000);
    const res = await post({
      holder: "rail-1",
      events: Array.from({ length: 64 }, () => move),
    });
    expect(res.status).toBe(200);
  });

  it("answers a malformed body rather than throwing", async () => {
    lease.acquire("rail-1", 60_000);
    expect((await post("{not json")).status).toBe(400);
    expect((await post([1, 2, 3])).status).toBe(400);
    expect((await post({ events: [move] })).status).toBe(400);
    expect((await post({ holder: "rail-1" })).status).toBe(400);
    expect((await post({ holder: "", events: [move] })).status).toBe(400);
  });
});

describe("GET /v1/frames — the rest", () => {
  let stack: BrowserdStack;
  let server: Server;
  let base: string;
  let vp: ReturnType<typeof fakeViewport>;

  beforeEach(async () => {
    vp = fakeViewport();
    stack = buildBrowserdStack(stubDriver(vp.viewport), { token: TOKEN });
    server = stack.server;
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    stack.closeStreams();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const open = (query = "") =>
    fetch(`${base}/v1/frames${query}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

  it("frees a cap slot when a watcher leaves, rather than 503ing forever", async () => {
    // The cap test next door opened four and asserted the fifth was refused,
    // which passes just as well when the slot is never released — the failure
    // that turns a full pane into a permanently dead endpoint. This reopens.
    const cursors = [];
    for (let i = 0; i < 4; i += 1) {
      const res = await open();
      expect(res.status).toBe(200);
      cursors.push(openCursor(res));
    }
    expect((await open()).status).toBe(503);

    await cursors[0]!.cancel();
    await vi.waitFor(async () => {
      const retry = await open();
      expect(retry.status).toBe(200);
      await retry.body?.cancel();
    });

    for (const cursor of cursors.slice(1)) await cursor.cancel();
  });

  it("probe mode answers without a lease, a tab or a browser", async () => {
    // The one thing this repository cannot prove is whether the sandbox edge
    // streams a chunked body or buffers it. This is how that gets answered on
    // staging, with curl and nothing else.
    const cursor = openCursor(await open("?probe=1"));
    // One heartbeat on open, then the probe's own three, then the end.
    const records = await cursor.take(5, 8_000);
    expect(
      records.slice(0, 4).every((r) => r.kind === FRAME_STREAM_KIND.heartbeat),
    ).toBe(true);
    expect(records[4]).toMatchObject({ kind: FRAME_STREAM_KIND.end });
    // Probe mode never touches the browser: no lease, no tab, no subscription.
    expect(vp.subscriberCount()).toBe(0);
  });
});


/**
 * V-4a. The daemon's own counters ride the heartbeat, and the pacer's
 * overwrite — the third silent drop path — is attributed to the viewport that
 * produced the frame, so ONE number describes the whole way out of the box.
 */
describe("GET /v1/frames — the daemon's own accounting", () => {
  let stack: BrowserdStack;
  let server: Server;
  let base: string;
  let vp: ReturnType<typeof fakeViewport>;

  beforeEach(async () => {
    vp = fakeViewport();
    stack = buildBrowserdStack(stubDriver(vp.viewport), {
      token: TOKEN,
      lease: new HandoffLease(),
      frames: { heartbeatMs: 30 },
    });
    server = stack.server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    stack.closeStreams();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("carries the viewport's counters on every heartbeat but the first", async () => {
    const res = await fetch(`${base}/v1/frames`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const cursor = openCursor(res);
    // The opening heartbeat is written before there is a subscription to count.
    expect(await cursor.next()).toEqual({ kind: FRAME_STREAM_KIND.heartbeat });

    vp.publish({
      data: "Zm9v",
      deviceWidth: 1024,
      deviceHeight: 768,
      scale: 1,
      ts: 1,
      seq: 1,
    });
    // Frame, then the first counted heartbeat.
    let record = await cursor.next();
    while (record.kind !== FRAME_STREAM_KIND.heartbeat) {
      record = await cursor.next();
    }
    expect(record.stats).toMatchObject({ framesIn: 1, framesOut: 1 });
    expect(record.stats?.dropped).toEqual({
      dedupe: 0,
      oversize: 0,
      pacer: 0,
    });
    expect(record.stats?.subscribers).toBe(1);
    await cursor.cancel();
  });

  it("attributes a pacer overwrite to the viewport that produced the frame", async () => {
    // The pacer holds ONE frame and the newest wins; the overwrite is the
    // third silent drop path, and counting it here is what makes one number
    // cover the whole way out of the box.
    const res = await fetch(`${base}/v1/frames`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const cursor = openCursor(res);
    expect(await cursor.next()).toEqual({ kind: FRAME_STREAM_KIND.heartbeat });

    // Three in one tick: the first ships, the second is held, the third
    // replaces it — one drop, before any write callback can have fired.
    for (let seq = 1; seq <= 3; seq += 1) {
      vp.publish({
        data: "Zm9v",
        deviceWidth: 1024,
        deviceHeight: 768,
        scale: 1,
        ts: seq,
        seq,
      });
    }
    await vi.waitFor(() =>
      expect(vp.counters().dropped.pacer).toBeGreaterThan(0),
    );
    await cursor.cancel();
  });

  it("says the encoder is idle rather than letting silence read as loss", async () => {
    // An adaptive client that read a quiet page as packet loss would step the
    // quality down on a page that is simply not moving.
    const res = await fetch(`${base}/v1/frames`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const cursor = openCursor(res);
    const beats: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 4; i += 1) {
      const record = await cursor.next();
      if (record.kind === FRAME_STREAM_KIND.heartbeat && record.stats) {
        beats.push(record.stats as Record<string, unknown>);
      }
    }
    // The FIRST counted beat has no previous count to compare against and
    // claims neither answer; the ones after it say idle.
    expect(beats.length).toBeGreaterThan(1);
    expect(beats[0]?.encoderIdle).toBeUndefined();
    expect(beats[1]?.encoderIdle).toBe(true);
    await cursor.cancel();
  });
});


/**
 * V-5. `?codec=h264` is a different stream on the same route: its pixels come
 * from the display encoder, its version is negotiated so a reader that never
 * asked can never be handed one, and its lease gate is per subscriber even
 * though the encoder is shared.
 */
describe("GET /v1/frames?codec=h264", () => {
  let stack: BrowserdStack;
  let server: Server;
  let base: string;
  let lease: HandoffLease;
  let ffmpeg: ReturnType<typeof fakeEncoderProcess>;

  /** A stand-in for ffmpeg, so no box needs one. */
  function fakeEncoderProcess() {
    const stdout = new EventEmitter();
    const events = new EventEmitter();
    let killed = false;
    return {
      stdout,
      events,
      killed: () => killed,
      spawnProcess: (() => ({
        stdout: { on: (e: string, fn: never) => stdout.on(e, fn) },
        stderr: { on: () => {} },
        on: (e: string, fn: never) => events.on(e, fn),
        kill: () => {
          killed = true;
          return true;
        },
      })) as never,
    };
  }

  function annexB(...nalTypes: number[]): Uint8Array {
    const bytes: number[] = [0, 0, 0, 1, 9, 0x10];
    for (const type of nalTypes) bytes.push(0, 0, 1, type, 0xab, 0xcd);
    return new Uint8Array(bytes);
  }

  async function listen(over: { video?: boolean } = {}) {
    lease = new HandoffLease();
    ffmpeg = fakeEncoderProcess();
    stack = buildBrowserdStack(stubDriver(fakeViewport().viewport), {
      token: TOKEN,
      lease,
      frames: { heartbeatMs: 30 },
      ...(over.video === false
        ? {}
        : {
            video: createVideoEncoder({
              display: ":0",
              width: 1024,
              height: 768,
              spawnProcess: ffmpeg.spawnProcess,
            }),
            displaySize: { width: 1024, height: 768 },
          }),
    });
    server = stack.server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  afterEach(async () => {
    stack.closeStreams();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const openVideo = (query = "") =>
    fetch(`${base}/v1/frames?codec=h264${query}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

  it("carries access units the daemon's own decoder can read", async () => {
    await listen();
    const res = await openVideo();
    // The reader has to be told it asked for video: an unknown kind is fatal
    // by design, which is exactly what protects a reader that did not ask.
    const cursor = openCursor(res, { video: true });
    expect(await cursor.next()).toEqual({ kind: FRAME_STREAM_KIND.heartbeat });

    ffmpeg.stdout.emit(
      "data",
      Buffer.from(
        new Uint8Array([...annexB(7, 8, 5), ...annexB(1), ...annexB(1)]),
      ),
    );
    const key = await cursor.next();
    expect(key).toMatchObject({
      kind: FRAME_STREAM_KIND.video_key,
      deviceWidth: 1024,
      deviceHeight: 768,
      scale: 1,
    });
    const delta = await cursor.next();
    expect(delta.kind).toBe(FRAME_STREAM_KIND.video_delta);
    await cursor.cancel();
  });

  it("is refused by a reader that never asked for video", async () => {
    // The whole reason the video records declare their own version: an old
    // reader and a new daemon must never meet on a wire either can misread.
    await listen();
    const res = await openVideo();
    const cursor = openCursor(res);
    expect(await cursor.next()).toEqual({ kind: FRAME_STREAM_KIND.heartbeat });
    ffmpeg.stdout.emit(
      "data",
      Buffer.from(new Uint8Array([...annexB(7, 8, 5), ...annexB(1)])),
    );
    await expect(cursor.next()).rejects.toThrow(/unsupported version/);
    await cursor.cancel();
  });

  it("answers video_unavailable on a box with no encoder", async () => {
    // No ffmpeg on the image, or the operator turned it off. The watcher falls
    // back to JPEG rather than seeing an error.
    await listen({ video: false });
    const cursor = openCursor(await openVideo(), { video: true });
    expect(await cursor.next()).toEqual({ kind: FRAME_STREAM_KIND.heartbeat });
    expect(await cursor.next()).toEqual({
      kind: FRAME_STREAM_KIND.end,
      reason: "video_unavailable",
    });
  });

  it("ends ONE subscriber's stream when the lease moves, and keeps encoding", async () => {
    // One encoder, a gate per subscriber: an end reason is about who may look,
    // not about who is encoding.
    await listen();
    const watcher = openCursor(await openVideo(), { video: true });
    const holder = openCursor(await openVideo("&holder=alice"), {
      video: true,
    });
    await watcher.next();
    await holder.next();

    lease.acquire("alice");
    // The watcher is evicted on the next heartbeat.
    let record = await watcher.next();
    while (record.kind !== FRAME_STREAM_KIND.end) record = await watcher.next();
    expect(record.reason).toBe("lease_held");

    // The holder's own stream keeps going, and the encoder was never stopped.
    ffmpeg.stdout.emit(
      "data",
      Buffer.from(new Uint8Array([...annexB(7, 8, 5), ...annexB(1)])),
    );
    let next = await holder.next();
    while (next.kind === FRAME_STREAM_KIND.heartbeat) next = await holder.next();
    expect(next.kind).toBe(FRAME_STREAM_KIND.video_key);
    expect(ffmpeg.killed()).toBe(false);
    await holder.cancel();
  });

  it("says whether the encoder is idle, so silence is not read as loss", async () => {
    await listen();
    const cursor = openCursor(await openVideo(), { video: true });
    await cursor.next();
    let beats = 0;
    let sawIdle = false;
    while (beats < 3) {
      const record = await cursor.next();
      if (record.kind !== FRAME_STREAM_KIND.heartbeat) continue;
      beats += 1;
      if (record.stats?.encoderIdle === true) sawIdle = true;
    }
    expect(sawIdle).toBe(true);
    await cursor.cancel();
  });

  it("ends the stream when the encoder dies mid-watch", async () => {
    await listen();
    const cursor = openCursor(await openVideo(), { video: true });
    await cursor.next();
    ffmpeg.events.emit("exit", 1);
    let record = await cursor.next();
    while (record.kind !== FRAME_STREAM_KIND.end) record = await cursor.next();
    expect(record.reason).toBe("video_unavailable");
  });
});
