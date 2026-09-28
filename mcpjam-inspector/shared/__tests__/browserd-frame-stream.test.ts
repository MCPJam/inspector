/**
 * The frame-stream record format, which is now the ONLY one.
 *
 * This codec is compiled into every end of the picture: the daemon packs with
 * it, the Node routes pack with it, the browser unpacks with it, and it is
 * bundled into the standalone daemon artifact. A drift in any direction is a
 * pane full of garbage rather than a type error, so the round trip is the
 * contract.
 *
 * Most of what follows was proved against `webmcp-inspector-protocol`'s
 * single-message adapter, which the inspection socket used until it started
 * speaking this codec directly. The cases survive their old home because the
 * bytes never changed — only the number of decoders reading them did. Where
 * the STREAM decoder answers differently from that message adapter (a short
 * read is "not yet", not "no"), the test says so.
 */
import { describe, it, expect } from "vitest";
import {
  FRAME_STREAM_HEADER_BYTES,
  FRAME_STREAM_KIND,
  createFrameStreamDecoder,
  encodeFrameStreamRecord,
  type FrameStreamFrame,
} from "../browserd-frame-stream";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

function frame(overrides: Partial<FrameStreamFrame> = {}): FrameStreamFrame {
  return {
    kind: FRAME_STREAM_KIND.frame,
    deviceWidth: 1280,
    deviceHeight: 800,
    scale: 1,
    ts: 1_732_000_000_123,
    seq: 42,
    jpeg: JPEG,
    ...overrides,
  };
}

/** The one-record case, which is what a socket message carries. */
function decodeOne(bytes: Uint8Array): FrameStreamFrame {
  const result = createFrameStreamDecoder().push(bytes);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(result.records).toHaveLength(1);
  const record = result.records[0]!;
  expect(record.kind).toBe(FRAME_STREAM_KIND.frame);
  return record as FrameStreamFrame;
}

