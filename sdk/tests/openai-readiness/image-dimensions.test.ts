/**
 * Image dimension decoding, over bytes rather than files.
 *
 * Every fixture here is built literally, so a failure points at the decoder and
 * not at a checked-in binary somebody regenerated. The cases that matter are
 * the ones where a naive decoder gets a plausible WRONG answer rather than an
 * error: a JPEG whose EXIF block is walked as a frame header, a WebP variant
 * the common path does not handle, an SVG whose width lives in a comment.
 */

import { describe, expect, it } from "vitest";

import {
  readImageDimensions as readImageDimensionsRaw,
  sniffImageMimeType as sniffImageMimeTypeRaw,
} from "../../src/openai-readiness/package/image-dimensions.js";
import { xmldomParseXml } from "../../src/openai-readiness/package/svg-xml-node.js";

// Node has no `DOMParser`, so the SVG path needs the parser this runtime's
// entry supplies. Passing it here is the same thing a server-side caller does;
// a browser needs neither the import nor the argument.
const readImageDimensions = (bytes: Uint8Array) =>
  readImageDimensionsRaw(bytes, { parseXml: xmldomParseXml });
const sniffImageMimeType = (bytes: Uint8Array) =>
  sniffImageMimeTypeRaw(bytes, { parseXml: xmldomParseXml });

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

const PNG_MAGIC = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

const be32 = (value: number): Uint8Array =>
  bytes(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );

const be16 = (value: number): Uint8Array =>
  bytes((value >>> 8) & 0xff, value & 0xff);

function png(width: number, height: number): Uint8Array {
  return concat(
    PNG_MAGIC,
    be32(13), // IHDR length
    utf8("IHDR"),
    be32(width),
    be32(height),
    bytes(8, 6, 0, 0, 0), // depth, colour type, compression, filter, interlace
  );
}

describe("PNG", () => {
  it("reads width and height from the IHDR chunk", () => {
    const result = readImageDimensions(png(512, 512));
    expect(result).toEqual({
      ok: true,
      dimensions: { widthPx: 512, heightPx: 512, format: "png" },
    });
  });

  it("reads a non-square image without normalising it", () => {
    const result = readImageDimensions(png(1024, 512));
    expect(result.ok && result.dimensions).toMatchObject({
      widthPx: 1024,
      heightPx: 512,
    });
  });

  it("refuses a file truncated before its IHDR", () => {
    // The whole point of refusing: reading offset 16 of a 20-byte file would
    // report whatever happened to be there as a width.
    const result = readImageDimensions(png(512, 512).subarray(0, 20));
    expect(result).toEqual({
      ok: false,
      reason: "PNG is truncated before its IHDR chunk",
    });
  });

  it("refuses a PNG whose first chunk is not IHDR", () => {
    const malformed = concat(
      PNG_MAGIC,
      be32(13),
      utf8("iTXt"),
      be32(512),
      be32(512),
      bytes(8, 6, 0, 0, 0),
    );
    expect(readImageDimensions(malformed)).toEqual({
      ok: false,
      reason: "PNG does not begin with an IHDR chunk",
    });
  });

  it("refuses a zero dimension rather than reporting it", () => {
    expect(readImageDimensions(png(0, 512))).toEqual({
      ok: false,
      reason: "PNG declares a zero dimension",
    });
  });
});

