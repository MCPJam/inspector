/**
 * The browser's side of the daemon's frame wire.
 *
 * The decoder is the DAEMON'S, imported rather than reimplemented, and these
 * pin the parts that only exist on this side: bitmaps get decoded and handed
 * over, records that cross a message boundary are reassembled, a reader that
 * has lost its place stops rather than guessing, and a picture that arrives
 * after the socket is gone is released rather than leaked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  encodeFrameStreamRecord,
  FRAME_STREAM_KIND,
} from "@/shared/browserd-frame-stream";
import { createFrameWireReader, paintFrame } from "../frame-wire";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

function frameRecord(over: Partial<{ seq: number; ts: number }> = {}) {
  return encodeFrameStreamRecord({
    kind: FRAME_STREAM_KIND.frame,
    deviceWidth: 1024,
    deviceHeight: 768,
    scale: 1,
    ts: over.ts ?? 12_345,
    seq: over.seq ?? 7,
    jpeg: JPEG,
  });
}

/** Bitmaps that record being released, so a leak is visible. */
const bitmaps: Array<{ closed: boolean }> = [];

beforeEach(() => {
  bitmaps.length = 0;
  vi.stubGlobal("createImageBitmap", async () => {
    const bitmap = {
      width: 1024,
      height: 768,
      closed: false,
      close() {
        bitmap.closed = true;
      },
    };
    bitmaps.push(bitmap);
    return bitmap as unknown as ImageBitmap;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the frame wire reader", () => {
  it("hands over a decoded picture with the record's own geometry", async () => {
    const frames: Array<Record<string, unknown>> = [];
    const reader = createFrameWireReader({
      onFrame: (frame) =>
        frames.push(frame as unknown as Record<string, unknown>),
    });
    reader.push(frameRecord());
    await settle();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      deviceWidth: 1024,
      deviceHeight: 768,
      scale: 1,
      // The RELAY's stamp, which is what the pane may subtract from its own
      // clock — the daemon's `ts` was rewritten one hop ago.
      relayTs: 12_345,
      seq: 7,
      bytes: JPEG.byteLength + 24,
    });
    expect(typeof frames[0]!.decodeMs).toBe("number");
  });

  it("reassembles a record that arrives in pieces", async () => {
    // A 256 KiB JPEG never arrives in one message. A decoder that assumed
    // whole records would pass every test and fail on the first real picture.
    const frames: unknown[] = [];
    const reader = createFrameWireReader({ onFrame: (f) => frames.push(f) });
    const bytes = frameRecord();
    reader.push(bytes.slice(0, 10));
    reader.push(bytes.slice(10, 26));
    await settle();
    expect(frames).toHaveLength(0);
    reader.push(bytes.slice(26));
    await settle();
    expect(frames).toHaveLength(1);
  });

  it("passes the heartbeat's stats through", async () => {
    const seen: unknown[] = [];
    const reader = createFrameWireReader({
      onFrame: () => {},
      onHeartbeat: (stats) => seen.push(stats),
    });
    reader.push(
      encodeFrameStreamRecord({
        kind: FRAME_STREAM_KIND.heartbeat,
        stats: { framesIn: 4, encoderIdle: true },
      }),
    );
    expect(seen).toEqual([{ framesIn: 4, encoderIdle: true }]);
  });

  it("reports the reason a stream said it was ending", async () => {
    const ends: string[] = [];
    const reader = createFrameWireReader({
      onFrame: () => {},
      onEnd: (reason) => ends.push(reason),
    });
    reader.push(
      encodeFrameStreamRecord({
        kind: FRAME_STREAM_KIND.end,
        reason: "lease_held",
      }),
    );
    expect(ends).toEqual(["lease_held"]);
  });

  it("stops on a violation rather than guessing", async () => {
    // There is no framing marker to resynchronise against: a reader that has
    // lost its place in a byte stream can never find it again.
    const fatal: string[] = [];
    const frames: unknown[] = [];
    const reader = createFrameWireReader({
      onFrame: (f) => frames.push(f),
      onFatal: (error) => fatal.push(error),
    });
    const bytes = frameRecord();
    bytes[0] = 99; // an impossible version
    reader.push(bytes);
    await settle();
    expect(fatal).toHaveLength(1);
    expect(frames).toHaveLength(0);
    // And it stays stopped: anything after the violation is not decodable.
    reader.push(frameRecord());
    await settle();
    expect(frames).toHaveLength(0);
  });

  it("releases a picture that finished decoding after the socket went", async () => {
    const frames: unknown[] = [];
    const reader = createFrameWireReader({ onFrame: (f) => frames.push(f) });
    reader.push(frameRecord());
    // Closed WHILE the decode is in flight — a pane switching tabs mid-frame.
    reader.close();
    await settle();
    expect(frames).toHaveLength(0);
    expect(bitmaps[0]?.closed).toBe(true);
  });

  it("survives a picture that will not decode", async () => {
    vi.stubGlobal("createImageBitmap", async () => {
      throw new Error("not an image");
    });
    const fatal: string[] = [];
    const reader = createFrameWireReader({
      onFrame: () => {},
      onFatal: (error) => fatal.push(error),
    });
    reader.push(frameRecord());
    await settle();
    // One bad frame is one frame; the next paint replaces it. Dropping the
    // connection would trade a glitch for a reconnect.
    expect(fatal).toEqual([]);
  });
});

