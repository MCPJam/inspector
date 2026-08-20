/**
 * Image dimensions, read from the bytes.
 *
 * WHY HAND-DECODED. The listing rules are about pixels — a minimum edge, a
 * maximum edge, and squareness — and there is no way to check them without
 * knowing the dimensions. Every library that reads them is either Node-only or
 * a native binding, and this module has to run in a browser bundle: the
 * inspector validates a package the user dropped into a page, before anything
 * is uploaded. So the four accepted formats are decoded directly. Each is a
 * fixed-offset header read, which is why this is short rather than a parser.
 *
 * WHY IT REFUSES RATHER THAN GUESSES. Every decoder below returns `undefined`
 * with a REASON when the header is not there, and the reason becomes a
 * `not-evaluated` finding. A decoder that fell back to a plausible default
 * would produce a dimension check that passed on a file whose dimensions were
 * never read — the readiness equivalent of grading a page nobody opened.
 *
 * Pure. No `fs`, no `Buffer`, no DOM: `Uint8Array` in, dimensions out. Safe
 * from the browser entry.
 */

/**
 * The XML surface an SVG dimension read needs — two properties, no more.
 *
 * Deliberately structural rather than a DOM type. The whole point of injecting
 * a parser is that `@xmldom/xmldom` must never appear in the browser entry's
 * import graph (the SDK guards that: it is Node-only credential machinery that
 * drags crypto into a client bundle), while a browser already ships a `DOMParser`
 * that does the job natively. Naming the two properties this module reads keeps
 * both implementations honest and neither of them imported here.
 */
export interface XmlElementLike {
  nodeName: string;
  getAttribute(name: string): string | null;
}

export interface XmlDocumentLike {
  documentElement: XmlElementLike | null | undefined;
}

/**
 * Parse XML into something with a root element, or say why not.
 *
 * Returns a RESULT rather than throwing, and rather than returning a
 * half-built tree: "not well-formed" is one of the portal's own SVG rejections,
 * so it has to be data this module can report, not an exception a caller may or
 * may not catch.
 */
export type XmlParseResult =
  | { ok: true; document: XmlDocumentLike }
  | { ok: false; reason: string };

export type XmlParseFn = (source: string) => XmlParseResult;

export interface ReadImageDimensionsOptions {
  /**
   * How to parse an SVG. Defaults to the platform `DOMParser`, which every
   * browser has and Node does not — so a Node caller that wants SVG support
   * passes `xmldomParseXml` from the Node entry. Absent both, an SVG is
   * REFUSED with a reason naming the missing parser, never graded as malformed:
   * a runtime with no XML parser is our limitation, not the submitter's defect.
   */
  parseXml?: XmlParseFn;
}

export interface ImageDimensions {
  widthPx: number;
  heightPx: number;
  /** The format the bytes were actually recognised as, not the declared MIME. */
  format: "png" | "jpeg" | "webp" | "svg";
}

export type ImageDimensionsResult =
  | { ok: true; dimensions: ImageDimensions }
  | { ok: false; reason: string };

const textDecoder = new TextDecoder("utf-8", { fatal: false });

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out += String.fromCharCode(bytes[offset + index] ?? 0);
  }
  return out;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset + 3] << 24) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 1] << 8) |
      bytes[offset]) >>>
    0
  );
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function looksLikePng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

/**
 * PNG: the IHDR chunk is mandatory and must be FIRST, so width and height are
 * at fixed offsets 16 and 20.
 *
 * The chunk type is still verified rather than assumed. A file with a PNG
 * signature and something else at offset 12 is corrupt, and reading offset 16
 * regardless would report whatever four bytes happened to be there as a width.
 */
function decodePng(bytes: Uint8Array): ImageDimensionsResult {
  if (bytes.length < 24) {
    return { ok: false, reason: "PNG is truncated before its IHDR chunk" };
  }
  if (ascii(bytes, 12, 4) !== "IHDR") {
    return { ok: false, reason: "PNG does not begin with an IHDR chunk" };
  }
  const widthPx = readUint32BE(bytes, 16);
  const heightPx = readUint32BE(bytes, 20);
  if (widthPx === 0 || heightPx === 0) {
    return { ok: false, reason: "PNG declares a zero dimension" };
  }
  return { ok: true, dimensions: { widthPx, heightPx, format: "png" } };
}