describe("JPEG", () => {
  const segment = (marker: number, payload: Uint8Array): Uint8Array =>
    concat(bytes(0xff, marker), be16(payload.length + 2), payload);

  const sof0 = (width: number, height: number): Uint8Array =>
    segment(0xc0, concat(bytes(8), be16(height), be16(width), bytes(3)));

  it("finds the frame header past an EXIF segment", () => {
    // The case a fixed-offset reader gets wrong: APP1 comes first and varies
    // in length, so the dimensions are not at any constant position.
    const jpeg = concat(
      bytes(0xff, 0xd8),
      segment(0xe1, utf8("Exif\0\0".padEnd(64, "x"))),
      sof0(2048, 2048),
    );
    expect(readImageDimensions(jpeg)).toEqual({
      ok: true,
      dimensions: { widthPx: 2048, heightPx: 2048, format: "jpeg" },
    });
  });

  it("handles a progressive frame marker", () => {
    const jpeg = concat(
      bytes(0xff, 0xd8),
      segment(0xdb, utf8("quantisation")),
      segment(0xc2, concat(bytes(8), be16(96), be16(48), bytes(3))),
    );
    expect(
      readImageDimensions(jpeg).ok && readImageDimensions(jpeg),
    ).toMatchObject({ dimensions: { widthPx: 48, heightPx: 96 } });
  });

  it("skips fill bytes before a marker", () => {
    // `0xFF 0xFF … 0xFF <marker>` is legal padding; a scanner that assumed
    // exactly one 0xFF reports a malformed structure on a valid file.
    const jpeg = concat(
      bytes(0xff, 0xd8),
      bytes(0xff, 0xff, 0xff),
      sof0(64, 64),
    );
    expect(readImageDimensions(jpeg).ok).toBe(true);
  });

  it("does not read a length field from a standalone marker", () => {
    // Restart markers carry no payload. Reading two bytes as a length here
    // walks the cursor into entropy-coded data and finds a "frame" that isn't.
    const jpeg = concat(bytes(0xff, 0xd8), bytes(0xff, 0xd0), sof0(128, 128));
    expect(readImageDimensions(jpeg)).toEqual({
      ok: true,
      dimensions: { widthPx: 128, heightPx: 128, format: "jpeg" },
    });
  });

  it("refuses a JPEG with no start-of-frame at all", () => {
    const jpeg = concat(bytes(0xff, 0xd8), segment(0xe0, utf8("JFIF\0")));
    expect(readImageDimensions(jpeg)).toEqual({
      ok: false,
      reason: "JPEG contains no start-of-frame segment",
    });
  });

  it("refuses a segment whose declared length is impossible", () => {
    const jpeg = concat(bytes(0xff, 0xd8), bytes(0xff, 0xe0), be16(1));
    expect(readImageDimensions(jpeg)).toEqual({
      ok: false,
      reason: "JPEG segment declares an invalid length",
    });
  });
});

describe("WebP", () => {
  const riff = (chunk: string, payload: Uint8Array): Uint8Array =>
    concat(
      utf8("RIFF"),
      bytes(0, 0, 0, 0),
      utf8("WEBP"),
      utf8(chunk),
      bytes(0, 0, 0, 0),
      payload,
    );

  it("reads a lossy VP8 keyframe", () => {
    // Payload begins at offset 20; the start code sits at 23..25 and the
    // 14-bit dimensions at 26..29.
    const payload = concat(
      bytes(0, 0, 0),
      bytes(0x9d, 0x01, 0x2a),
      bytes(200 & 0xff, (200 >> 8) & 0x3f),
      bytes(100 & 0xff, (100 >> 8) & 0x3f),
    );
    expect(readImageDimensions(riff("VP8 ", payload))).toEqual({
      ok: true,
      dimensions: { widthPx: 200, heightPx: 100, format: "webp" },
    });
  });

  it("reads a lossless VP8L bitfield", () => {
    // 14 bits each, stored minus one, little-endian from offset 21.
    const width = 300;
    const height = 200;
    const packed = (width - 1) | ((height - 1) << 14);
    const payload = concat(
      bytes(0x2f),
      bytes(
        packed & 0xff,
        (packed >>> 8) & 0xff,
        (packed >>> 16) & 0xff,
        (packed >>> 24) & 0xff,
      ),
    );
    expect(readImageDimensions(riff("VP8L", payload))).toEqual({
      ok: true,
      dimensions: { widthPx: 300, heightPx: 200, format: "webp" },
    });
  });

  it("reads an extended VP8X canvas", () => {
    // A decoder handling only the common `VP8 ` case silently refuses every
    // animated or alpha WebP, which is a large share of real icons.
    const width = 1000;
    const height = 1000;
    const payload = concat(
      bytes(0, 0, 0, 0), // 1 flags byte + 3 reserved
      bytes(
        (width - 1) & 0xff,
        ((width - 1) >> 8) & 0xff,
        ((width - 1) >> 16) & 0xff,
      ),
      bytes(
        (height - 1) & 0xff,
        ((height - 1) >> 8) & 0xff,
        ((height - 1) >> 16) & 0xff,
      ),
    );
    expect(readImageDimensions(riff("VP8X", payload))).toEqual({
      ok: true,
      dimensions: { widthPx: 1000, heightPx: 1000, format: "webp" },
    });
  });

  it("refuses a RIFF container that is not a WebP", () => {
    const wav = concat(
      utf8("RIFF"),
      bytes(0, 0, 0, 0),
      utf8("WAVE"),
      utf8("fmt "),
    );
    expect(readImageDimensions(wav)).toEqual({
      ok: false,
      reason: "RIFF container is not a WebP",
    });
  });

  it("refuses an unrecognised payload chunk by name", () => {
    const result = readImageDimensions(riff("ALPH", bytes(0, 0, 0, 0)));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("ALPH");
  });
});

