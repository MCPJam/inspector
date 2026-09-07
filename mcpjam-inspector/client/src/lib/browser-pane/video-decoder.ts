/**
 * H.264 in the pane.
 *
 * WHY THE STREAM IS CONVERTED BEFORE IT IS DECODED. ffmpeg writes Annex-B —
 * start codes, parameter sets in front of every keyframe — and WebCodecs will
 * take that directly, with `description` omitted, on Chrome. Safari's support
 * for the `annexb` format is unverified, and the failure mode of finding out in
 * production is a browser that silently shows nothing. AVCC (length-prefixed
 * NALs plus an `avcC` description built from the SPS and PPS) works everywhere,
 * so one conversion here beats a per-browser branch and a class of bug that
 * only appears on somebody else's machine.
 *
 * WHAT HAPPENS WHEN IT DOES NOT WORK. Every failure ends in the same place: the
 * caller falls back to the JPEG wire. A browser with no `VideoDecoder` never
 * asks for video at all; a stream that will not configure, or that throws three
 * times, gives up and says so. The picture is the point, not the codec.
 */

/** NAL unit types this module has to recognise. */
const NAL_SPS = 7;
const NAL_PPS = 8;

/**
 * How many decode errors to absorb before giving up on video for the session.
 *
 * More than zero because a single corrupt access unit is survivable — the next
 * keyframe repairs it — and small because a decoder that keeps erroring is
 * showing a person a frozen picture while it tries.
 */
const MAX_DECODE_ERRORS = 3;

/** Can this browser decode video at all? */
export function videoDecodeSupported(): boolean {
  return typeof globalThis.VideoDecoder === "function";
}

/**
 * Split an Annex-B buffer into its NAL units, without the start codes.
 *
 * Byte-exact rather than clever: the emulation-prevention bytes inside a NAL
 * can never produce a start code, which is the property that makes scanning for
 * `00 00 01` safe in the first place.
 */
export function splitNalUnits(bytes: Uint8Array): Uint8Array[] {
  const units: Uint8Array[] = [];
  let start = -1;
  let i = 0;
  while (i + 2 < bytes.byteLength) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
      if (start >= 0) units.push(trimTrailingZeros(bytes.slice(start, i)));
      start = i + 3;
      i += 3;
      continue;
    }
    i += 1;
  }
  if (start >= 0 && start < bytes.byteLength) {
    units.push(trimTrailingZeros(bytes.slice(start)));
  }
  return units.filter((unit) => unit.byteLength > 0);
}

/**
 * A 4-byte start code is `00 00 00 01`, i.e. a 3-byte code with a zero in
 * front — so the scan above leaves that zero on the END of the previous unit.
 */
function trimTrailingZeros(unit: Uint8Array): Uint8Array {
  let end = unit.byteLength;
  while (end > 0 && unit[end - 1] === 0) end -= 1;
  return unit.subarray(0, end);
}

/** The NAL type of a unit whose start code has already been removed. */
function nalType(unit: Uint8Array): number {
  return (unit[0] ?? 0) & 0x1f;
}

/**
 * Build the `avcC` description a `VideoDecoder` configures from.
 *
 * The layout is the one in ISO/IEC 14496-15: a version byte, the three profile
 * bytes lifted straight out of the SPS, the NAL length size, then the parameter
 * sets. Returns undefined when the access unit carried no SPS/PPS — which is
 * every delta unit, and is why configuration waits for a key one.
 */
export function buildAvccDescription(
  units: readonly Uint8Array[],
): Uint8Array | undefined {
  const sps = units.find((unit) => nalType(unit) === NAL_SPS);
  const pps = units.find((unit) => nalType(unit) === NAL_PPS);
  if (!sps || !pps || sps.byteLength < 4) return undefined;

  // SIX header bytes, not seven: version, three profile bytes, the length-size
  // byte and the SPS count. A seventh left a trailing zero on the end of the
  // description, which a strict `VideoDecoder` may reject — and a rejected
  // configure fails on every keyframe, so the pane never sees video at all.
  const size = 6 + 2 + sps.byteLength + 1 + 2 + pps.byteLength;
  const out = new Uint8Array(size);
  let at = 0;
  out[at++] = 1; // configurationVersion
  out[at++] = sps[1]!; // AVCProfileIndication
  out[at++] = sps[2]!; // profile_compatibility
  out[at++] = sps[3]!; // AVCLevelIndication
  out[at++] = 0xff; // 6 reserved bits + lengthSizeMinusOne = 3 (4-byte lengths)
  out[at++] = 0xe1; // 3 reserved bits + numOfSequenceParameterSets = 1
  out[at++] = (sps.byteLength >> 8) & 0xff;
  out[at++] = sps.byteLength & 0xff;
  out.set(sps, at);
  at += sps.byteLength;
  out[at++] = 1; // numOfPictureParameterSets
  out[at++] = (pps.byteLength >> 8) & 0xff;
  out[at++] = pps.byteLength & 0xff;
  out.set(pps, at);
  return out;
}

/**
 * Annex-B start codes → AVCC 4-byte lengths.
 *
 * Parameter sets are DROPPED from the chunk, because they belong in the
 * `description` instead — a decoder configured with an `avcC` and then handed
 * in-band SPS/PPS is being told the same thing twice, and some implementations
 * treat the second telling as an error.
 */
