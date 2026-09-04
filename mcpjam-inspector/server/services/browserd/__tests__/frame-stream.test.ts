/**
 * The daemon frame stream's wire format.
 *
 * The single most likely bug in this transport is a record split across chunk
 * boundaries: a 256 KiB JPEG NEVER arrives in one piece, so a decoder that
 * quietly assumed whole records would pass every hand-written test and fail on
 * the first real frame. Several cases below exist only to pin that.
 */
import { describe, expect, it } from "vitest";
import {
  createFrameStreamDecoder,
  encodeFrameStreamRecord,
  FRAME_STREAM_HEADER_BYTES,
  FRAME_STREAM_KIND,
  FRAME_STREAM_MAX_PAYLOAD_BYTES,
  FRAME_STREAM_VERSION,
  type FrameStreamFrame,
} from "../frame-stream";

function frame(over: Partial<FrameStreamFrame> = {}): FrameStreamFrame {
  return {
    kind: FRAME_STREAM_KIND.frame,
    deviceWidth: 1024,
    deviceHeight: 768,
    scale: 1,
    ts: 1_700_000_000_123,
    seq: 7,
    jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    ...over,
  };
}

/** Decode a whole buffer in one push, asserting it did not fault. */
function decodeAll(...chunks: Uint8Array[]) {
  const decoder = createFrameStreamDecoder();
  const records = [];
  for (const chunk of chunks) {
    const result = decoder.push(chunk);
    if (!result.ok) throw new Error(`decode failed: ${result.error}`);
    records.push(...result.records);
  }
  return records;
}

describe("frame-stream — the header says exactly where the record ends", () => {
  it("packs the documented layout, little-endian", () => {
    // A golden vector rather than a round-trip: a round-trip passes even if
    // both halves agree on the WRONG layout, and this format's whole job is to
    // stay byte-compatible with the one in shared/webmcp-inspector-protocol.ts.
    const bytes = encodeFrameStreamRecord(
      frame({ deviceWidth: 1024, deviceHeight: 768, scale: 2, seq: 7 }),
    );
    const view = new DataView(bytes.buffer);
    expect(view.getUint8(0)).toBe(FRAME_STREAM_VERSION);
    expect(view.getUint8(1)).toBe(FRAME_STREAM_KIND.frame);
    expect(view.getUint16(2, true)).toBe(1024);
    expect(view.getUint16(4, true)).toBe(768);
    expect(view.getUint16(6, true)).toBe(2000); // scale x1000
    expect(view.getFloat64(8, true)).toBe(1_700_000_000_123);
    expect(view.getUint32(16, true)).toBe(7);
    expect(view.getUint32(20, true)).toBe(4); // payload length
    expect(bytes.byteLength).toBe(FRAME_STREAM_HEADER_BYTES + 4);
    expect([...bytes.slice(FRAME_STREAM_HEADER_BYTES)]).toEqual([
      0xff, 0xd8, 0xff, 0xd9,
    ]);
  });

  it("round-trips a frame", () => {
    const [decoded] = decodeAll(encodeFrameStreamRecord(frame({ scale: 1.5 })));
    expect(decoded).toEqual(frame({ scale: 1.5 }));
  });

  it("reads scale 0 back as 1", () => {
    // Back-compat with the shared codec's rule. This writer never emits 0, but
    // the layouts have to stay identical or the comparison stops being useful.
    const bytes = encodeFrameStreamRecord(frame({ scale: 0 }));
    expect(new DataView(bytes.buffer).getUint16(6, true)).toBe(0);
    const [decoded] = decodeAll(bytes);
    expect(decoded).toMatchObject({ scale: 1 });
  });

  it("carries a heartbeat and an end reason", () => {
    const records = decodeAll(
      encodeFrameStreamRecord({ kind: FRAME_STREAM_KIND.heartbeat }),
      encodeFrameStreamRecord({
        kind: FRAME_STREAM_KIND.end,
        reason: "lease_held",
      }),
    );
    expect(records).toEqual([
      { kind: FRAME_STREAM_KIND.heartbeat },
      { kind: FRAME_STREAM_KIND.end, reason: "lease_held" },
    ]);
  });
});

