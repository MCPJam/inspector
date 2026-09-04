/**
 * `BrowserdClient.streamFrames` — reading the daemon's frame stream.
 *
 * Driven entirely through the injected `fetchImpl`, which is the seam the rest
 * of this client already uses: a fake `Response` wrapping a `ReadableStream`
 * lets the chunk boundaries, the terminal record and the abort paths all be
 * driven exactly, none of which a real socket would let a test control.
 */
import { describe, expect, it, vi } from "vitest";
import { BrowserdClient } from "../browserd-client";
import {
  encodeFrameStreamRecord,
  FRAME_STREAM_KIND,
  type FrameStreamFrame,
} from "../frame-stream";

function frameBytes(over: Partial<FrameStreamFrame> = {}): Uint8Array {
  return encodeFrameStreamRecord({
    kind: FRAME_STREAM_KIND.frame,
    deviceWidth: 1024,
    deviceHeight: 768,
    scale: 1,
    ts: 1,
    seq: 1,
    jpeg: new Uint8Array([1, 2, 3]),
    ...over,
  });
}

/** A response whose body the test pushes into by hand. */
function pushableResponse(status = 200) {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(stream, { status }),
    push: (bytes: Uint8Array) => controller!.enqueue(bytes),
    finish: () => controller!.close(),
  };
}

function clientFor(
  fetchImpl: typeof fetch,
  over: { timeoutMs?: number } = {},
): BrowserdClient {
  return new BrowserdClient({
    baseUrl: "https://box.example",
    bearer: "secret",
    fetchImpl,
    ...over,
  });
}

/** Collect what a stream delivered, resolving when it ends. */
function collector() {
  const frames: FrameStreamFrame[] = [];
  let settle: (reason: string | undefined) => void;
  const ended = new Promise<string | undefined>((resolve) => {
    settle = resolve;
  });
  return {
    frames,
    ended,
    onFrame: (f: FrameStreamFrame) => frames.push(f),
    onEnd: (reason: string | undefined) => settle(reason),
  };
}