export function annexBToAvcc(units: readonly Uint8Array[]): Uint8Array {
  const payload = units.filter((unit) => {
    const type = nalType(unit);
    return type !== NAL_SPS && type !== NAL_PPS && type !== 9; // no AUD either
  });
  const total = payload.reduce((sum, unit) => sum + 4 + unit.byteLength, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const unit of payload) {
    view.setUint32(at, unit.byteLength);
    at += 4;
    out.set(unit, at);
    at += unit.byteLength;
  }
  return out;
}

/**
 * The codec string for a stream, from the SPS's own profile bytes.
 *
 * Read rather than assumed: `avc1.42E01F` is baseline level 3.1, which is what
 * the daemon asks x264 for — but a level is a function of resolution, and the
 * DPR work exists precisely to change resolution. Reading it means the
 * configuration cannot silently disagree with the stream.
 */
export function codecStringFor(units: readonly Uint8Array[]): string {
  const sps = units.find((unit) => nalType(unit) === NAL_SPS);
  if (!sps || sps.byteLength < 4) return "avc1.42E01F";
  const hex = [sps[1]!, sps[2]!, sps[3]!]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `avc1.${hex.toUpperCase()}`;
}

export interface PaneVideoDecoder {
  /** Hand over one access unit, as it came off the wire. */
  push(unit: { key: boolean; au: Uint8Array; seq: number }): void;
  /** Stop decoding and release the underlying decoder. */
  close(): void;
}

export interface PaneVideoDecoderOptions {
  /**
   * Draw one decoded picture.
   *
   * THE CALLER OWNS IT and must `close()` it — including on the path where it
   * throws. Closing here instead used to be the contract, and it was wrong for
   * the only caller there is: the pane converts the frame with
   * `createImageBitmap`, which resolves later, and a frame closed the moment
   * this returned was a frame being read after it was released.
   *
   * A `VideoFrame` holds a decoded surface the garbage collector cannot see
   * the cost of; a decoder at 30fps whose frames are never closed exhausts the
   * pool within a second and stalls.
   */
  onFrame(frame: VideoFrame): void;
  /**
   * Video is not going to work for this session.
   *
   * The caller's answer is always the same — fall back to the JPEG wire — but
   * the reason is worth carrying so the overlay can say which one it was.
   */
  onGiveUp(reason: string): void;
  /** Injected for tests; the global otherwise. */
  createDecoder?: (init: VideoDecoderInit) => VideoDecoder;
}

export function createPaneVideoDecoder(
  options: PaneVideoDecoderOptions,
): PaneVideoDecoder {
  const construct =
    options.createDecoder ??
    ((init: VideoDecoderInit) => new VideoDecoder(init));
  let decoder: VideoDecoder | undefined;
  let errors = 0;
  let closed = false;

  const giveUp = (reason: string): void => {
    if (closed) return;
    closed = true;
    try {
      decoder?.close();
    } catch {
      // Already closed.
    }
    decoder = undefined;
    options.onGiveUp(reason);
  };

  const onError = (error: unknown): void => {
    errors += 1;
    // A single corrupt access unit is survivable: the next keyframe repairs
    // it. A decoder that keeps erroring is showing a person a frozen picture
    // while it tries, which is worse than an honest fallback.
    if (errors > MAX_DECODE_ERRORS) {
      giveUp(error instanceof Error ? error.message : String(error));
      return;
    }
    // Reset, and wait for the next key unit to configure again.
    try {
      decoder?.close();
    } catch {
      // Already closed.
    }
    decoder = undefined;
  };

  return {
    push(unit) {
      if (closed) return;
      const units = splitNalUnits(unit.au);
      if (!decoder) {
        // ONLY a key unit can start a decoder: the parameter sets it needs
        // ride in front of one, and a delta decodes against a picture that
        // does not exist yet.
        if (!unit.key) return;
        const description = buildAvccDescription(units);
        if (!description) return;
        try {
          const created = construct({
            output: (frame) => {
              try {
                options.onFrame(frame);
              } catch {
                // A handler that threw did not take ownership, so nothing else
                // will release this surface.
                try {
                  frame.close();
                } catch {
                  // Already closed.
                }
              }
            },
            error: onError,
          });
          // ASSIGNED BEFORE `configure`, which can throw: `onError` closes
          // `decoder`, and a decoder that was never assigned is one it cannot
          // reach — so every retry constructed another one nothing released.
          decoder = created;
          created.configure({
            codec: codecStringFor(units),
            description,
            // Latency over throughput: this is somebody watching a page they
            // are about to take control of.
            optimizeForLatency: true,
          });
        } catch (error) {
          onError(error);
          return;
        }
      }
      const data = annexBToAvcc(units);
      if (data.byteLength === 0) return;
      try {
        decoder.decode(
          new EncodedVideoChunk({
            type: unit.key ? "key" : "delta",
            // The wire's own sequence, in microseconds. Monotonic is all a
            // latency-optimised decoder needs, and the wire has no other
            // clock the pane can trust.
            timestamp: unit.seq * 1_000,
            data,
          }),
        );
      } catch (error) {
        onError(error);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        decoder?.close();
      } catch {
        // Already closed.
      }
      decoder = undefined;
    },
  };
}