describe("frame-stream — chunk boundaries are not record boundaries", () => {
  it("reassembles a record split across two chunks", () => {
    // The real case: a JPEG larger than one TCP segment. Split mid-payload.
    const jpeg = new Uint8Array(5_000).fill(0x41);
    const bytes = encodeFrameStreamRecord(frame({ jpeg }));
    const cut = 1_200;

    const decoder = createFrameStreamDecoder();
    const first = decoder.push(bytes.slice(0, cut));
    expect(first).toEqual({ ok: true, records: [] }); // nothing complete yet
    const second = decoder.push(bytes.slice(cut));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.records).toHaveLength(1);
    expect(second.records[0]).toMatchObject({ jpeg });
  });

  it("reassembles a record split INSIDE its header", () => {
    // The nastier split: fewer than 24 bytes arrive, so the decoder cannot even
    // read the length field yet and must not mistake that for a short record.
    const bytes = encodeFrameStreamRecord(frame());
    const decoder = createFrameStreamDecoder();
    expect(decoder.push(bytes.slice(0, 9))).toEqual({ ok: true, records: [] });
    expect(decoder.push(bytes.slice(9, 20))).toEqual({ ok: true, records: [] });
    const done = decoder.push(bytes.slice(20));
    expect(done.ok && done.records).toHaveLength(1);
  });

  it("survives being fed one byte at a time", () => {
    const bytes = encodeFrameStreamRecord(frame({ seq: 42 }));
    const decoder = createFrameStreamDecoder();
    const seen = [];
    for (const byte of bytes) {
      const result = decoder.push(new Uint8Array([byte]));
      expect(result.ok).toBe(true);
      if (result.ok) seen.push(...result.records);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ seq: 42 });
  });

  it("yields several records that arrive in one chunk", () => {
    const a = encodeFrameStreamRecord(frame({ seq: 1 }));
    const b = encodeFrameStreamRecord({ kind: FRAME_STREAM_KIND.heartbeat });
    const c = encodeFrameStreamRecord(frame({ seq: 2 }));
    const joined = new Uint8Array(
      a.byteLength + b.byteLength + c.byteLength,
    );
    joined.set(a);
    joined.set(b, a.byteLength);
    joined.set(c, a.byteLength + b.byteLength);

    const records = decodeAll(joined);
    expect(records.map((r) => r.kind)).toEqual([
      FRAME_STREAM_KIND.frame,
      FRAME_STREAM_KIND.heartbeat,
      FRAME_STREAM_KIND.frame,
    ]);
  });

  it("keeps the tail of a chunk that ends mid-record", () => {
    // One whole record plus the first half of the next, in a single chunk.
    const whole = encodeFrameStreamRecord(frame({ seq: 1 }));
    const partial = encodeFrameStreamRecord(frame({ seq: 2 }));
    const cut = FRAME_STREAM_HEADER_BYTES + 2;
    const chunk = new Uint8Array(whole.byteLength + cut);
    chunk.set(whole);
    chunk.set(partial.slice(0, cut), whole.byteLength);

    const decoder = createFrameStreamDecoder();
    const first = decoder.push(chunk);
    expect(first.ok && first.records).toHaveLength(1);
    const second = decoder.push(partial.slice(cut));
    expect(second.ok && second.records).toHaveLength(1);
    expect(second.ok && second.records[0]).toMatchObject({ seq: 2 });
  });
});

describe("frame-stream — a reader that has lost its place says so", () => {
  it("refuses a payload larger than the viewport can produce", () => {
    // Without this the decoder waits forever for bytes nobody will send: a
    // corrupt length is otherwise indistinguishable from a record still in
    // flight.
    const bytes = encodeFrameStreamRecord(frame());
    new DataView(bytes.buffer).setUint32(
      20,
      FRAME_STREAM_MAX_PAYLOAD_BYTES + 1,
      true,
    );
    const result = createFrameStreamDecoder().push(bytes);
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toMatch(/too large/);
  });

  it("refuses a version it does not know", () => {
    const bytes = encodeFrameStreamRecord(frame());
    new DataView(bytes.buffer).setUint8(0, FRAME_STREAM_VERSION + 1);
    expect(createFrameStreamDecoder().push(bytes)).toMatchObject({
      ok: false,
    });
  });

  it("refuses an unknown kind rather than skipping it", () => {
    // The shared codec answers `undefined` for an unknown kind, which is right
    // for a self-contained message and wrong here: the `end` record is the one
    // a reader must never miss, so silently dropping records it does not
    // recognise is exactly the failure to avoid.
    const bytes = encodeFrameStreamRecord({
      kind: FRAME_STREAM_KIND.heartbeat,
    });
    new DataView(bytes.buffer).setUint8(1, 99);
    const result = createFrameStreamDecoder().push(bytes);
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toMatch(/unknown record kind/);
  });

  it("drops the good records ahead of a bad one rather than salvaging them", () => {
    // The name used to promise the opposite of what the code does, and the one
    // assertion (`{ ok: false }`) could not tell the two apart — the error
    // variant has no `records` field either way. What is actually being
    // claimed: a caller that cannot trust the stream must drop it whole, so a
    // valid record ahead of the fault is deliberately NOT handed back.
    const good = encodeFrameStreamRecord(frame({ seq: 1 }));
    const bad = encodeFrameStreamRecord(frame({ seq: 2 }));
    new DataView(bad.buffer).setUint8(0, 9);
    const chunk = new Uint8Array(good.byteLength + bad.byteLength);
    chunk.set(good);
    chunk.set(bad, good.byteLength);

    // The prefix is genuinely decodable on its own: without this the test
    // could pass because `good` was malformed too.
    expect(decodeAll(good)).toMatchObject([{ seq: 1 }]);

    const result = createFrameStreamDecoder().push(chunk);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("records");
    expect(result.ok === false && result.error).toMatch(/version/i);
  });

  it("accepts a payload exactly at the cap", () => {
    const jpeg = new Uint8Array(FRAME_STREAM_MAX_PAYLOAD_BYTES).fill(1);
    const [decoded] = decodeAll(encodeFrameStreamRecord(frame({ jpeg })));
    expect(decoded).toMatchObject({
      jpeg: expect.objectContaining({ byteLength: jpeg.byteLength }),
    });
  });
});
