/**
 * The SOF reader, against hand-built headers.
 *
 * Hand-built rather than fixture files, because what this has to be right
 * about is the marker WALK — fill bytes, standalone markers, a segment whose
 * length carries it past the end — and a real JPEG exercises exactly one path
 * through it.
 */
import { describe, expect, it } from "vitest";
import { readJpegDimensions } from "../jpeg-dimensions";

/**
 * A JPEG prefix: SOI, an APP0 segment, then a baseline SOF0 of `width` x
 * `height`. Exported shape mirrors what Chromium writes, so the server tests
 * can build a frame payload the reader will accept.
 */
export function jpegHeader(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8, // SOI
    0xff,
    0xe0,
    0x00,
    0x04,
    0x00,
    0x00, // APP0, length 4 (2 bytes of payload)
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08, // SOF0, length 17, precision 8
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03, // components
  ]);
}

describe("readJpegDimensions", () => {
  it("reads the frame header's own dimensions", () => {
    expect(readJpegDimensions(jpegHeader(2560, 1600))).toEqual({
      width: 2560,
      height: 1600,
    });
    expect(readJpegDimensions(jpegHeader(1280, 800))).toEqual({
      width: 1280,
      height: 800,
    });
  });

  it("walks past fill bytes and standalone markers", () => {
    const header = jpegHeader(640, 400);
    const padded = new Uint8Array([
      ...header.subarray(0, 2),
      0xff,
      0xd0, // RST0: standalone, no length
      0xff,
      0xff, // fill
      ...header.subarray(2),
    ]);
    expect(readJpegDimensions(padded)).toEqual({ width: 640, height: 400 });
  });

  it("gives up on anything that is not a JPEG", () => {
    // A PNG signature.
    expect(
      readJpegDimensions(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBeUndefined();
    expect(readJpegDimensions(new Uint8Array([]))).toBeUndefined();
    expect(readJpegDimensions(new Uint8Array([0xff, 0xd8]))).toBeUndefined();
  });

  it("gives up on a prefix that stops before the frame header", () => {
    // The caller decodes a PREFIX of a large frame rather than the whole thing,
    // so a truncated read has to be `undefined` rather than a guess — the
    // caller falls back to what the transport told it.
    const truncated = jpegHeader(1280, 800).subarray(0, 12);
    expect(readJpegDimensions(truncated)).toBeUndefined();
  });

  it("gives up on scan data rather than reading into it", () => {
    // Past SOS the bytes are entropy-coded and any 0xFF in them is not a
    // marker. A reader that kept walking would return whatever the compressed
    // pixels happened to spell.
    const sos = new Uint8Array([
      0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 1, 2, 3, 4,
    ]);
    expect(readJpegDimensions(sos)).toBeUndefined();
  });

  it("refuses a SOF whose declared length cannot hold its dimensions", () => {
    // A segment that says it is 2 bytes long, followed by bytes that happen to
    // sit where the dimensions would be. Reading them anyway would report the
    // NEXT segment's contents as a picture size — and the caller trusts what
    // comes back over its own fallback.
    const short = new Uint8Array([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x02, 0x08, 0x04, 0x00, 0x02, 0x80, 0x03,
    ]);
    expect(readJpegDimensions(short)).toBeUndefined();
  });

  it("refuses a header that declares no pixels", () => {
    expect(readJpegDimensions(jpegHeader(0, 0))).toBeUndefined();
  });
});