describe("browserd frame stream codec", () => {
  it("round-trips a frame", () => {
    const encoded = encodeFrameStreamRecord(frame());
    expect(encoded.byteLength).toBe(FRAME_STREAM_HEADER_BYTES + JPEG.length);

    const decoded = decodeOne(encoded);
    expect(decoded.deviceWidth).toBe(1280);
    expect(decoded.deviceHeight).toBe(800);
    // A float64 carries a millisecond wall-clock exactly, which is what makes
    // capture→paint measurable at all.
    expect(decoded.ts).toBe(1_732_000_000_123);
    expect(decoded.seq).toBe(42);
    expect([...decoded.jpeg]).toEqual([...JPEG]);
  });

  it("copies the payload rather than viewing the receive buffer", () => {
    const encoded = encodeFrameStreamRecord(frame());
    const decoded = decodeOne(encoded);
    // Some transports reuse the receive allocation; a view would mutate under
    // a `createImageBitmap` that is still decoding it.
    encoded[FRAME_STREAM_HEADER_BYTES] = 0x00;
    expect(decoded.jpeg[0]).toBe(0xff);
  });

  it("copies a Node Buffer's payload too", () => {
    // The case that actually bites, and the one a Uint8Array test misses: a
    // Buffer IS a Uint8Array but overrides `slice` to return a VIEW, so the
    // `ws` receive buffer — the only input where aliasing has a real writer —
    // is exactly where `.slice()` would fail to copy.
    const encoded = Buffer.from(encodeFrameStreamRecord(frame()));
    const decoded = decodeOne(encoded);
    encoded[FRAME_STREAM_HEADER_BYTES] = 0x00;
    expect(decoded.jpeg[0]).toBe(0xff);
    expect([...decoded.jpeg]).toEqual([...JPEG]);
  });

  it("decodes a Buffer that is a view onto a larger allocation", () => {
    // `ws` hands over slices of a pooled buffer, so byteOffset is routinely
    // non-zero. A decoder reading from the underlying ArrayBuffer's origin
    // rather than the view's would return another frame's bytes entirely.
    const encoded = encodeFrameStreamRecord(frame({ seq: 21 }));
    const pool = Buffer.alloc(encoded.length + 16, 0x5a);
    encoded.forEach((byte, index) => {
      pool[8 + index] = byte;
    });
    const decoded = decodeOne(pool.subarray(8, 8 + encoded.length));
    expect(decoded.seq).toBe(21);
    expect([...decoded.jpeg]).toEqual([...JPEG]);
  });

  it("refuses a frame record that carries no image", () => {
    // Accepted, it would reach the pane as an empty picture and REPLACE the
    // one on screen with a blank. Fatal rather than skipped: a byte stream
    // that has lost its place cannot be recovered by guessing, and the reader
    // above drops the connection on this.
    const result = createFrameStreamDecoder().push(
      encodeFrameStreamRecord(frame({ jpeg: new Uint8Array(0) })),
    );
    expect(result.ok).toBe(false);
  });

  it("holds a truncated record instead of refusing it", () => {
    // THE STREAM DIFFERENCE. The old single-message adapter answered
    // `undefined` for a short read, because a message either is a whole record
    // or is not one. Here a short read is simply the rest not having arrived:
    // a 256 KiB JPEG does not fit in one WebSocket frame, and a decoder that
    // gave up on the first partial one would never deliver a real picture.
    const encoded = encodeFrameStreamRecord(frame());
    const decoder = createFrameStreamDecoder();
    const first = decoder.push(encoded.slice(0, encoded.length - 2));
    expect(first).toEqual({ ok: true, records: [] });

    const rest = decoder.push(encoded.slice(encoded.length - 2));
    expect(rest.ok).toBe(true);
    if (!rest.ok) return;
    expect(rest.records).toHaveLength(1);
    expect((rest.records[0] as FrameStreamFrame).seq).toBe(42);
  });

  it("delivers two records that arrived in one chunk", () => {
    const both = new Uint8Array([
      ...encodeFrameStreamRecord(frame({ seq: 1 })),
      ...encodeFrameStreamRecord(frame({ seq: 2 })),
    ]);
    const result = createFrameStreamDecoder().push(both);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.records.map((r) => (r as FrameStreamFrame).seq)).toEqual([
      1, 2,
    ]);
  });

  it("refuses an unknown version or kind", () => {
    const wrongVersion = encodeFrameStreamRecord(frame());
    wrongVersion[0] = 9;
    expect(createFrameStreamDecoder().push(wrongVersion).ok).toBe(false);

    // Fatal rather than skipped, and for the same reason: a kind this reader
    // does not know is a writer it does not understand, and guessing which of
    // its records still mean what they used to is how a silent divergence
    // becomes a garbled pane.
    const wrongKind = encodeFrameStreamRecord(frame());
    wrongKind[1] = 9;
    expect(createFrameStreamDecoder().push(wrongKind).ok).toBe(false);
  });

  it("refuses a video record unless video was negotiated", () => {
    const unit = encodeFrameStreamRecord({
      kind: FRAME_STREAM_KIND.video_key,
      deviceWidth: 1280,
      deviceHeight: 800,
      scale: 1,
      ts: 1,
      seq: 1,
      au: JPEG,
    });
    expect(createFrameStreamDecoder().push(unit).ok).toBe(false);
    expect(createFrameStreamDecoder({ video: true }).push(unit).ok).toBe(true);
  });

  it("round-trips the capture scale, and reads a missing one as 1", () => {
    expect(decodeOne(encodeFrameStreamRecord(frame({ scale: 2 }))).scale).toBe(
      2,
    );
    // Fractional ratios are real: 1.5 is what a 150% Windows display reports.
    expect(
      decodeOne(encodeFrameStreamRecord(frame({ scale: 1.5 }))).scale,
    ).toBe(1.5);
    // A frame from a writer that has never heard of the field. Zero is what
    // V1 wrote into these two bytes as "reserved", and it means 1 — not a
    // frame of no size, which is what a literal reading would make of it.
    const legacy = encodeFrameStreamRecord(frame());
    new DataView(legacy.buffer, legacy.byteOffset).setUint16(6, 0, true);
    expect(decodeOne(legacy).scale).toBe(1);
    expect(encodeFrameStreamRecord(frame())[6]).toBe(0xe8); // 1000, low byte
  });

  it("puts the scale where V1 reserved bytes, and nowhere else", () => {
    // The compatibility claim in one assertion: every byte an old decoder
    // reads is identical, so a new writer's frames decode correctly on a
    // reader that has never heard of `scale`.
    const withScale = encodeFrameStreamRecord(frame({ scale: 2 }));
    const withoutScale = encodeFrameStreamRecord(frame({ scale: 1 }));
    const differing = [...withScale]
      .map((byte, index) => (byte === withoutScale[index] ? -1 : index))
      .filter((index) => index >= 0);
    expect(differing).toEqual([6, 7]);
  });

  it("clamps a surface too large for the header rather than wrapping it", () => {
    // A wrapped width would letterbox every later click against a box the page
    // never had.
    const decoded = decodeOne(
      encodeFrameStreamRecord(
        frame({ deviceWidth: 70_000, deviceHeight: -5 }),
      ),
    );
    expect(decoded.deviceWidth).toBe(0xffff);
    expect(decoded.deviceHeight).toBe(0);
  });
});