/** JPEG markers that carry a frame header, and therefore the dimensions. */
const JPEG_START_OF_FRAME = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/**
 * JPEG: walk the marker segments to the first start-of-frame.
 *
 * There is no fixed offset — EXIF, ICC profiles and comments all come first and
 * all vary in length — so the segments have to be walked. Two details matter
 * and both are easy to get wrong:
 *
 *   - fill bytes: any number of `0xFF` may pad before a marker, so the scanner
 *     skips them rather than assuming exactly one;
 *   - standalone markers (`0xD0`–`0xD9`, `0x01`) carry NO length field, so
 *     reading two bytes as a length there walks the cursor into the middle of
 *     entropy-coded data and finds a "frame" that is not one.
 */
function decodeJpeg(bytes: Uint8Array): ImageDimensionsResult {
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      return { ok: false, reason: "JPEG segment structure is malformed" };
    }
    // Fill bytes: `0xFF 0xFF … 0xFF <marker>` is legal padding.
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined) break;

    // Standalone markers have no payload and no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;

    if (offset + 2 > bytes.length) {
      return { ok: false, reason: "JPEG is truncated inside a segment header" };
    }
    const length = readUint16BE(bytes, offset);
    if (length < 2) {
      return { ok: false, reason: "JPEG segment declares an invalid length" };
    }

    if (JPEG_START_OF_FRAME.has(marker)) {
      if (offset + 7 > bytes.length) {
        return { ok: false, reason: "JPEG frame header is truncated" };
      }
      // Inside a start-of-frame: length(2), precision(1), height(2), width(2).
      const heightPx = readUint16BE(bytes, offset + 3);
      const widthPx = readUint16BE(bytes, offset + 5);
      if (widthPx === 0 || heightPx === 0) {
        return { ok: false, reason: "JPEG declares a zero dimension" };
      }
      return { ok: true, dimensions: { widthPx, heightPx, format: "jpeg" } };
    }
    offset += length;
  }
  // Reached the end with no frame header: the dimensions are genuinely not
  // knowable from these bytes, which is a refusal and not a zero.
  return { ok: false, reason: "JPEG contains no start-of-frame segment" };
}

/**
 * WebP: three different payload layouts under one RIFF container.
 *
 *   - `VP8 ` (lossy) — a 14-bit width and height after a 3-byte sync code;
 *   - `VP8L` (lossless) — 14-bit dimensions packed into a little-endian
 *     bitfield, each stored as value-minus-one;
 *   - `VP8X` (extended) — 24-bit canvas dimensions, also minus one.
 *
 * They share nothing but the container, so a decoder that handled only the
 * common `VP8 ` case would silently refuse every animated or alpha WebP.
 */