describe("SVG", () => {
  it("prefers a numeric width/height pair", () => {
    expect(
      readImageDimensions(utf8('<svg width="64" height="64"></svg>')),
    ).toEqual({
      ok: true,
      dimensions: { widthPx: 64, heightPx: 64, format: "svg" },
    });
  });

  it("accepts a unit suffix on the pair", () => {
    expect(
      readImageDimensions(utf8('<svg width="64px" height="64px"/>')).ok,
    ).toBe(true);
  });

  it("falls through to the viewBox when the pair is a percentage", () => {
    // A percentage is a fraction of a viewport this file does not have, so it
    // yields no pixel dimension — and must not be accepted as one.
    expect(
      readImageDimensions(
        utf8('<svg width="100%" height="100%" viewBox="0 0 48 48"/>'),
      ),
    ).toEqual({
      ok: true,
      dimensions: { widthPx: 48, heightPx: 48, format: "svg" },
    });
  });

  it("reads a comma-separated viewBox", () => {
    expect(readImageDimensions(utf8('<svg viewBox="0,0,120,120"/>')).ok).toBe(
      true,
    );
  });

  it("survives an XML declaration, doctype and comments before the root", () => {
    const svg = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!-- width="999" height="999" -->',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"/>',
    ].join("\n");
    // The comment carries a decoy width. A regex-based reader takes it.
    expect(readImageDimensions(utf8(svg))).toEqual({
      ok: true,
      dimensions: { widthPx: 256, heightPx: 256, format: "svg" },
    });
  });

  it("ignores a width on a nested element", () => {
    const svg =
      '<svg viewBox="0 0 32 32"><rect width="999" height="999"/></svg>';
    expect(
      readImageDimensions(utf8(svg)).ok && readImageDimensions(utf8(svg)),
    ).toMatchObject({ dimensions: { widthPx: 32, heightPx: 32 } });
  });

  it("refuses XML whose root is not an svg", () => {
    expect(
      readImageDimensions(utf8('<html><svg width="10" height="10"/></html>')),
    ).toEqual({ ok: false, reason: "SVG has no `svg` root element" });
  });

  it("refuses an svg with neither a numeric pair nor a viewBox", () => {
    expect(readImageDimensions(utf8("<svg></svg>"))).toEqual({
      ok: false,
      reason:
        "SVG declares neither a numeric width/height pair nor a numeric viewBox",
    });
  });

  it("refuses a viewBox that is not four numbers", () => {
    expect(readImageDimensions(utf8('<svg viewBox="0 0 48"/>')).ok).toBe(false);
  });

  it("refuses a zero-sized viewBox", () => {
    expect(readImageDimensions(utf8('<svg viewBox="0 0 0 0"/>')).ok).toBe(
      false,
    );
  });

  it("refuses XML that is not well-formed", () => {
    const result = readImageDimensions(utf8('<svg width="10" height="10">'));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(
      /not well-formed|no `svg` root/,
    );
  });
});

describe("format detection", () => {
  it("refuses bytes that match no signature", () => {
    expect(readImageDimensions(utf8("just some text"))).toEqual({
      ok: false,
      reason: "the bytes match no supported image format signature",
    });
  });

  it("refuses an empty file", () => {
    expect(readImageDimensions(new Uint8Array())).toEqual({
      ok: false,
      reason: "the file is empty",
    });
  });

  it("reports the format the bytes are, not the one they are named", () => {
    // A `.png` that is really a JPEG is a real submission mistake. Trusting the
    // extension would produce "truncated PNG" and send the submitter to fix
    // the wrong thing.
    const jpeg = concat(
      bytes(0xff, 0xd8),
      bytes(0xff, 0xc0),
      be16(11),
      bytes(8),
      be16(10),
      be16(10),
      bytes(3),
    );
    expect(sniffImageMimeType(jpeg)).toBe("image/jpeg");
    expect(sniffImageMimeType(png(1, 1))).toBe("image/png");
    expect(sniffImageMimeType(utf8('<svg viewBox="0 0 1 1"/>'))).toBe(
      "image/svg+xml",
    );
    expect(sniffImageMimeType(utf8("nonsense"))).toBeUndefined();
  });
});
