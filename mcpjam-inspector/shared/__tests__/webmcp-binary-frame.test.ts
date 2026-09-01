/**
 * The binary frame wire format.
 *
 * This codec is the one piece of the frame stream compiled into BOTH ends —
 * the Node route packs with it, the browser unpacks with it — so a drift in
 * either direction is a pane full of garbage rather than a type error. The
 * round trip is therefore the contract, and the malformed cases pin down the
 * promise the decoder makes to a `message` handler: it answers `undefined`,
 * it never throws.
 */
import { describe, it, expect } from "vitest";
import {
  WEBMCP_FRAME_WS_HEADER_BYTES,
  decodeWebMcpBinaryFrame,
  encodeWebMcpBinaryFrame,
} from "../webmcp-inspector-protocol";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

function frame(
  overrides: Partial<Parameters<typeof encodeWebMcpBinaryFrame>[0]> = {},
) {
  return {
    deviceWidth: 1280,
    deviceHeight: 800,
    ts: 1_732_000_000_123,
    seq: 42,
    jpeg: JPEG,
    ...overrides,
  };
}

describe("webmcp binary frame codec", () => {
  it("round-trips a frame", () => {
    const encoded = encodeWebMcpBinaryFrame(frame());
    expect(encoded.byteLength).toBe(WEBMCP_FRAME_WS_HEADER_BYTES + JPEG.length);

    const decoded = decodeWebMcpBinaryFrame(encoded);
    expect(decoded).toBeDefined();
    expect(decoded!.deviceWidth).toBe(1280);
    expect(decoded!.deviceHeight).toBe(800);
    // A float64 carries a millisecond wall-clock exactly, which is what makes
    // capture→paint measurable at all.
    expect(decoded!.ts).toBe(1_732_000_000_123);
    expect(decoded!.seq).toBe(42);
    expect([...decoded!.jpeg]).toEqual([...JPEG]);
  });

  it("accepts an ArrayBuffer as well as a view", () => {
    // `binaryType = "arraybuffer"` hands the client an ArrayBuffer, and the
    // server hands itself a Uint8Array. Both have to work.
    const encoded = encodeWebMcpBinaryFrame(frame({ seq: 7 }));
    const buffer = encoded.buffer.slice(
      encoded.byteOffset,
      encoded.byteOffset + encoded.byteLength,
    ) as ArrayBuffer;
    expect(decodeWebMcpBinaryFrame(buffer)?.seq).toBe(7);
  });

  it("decodes a zero-byte payload rather than refusing it", () => {
    const decoded = decodeWebMcpBinaryFrame(
      encodeWebMcpBinaryFrame(frame({ jpeg: new Uint8Array(0) })),
    );
    expect(decoded?.jpeg.byteLength).toBe(0);
  });

  it("copies the payload rather than viewing the socket's buffer", () => {
    const encoded = encodeWebMcpBinaryFrame(frame());
    const decoded = decodeWebMcpBinaryFrame(encoded)!;
    // Some transports reuse the receive allocation; a view would mutate under
    // an <img> that is still decoding it.
    encoded[WEBMCP_FRAME_WS_HEADER_BYTES] = 0x00;
    expect(decoded.jpeg[0]).toBe(0xff);
  });

  it("returns undefined for a truncated message", () => {
    const encoded = encodeWebMcpBinaryFrame(frame());
    expect(
      decodeWebMcpBinaryFrame(encoded.slice(0, encoded.length - 2)),
    ).toBeUndefined();
    // Shorter than the header itself.
    expect(decodeWebMcpBinaryFrame(new Uint8Array(4))).toBeUndefined();
  });

  it("returns undefined for a message longer than its declared payload", () => {
    const encoded = encodeWebMcpBinaryFrame(frame());
    const padded = new Uint8Array(encoded.length + 3);
    padded.set(encoded);
    expect(decodeWebMcpBinaryFrame(padded)).toBeUndefined();
  });

  it("returns undefined for an unknown version or kind", () => {
    const wrongVersion = encodeWebMcpBinaryFrame(frame());
    wrongVersion[0] = 2;
    expect(decodeWebMcpBinaryFrame(wrongVersion)).toBeUndefined();

    // An unknown KIND is how a later message type stays non-breaking for this
    // client: it reads as "not a frame I understand", not as an error.
    const wrongKind = encodeWebMcpBinaryFrame(frame());
    wrongKind[1] = 9;
    expect(decodeWebMcpBinaryFrame(wrongKind)).toBeUndefined();
  });

  it("clamps a surface too large for the header rather than wrapping it", () => {
    // A wrapped width would letterbox every later click against a box the page
    // never had.
    const decoded = decodeWebMcpBinaryFrame(
      encodeWebMcpBinaryFrame(frame({ deviceWidth: 70_000, deviceHeight: -5 })),
    );
    expect(decoded!.deviceWidth).toBe(0xffff);
    expect(decoded!.deviceHeight).toBe(0);
  });
});