function decodeWebp(bytes: Uint8Array): ImageDimensionsResult {
  if (bytes.length < 16 || ascii(bytes, 8, 4) !== "WEBP") {
    return { ok: false, reason: "RIFF container is not a WebP" };
  }
  const chunk = ascii(bytes, 12, 4);

  if (chunk === "VP8 ") {
    if (bytes.length < 30) {
      return { ok: false, reason: "lossy WebP is truncated before its header" };
    }
    // The 3-byte start code that begins a VP8 keyframe.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      return { ok: false, reason: "lossy WebP has no keyframe start code" };
    }
    const widthPx = (bytes[26] | (bytes[27] << 8)) & 0x3fff;
    const heightPx = (bytes[28] | (bytes[29] << 8)) & 0x3fff;
    // The only decoder here whose fields can legitimately read zero: `VP8L` and
    // `VP8X` store their dimensions minus one, so they cannot. Reporting a zero
    // would hand a downstream minimum-edge or squareness rule a failed
    // measurement dressed as a successful one.
    if (widthPx === 0 || heightPx === 0) {
      return { ok: false, reason: "lossy WebP declares a zero dimension" };
    }
    return { ok: true, dimensions: { widthPx, heightPx, format: "webp" } };
  }

  if (chunk === "VP8L") {
    if (bytes.length < 25) {
      return {
        ok: false,
        reason: "lossless WebP is truncated before its header",
      };
    }
    if (bytes[20] !== 0x2f) {
      return { ok: false, reason: "lossless WebP has no signature byte" };
    }
    const bits = readUint32LE(bytes, 21);
    // 14 bits each, stored as (value - 1).
    const widthPx = (bits & 0x3fff) + 1;
    const heightPx = ((bits >> 14) & 0x3fff) + 1;
    return { ok: true, dimensions: { widthPx, heightPx, format: "webp" } };
  }

  if (chunk === "VP8X") {
    if (bytes.length < 30) {
      return {
        ok: false,
        reason: "extended WebP is truncated before its canvas size",
      };
    }
    // 24-bit little-endian canvas dimensions, each stored as (value - 1).
    const widthPx = (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1;
    const heightPx = (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1;
    return { ok: true, dimensions: { widthPx, heightPx, format: "webp" } };
  }

  return {
    ok: false,
    reason: `WebP payload chunk "${chunk}" carries no dimensions`,
  };
}

/**
 * The pixel value of an SVG length, or `undefined` when it does not have one.
 *
 * THE NUMBER PATTERN IS UNAMBIGUOUS ON PURPOSE. `\d*\.?\d+` puts two digit
 * quantifiers side by side, so on a long digit run with a failing suffix the
 * engine tries O(n) splits and consumes O(n) in each — quadratic on input that
 * is an attribute of a submitted SVG. CodeQL flagged it and was right. The
 * alternation below admits exactly one parse of any input.
 *
 * THE EXPONENT IS INSIDE THE CAPTURE. Outside it, `width="1.5e2"` returned
 * `1.5` — a wrong number rather than a refusal, and a downstream dimension rule
 * then graded a file whose width it had misread. Every decoder in this module
 * refuses rather than guesses, and this was the one place that did not.
 */
function parseSvgLength(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const match = value
    .trim()
    .match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)\s*([a-z%]*)$/i);
  if (!match) return undefined;
  // Only an absent unit and `px` are pixels. A percentage is a fraction of a
  // viewport this file does not have, and `em`/`pt`/`mm` need a rendering
  // context nobody supplied — refusing beats inventing a conversion, and
  // treating them as pixels was the same wrong-number failure as the exponent.
  const unit = match[2].toLowerCase();
  if (unit !== "" && unit !== "px") return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * SVG: parsed as XML, never with a regex.
 *
 * A regex over `width="…"` matches inside a comment, inside a nested element,
 * and inside a CDATA block, and misses an attribute written across a newline.
 * The dependency is already here for SAML, so the correct parse is free.
 *
 * The rule the portal states is a disjunction — a numeric `width`/`height` pair
 * OR a numeric `viewBox` — so both are tried, in that order, and a file with
 * only a percentage width falls through to the viewBox rather than being
 * accepted with a meaningless dimension.
 */
/**
 * The platform parser, when the runtime has one.
 *
 * A browser's native `DOMParser` reports a malformed document by returning a
 * tree whose root (or first child) is a `parsererror` element rather than by
 * throwing, so that has to be tested for explicitly — without it, a malformed
 * SVG would present as "an element that is not `svg`", which is a different
 * remediation.
 */
export const NO_XML_PARSER_REASON =
  "no XML parser is available in this runtime; pass `parseXml` (the Node entry exports `xmldomParseXml`)";

function platformParseXml(source: string): XmlParseResult {
  const Parser = (globalThis as { DOMParser?: new () => unknown }).DOMParser;
  if (!Parser) {
    return { ok: false, reason: NO_XML_PARSER_REASON };
  }
  try {
    const document = new (Parser as new () => {
      parseFromString(text: string, type: string): XmlDocumentLike;
    })().parseFromString(source, "image/svg+xml");
    const root = document.documentElement;
    if (root && localName(root.nodeName) === "parsererror") {
      return { ok: false, reason: "the document is not well-formed XML" };
    }
    return { ok: true, document };
  } catch (error) {
    return { ok: false, reason: String(error) };
  }
}