describe("streamFrames", () => {
  it("presents the bearer and the tab it wants", async () => {
    const fetchImpl = vi.fn(async () => pushableResponse().response);
    const sink = collector();
    await clientFor(fetchImpl as unknown as typeof fetch).streamFrames({
      tabId: "tab-2",
      holder: "users_1",
      signal: new AbortController().signal,
      ...sink,
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://box.example/v1/frames?tabId=tab-2&holder=users_1");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret");
  });

  it("hands back frames as they arrive", async () => {
    const body = pushableResponse();
    const sink = collector();
    const started = await clientFor(
      (async () => body.response) as unknown as typeof fetch,
    ).streamFrames({ signal: new AbortController().signal, ...sink });
    expect(started).toEqual({ ok: true });

    body.push(frameBytes({ seq: 1 }));
    body.push(frameBytes({ seq: 2 }));
    await vi.waitFor(() => expect(sink.frames).toHaveLength(2));
    expect(sink.frames.map((f) => f.seq)).toEqual([1, 2]);
    body.finish();
    await sink.ended;
  });

  it("reassembles a frame split across chunks", async () => {
    // The case that always happens with a real JPEG and never happens in a
    // test that pushes whole records.
    const bytes = frameBytes({ jpeg: new Uint8Array(4_000).fill(7) });
    const body = pushableResponse();
    const sink = collector();
    await clientFor(
      (async () => body.response) as unknown as typeof fetch,
    ).streamFrames({ signal: new AbortController().signal, ...sink });

    body.push(bytes.slice(0, 900));
    body.push(bytes.slice(900, 2_500));
    body.push(bytes.slice(2_500));
    await vi.waitFor(() => expect(sink.frames).toHaveLength(1));
    expect(sink.frames[0].jpeg.byteLength).toBe(4_000);
    body.finish();
    await sink.ended;
  });

  it("reports an EXPLAINED end distinctly from a drop", async () => {
    // The whole reason the daemon writes a terminal record: a pane must tell
    // "somebody took control" (wait, then resume) from "the link died"
    // (reconnect). The status code is long gone by then.
    const explained = pushableResponse();
    const a = collector();
    await clientFor(
      (async () => explained.response) as unknown as typeof fetch,
    ).streamFrames({ signal: new AbortController().signal, ...a });
    explained.push(
      encodeFrameStreamRecord({
        kind: FRAME_STREAM_KIND.end,
        reason: "lease_held",
      }),
    );
    expect(await a.ended).toBe("lease_held");

    const dropped = pushableResponse();
    const b = collector();
    await clientFor(
      (async () => dropped.response) as unknown as typeof fetch,
    ).streamFrames({ signal: new AbortController().signal, ...b });
    dropped.push(frameBytes());
    dropped.finish(); // ends without saying why
    expect(await b.ended).toBeUndefined();
  });

  it("drops the stream when the bytes stop making sense", async () => {
    const bytes = frameBytes();
    new DataView(bytes.buffer).setUint8(0, 9); // an impossible version
    const body = pushableResponse();
    const sink = collector();
    await clientFor(
      (async () => body.response) as unknown as typeof fetch,
    ).streamFrames({ signal: new AbortController().signal, ...sink });
    body.push(bytes);
    // Unexplained, correctly: corruption is not a reason the daemon gave.
    expect(await sink.ended).toBeUndefined();
  });

  it("stops when the caller aborts", async () => {
    const body = pushableResponse();
    const sink = collector();
    const abort = new AbortController();
    await clientFor(
      (async () => body.response) as unknown as typeof fetch,
    ).streamFrames({ signal: abort.signal, ...sink });
    abort.abort();
    expect(await sink.ended).toBeUndefined();
  });

  it("surfaces a refusal instead of pretending to stream", async () => {
    const refused = clientFor(
      (async () => new Response("no", { status: 423 })) as unknown as typeof fetch,
    );
    const sink = collector();
    expect(
      await refused.streamFrames({
        signal: new AbortController().signal,
        ...sink,
      }),
    ).toMatchObject({ ok: false, status: 423 });
  });

  it("SURVIVES PAST THE CLIENT'S REQUEST TIMEOUT", async () => {
    // The bug this locks out. `AbortSignal.timeout` stays attached to a
    // streamed body, so a stream routed through the ordinary `request()` helper
    // dies exactly `timeoutMs` after it opened — forever, silently, and only
    // under a real socket. A client built with a 40ms timeout must still be
    // delivering frames well after that.
    const body = pushableResponse();
    const sink = collector();
    const client = clientFor(
      (async (_url: string, init: RequestInit) => {
        // Faithful to undici: whatever signal the caller attached governs.
        init.signal?.addEventListener("abort", () => body.finish());
        return body.response;
      }) as unknown as typeof fetch,
      { timeoutMs: 40 },
    );
    await client.streamFrames({ signal: new AbortController().signal, ...sink });

    await new Promise((resolve) => setTimeout(resolve, 250));
    body.push(frameBytes({ seq: 99 }));
    await vi.waitFor(() => expect(sink.frames).toHaveLength(1));
    expect(sink.frames[0].seq).toBe(99);
    body.finish();
    await sink.ended;
  });

  it("gives up on a stream that has gone completely silent", async () => {
    // A black-holed connection: open, and permanently quiet. The daemon
    // heartbeats, so silence for longer than a couple of intervals means the
    // link is gone — and saying so is what turns a frozen pane into one that
    // reconnects.
    const body = pushableResponse();
    const sink = collector();
    await clientFor(
      (async () => body.response) as unknown as typeof fetch,
    ).streamFrames({
      signal: new AbortController().signal,
      idleMs: 60,
      ...sink,
    });
    expect(await sink.ended).toBeUndefined();
  });

  it("does not time out a stream that keeps heartbeating", async () => {
    const body = pushableResponse();
    const sink = collector();
    await clientFor(
      (async () => body.response) as unknown as typeof fetch,
    ).streamFrames({
      signal: new AbortController().signal,
      idleMs: 120,
      ...sink,
    });
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      body.push(
        encodeFrameStreamRecord({ kind: FRAME_STREAM_KIND.heartbeat }),
      );
    }
    body.push(frameBytes({ seq: 5 }));
    await vi.waitFor(() => expect(sink.frames).toHaveLength(1));
    body.finish();
    await sink.ended;
  });
});