describe("painting", () => {
  it("sizes the canvas to the picture and draws it", () => {
    const drawn: unknown[] = [];
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: (image: unknown) => drawn.push(image) }),
    } as unknown as HTMLCanvasElement;
    const bitmap = {} as ImageBitmap;
    expect(
      paintFrame(canvas, { bitmap, deviceWidth: 1024, deviceHeight: 768 }),
    ).toBe(true);
    expect(canvas.width).toBe(1024);
    expect(canvas.height).toBe(768);
    expect(drawn).toEqual([bitmap]);
  });

  it("reports rather than throws when there is nothing to draw on", () => {
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => null,
    } as unknown as HTMLCanvasElement;
    expect(
      paintFrame(canvas, {
        bitmap: {} as ImageBitmap,
        deviceWidth: 8,
        deviceHeight: 8,
      }),
    ).toBe(false);
  });

  it("reports rather than throws on a bitmap that was already released", () => {
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: () => {
          throw new Error("InvalidStateError");
        },
      }),
    } as unknown as HTMLCanvasElement;
    expect(
      paintFrame(canvas, {
        bitmap: {} as ImageBitmap,
        deviceWidth: 8,
        deviceHeight: 8,
      }),
    ).toBe(false);
  });
});

describe("frames that decode out of order", () => {
  it("drops a picture a newer one already overtook", async () => {
    // `createImageBitmap` runs concurrently for every record and resolves in
    // whatever order the image pipeline finishes them. Without a guard a slow
    // older JPEG lands after a fast newer one and paints the page backwards —
    // taking the click mapping with it, because the geometry travels with the
    // frame.
    const settle: Array<(bitmap: ImageBitmap) => void> = [];
    const closed: number[] = [];
    let made = 0;
    vi.stubGlobal("createImageBitmap", () => {
      const id = made++;
      return new Promise<ImageBitmap>((resolve) => {
        settle.push(() =>
          resolve({
            close: () => closed.push(id),
          } as unknown as ImageBitmap),
        );
      });
    });
    try {
      const seen: number[] = [];
      const reader = createFrameWireReader({
        onFrame: (frame) => seen.push(frame.seq),
      });
      reader.push(frameRecord({ seq: 1 }));
      reader.push(frameRecord({ seq: 2 }));
      // The SECOND decode finishes first.
      settle[1]!({} as never);
      await Promise.resolve();
      settle[0]!({} as never);
      await Promise.resolve();
      await Promise.resolve();
      expect(seen).toEqual([2]);
      // And the overtaken picture is released rather than leaked.
      expect(closed).toEqual([0]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Node-local bounded JPEG decoding", () => {
  it("keeps one decode active and only the newest waiting JPEG", async () => {
    const resolutions: Array<(bitmap: ImageBitmap) => void> = [];
    const decode = vi.fn(
      () => new Promise<ImageBitmap>((resolve) => resolutions.push(resolve)),
    );
    vi.stubGlobal("createImageBitmap", decode);
    const onFrame = vi.fn();
    const reader = createFrameWireReader({ onFrame }, { latestOnly: true });
    reader.push(frameRecord({ seq: 1 }));
    for (let seq = 2; seq <= 100; seq++) reader.push(frameRecord({ seq }));
    reader.push(frameRecord({ seq: 5 }));
    expect(decode).toHaveBeenCalledTimes(1);
    const first = { close: vi.fn() } as unknown as ImageBitmap;
    resolutions[0](first);
    await settle();
    expect(decode).toHaveBeenCalledTimes(2);
    expect(onFrame.mock.calls[0][0].seq).toBe(1);
    const last = { close: vi.fn() } as unknown as ImageBitmap;
    resolutions[1](last);
    await settle();
    expect(onFrame.mock.calls[1][0].seq).toBe(100);
    expect(decode).toHaveBeenCalledTimes(2);
    reader.close();
    first.close();
    last.close();
  });

  it("discards pending work on close and releases the in-flight bitmap", async () => {
    let resolve!: (bitmap: ImageBitmap) => void;
    const decode = vi.fn(
      () =>
        new Promise<ImageBitmap>((done) => {
          resolve = done;
        }),
    );
    vi.stubGlobal("createImageBitmap", decode);
    const onFrame = vi.fn();
    const reader = createFrameWireReader({ onFrame }, { latestOnly: true });
    reader.push(frameRecord({ seq: 1 }));
    reader.push(frameRecord({ seq: 2 }));
    reader.close();
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    resolve(bitmap);
    await settle();
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(onFrame).not.toHaveBeenCalled();
    expect(decode).toHaveBeenCalledOnce();
  });

  it("recovers to the final frame after a decode rejects", async () => {
    let reject!: (reason: Error) => void;
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    const decode = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, fail) => {
            reject = fail;
          }),
      )
      .mockResolvedValue(bitmap);
    vi.stubGlobal("createImageBitmap", decode);
    const onFrame = vi.fn();
    const reader = createFrameWireReader({ onFrame }, { latestOnly: true });
    reader.push(frameRecord({ seq: 1 }));
    reader.push(frameRecord({ seq: 2 }));
    reject(new Error("bad JPEG"));
    await settle();
    expect(onFrame).toHaveBeenCalledOnce();
    expect(onFrame.mock.calls[0][0].seq).toBe(2);
    reader.close();
    bitmap.close();
  });
});