/** `svg` out of `svg`, `SVG` or `svg:svg`. */
function localName(nodeName: string): string {
  return nodeName.toLowerCase().replace(/^.*:/, "");
}

/**
 * SVG: parsed as XML, never with a regex.
 *
 * A regex over `width="…"` matches inside a comment, inside a nested element,
 * and inside a CDATA block, and misses an attribute written across a newline.
 *
 * The rule the portal states is a disjunction — a numeric `width`/`height` pair
 * OR a numeric `viewBox` — so both are tried, in that order, and a file with
 * only a percentage width falls through to the viewBox rather than being
 * accepted with a meaningless dimension.
 */
function decodeSvg(
  source: string,
  parseXml: XmlParseFn,
): ImageDimensionsResult {
  const parsed = parseXml(source);
  if (!parsed.ok) {
    return {
      ok: false,
      reason: `SVG is not well-formed XML: ${parsed.reason}`,
    };
  }

  const root = parsed.document.documentElement;
  if (!root || localName(root.nodeName) !== "svg") {
    return { ok: false, reason: "SVG has no `svg` root element" };
  }

  const width = parseSvgLength(root.getAttribute("width"));
  const height = parseSvgLength(root.getAttribute("height"));
  if (width !== undefined && height !== undefined) {
    return {
      ok: true,
      dimensions: { widthPx: width, heightPx: height, format: "svg" },
    };
  }

  const viewBox = root.getAttribute("viewBox");
  if (viewBox) {
    const parts = viewBox.trim().split(/[\s,]+/);
    if (parts.length === 4) {
      const viewWidth = Number(parts[2]);
      const viewHeight = Number(parts[3]);
      if (
        Number.isFinite(viewWidth) &&
        Number.isFinite(viewHeight) &&
        viewWidth > 0 &&
        viewHeight > 0
      ) {
        return {
          ok: true,
          dimensions: {
            widthPx: viewWidth,
            heightPx: viewHeight,
            format: "svg",
          },
        };
      }
    }
  }

  return {
    ok: false,
    reason:
      "SVG declares neither a numeric width/height pair nor a numeric viewBox",
  };
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  // Sniffed from a prefix rather than the whole file: an SVG may open with an
  // XML declaration, a doctype, comments or a byte-order mark before `<svg`.
  const prefix = textDecoder.decode(bytes.subarray(0, 1024));
  // `<svg/>` is a valid self-closing root, so `/` belongs in the boundary
  // class alongside whitespace and `>`.
  return /<svg[\s/>]/i.test(prefix) || /^\s*(?:﻿)?<\?xml/.test(prefix);
}

/**
 * Read an image's dimensions from its bytes.
 *
 * The DECLARED MIME type is deliberately not consulted. A submitter who names
 * a `.png` that is really a JPEG has a problem the portal will find, and
 * trusting the label would make this decoder report "truncated PNG" for a
 * perfectly good JPEG — sending them to fix the wrong thing.
 */
export function readImageDimensions(
  bytes: Uint8Array,
  options: ReadImageDimensionsOptions = {},
): ImageDimensionsResult {
  if (bytes.length === 0) return { ok: false, reason: "the file is empty" };

  if (looksLikePng(bytes)) return decodePng(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return decodeJpeg(bytes);
  if (ascii(bytes, 0, 4) === "RIFF") return decodeWebp(bytes);
  if (looksLikeSvg(bytes)) {
    return decodeSvg(
      textDecoder.decode(bytes),
      options.parseXml ?? platformParseXml,
    );
  }

  return {
    ok: false,
    reason: "the bytes match no supported image format signature",
  };
}

/** The MIME type these bytes actually are, for contradicting a declared one. */
export function sniffImageMimeType(
  bytes: Uint8Array,
  options: ReadImageDimensionsOptions = {},
): string | undefined {
  const result = readImageDimensions(bytes, options);
  if (!result.ok) return undefined;
  return {
    png: "image/png",
    jpeg: "image/jpeg",
    webp: "image/webp",
    svg: "image/svg+xml",
  }[result.dimensions.format];
}
