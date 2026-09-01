/**
 * The pixel dimensions of a JPEG, read from its own bytes.
 *
 * WHY BYTES rather than metadata. Every other source of a frame's size is a
 * claim by something other than the picture: CDP's `ScreencastFrameMetadata`
 * reports `deviceWidth`/`deviceHeight` in DIP (CSS pixels) whatever the device
 * scale factor is, a screencast restarted with different bounds can still have
 * an old frame in flight, and `screencastFrame.sessionId` is a frame counter
 * rather than an identity. The client scales pointer coordinates against the
 * dimensions a frame reports, so any disagreement between "what the frame says
 * it is" and "what the frame is" puts every click in the wrong place. The SOF
 * marker cannot disagree with the picture it introduces.
 *
 * Pure, and `Uint8Array`-only: this file compiles into the browser bundle as
 * well as the server, so it cannot reach for `Buffer`. It NEVER THROWS —
 * anything it does not understand is `undefined`, which callers treat as "fall
 * back to what the transport told us".
 */

/** Standalone markers: no length field follows them. */
function isStandalone(marker: number): boolean {
  // RSTn (D0–D7), plus TEM (01).
  return (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01;
}

/** SOF0–SOF15, excluding DHT (C4), JPG (C8) and DAC (CC), which are not SOFs. */
function isStartOfFrame(marker: number): boolean {
  if (marker < 0xc0 || marker > 0xcf) return false;
  return marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

export interface JpegDimensions {
  width: number;
  height: number;
}

/**
 * Walk a JPEG's markers to its frame header.
 *
 * Only the first few hundred bytes are ever read in practice — Chromium writes
 * its SOF well inside the first kilobyte — so callers may hand this a PREFIX of
 * a large frame rather than decoding the whole thing. A prefix that stops short
 * of the SOF reads as `undefined`, exactly like a file that is not a JPEG.
 */
export function readJpegDimensions(
  bytes: Uint8Array,
): JpegDimensions | undefined {
  // SOI. Anything else is not a JPEG at all.
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return undefined;
  }
  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    // Fill bytes: a marker may be preceded by any number of 0xFF.
    let marker = bytes[offset + 1]!;
    while (marker === 0xff && offset + 2 < bytes.length) {
      offset += 1;
      marker = bytes[offset + 1]!;
    }
    // EOI, or the start of entropy-coded scan data: no frame header found, and
    // past SOS the bytes are no longer markers to walk.
    if (marker === 0xd9 || marker === 0xda) return undefined;
    if (isStandalone(marker)) {
      offset += 2;
      continue;
    }
    if (offset + 3 >= bytes.length) return undefined;
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    // A segment declares at least its own length field.
    if (length < 2) return undefined;
    if (isStartOfFrame(marker)) {
      // SOF payload: precision (1), height (2), width (2), components (1).
      // The declared length has to COVER the dimensions, not merely be
      // followed by bytes that look like them: a segment declaring less than
      // that is malformed, and reading past its end would take the next
      // segment's bytes for a picture size — which the caller would then trust
      // over its own fallback.
      if (length < 7 || offset + 8 >= bytes.length) return undefined;
      const height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      const width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!;
      if (width <= 0 || height <= 0) return undefined;
      return { width, height };
    }
    offset += 2 + length;
  }
  return undefined;
}
