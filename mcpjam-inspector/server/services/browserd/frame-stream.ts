/**
 * The daemon's frame stream: how a hosted browserd ships screencast frames out
 * of its sandbox, and how the inspector reads them back.
 *
 * WHY A BYTE STREAM AND NOT A SOCKET. browserd already produces frames and
 * already gates them on the lease (`daemon/request-handler.ts` `subscribeFrames`
 * re-checks on every one); what it has never had is a way out of the box. The
 * obvious answer is a WebSocket, and it is the wrong one here:
 *
 *   - `ws` cannot be bundled — `scripts/bundle-browserd.mjs` refuses any
 *     `node_modules/` input, because this artifact runs on a box that has
 *     nothing but its own bytes.
 *   - `ws` cannot be external either. The E2B template carries Playwright,
 *     which vendors its own copy inside `playwright-core`, so a bare
 *     `import "ws"` would not resolve at runtime.
 *   - A browser can never reach the daemon regardless: `request-handler.ts`
 *     refuses any request carrying an `Origin` header as DNS-rebinding
 *     defence, and a browser handshake always sends one. Every legitimate
 *     caller is server-side, so a socket's one real advantage is unusable.
 *
 * And the stream only ever flows one way — input travels by HTTP `POST`, as it
 * already does for the local engine. So: a chunked response, read back through
 * the `fetch` the client already has.
 *
 * THE LAYOUT IS `shared/webmcp-inspector-protocol.ts`'s, byte for byte, so the
 * two can be diffed side by side. What it is NOT is that module: its decoder
 * validates `jpegLength === byteLength - 24`, a MESSAGE-level invariant that
 * means nothing in a byte stream, and it answers `undefined` on an unknown
 * kind — which would silently swallow the `end` record below, the one record a
 * reader must never miss. (It is also imported by twenty-odd modules and edited
 * constantly; in this bundle's graph, every one of those edits would rotate
 * `bundleHash` and relaunch every live hosted session.)
 *
 *   offset  type  field
 *   0       u8    version (1)
 *   1       u8    kind (1 frame | 2 heartbeat | 3 end)
 *   2       u16   deviceWidth
 *   4       u16   deviceHeight
 *   6       u16   scale x 1000 (0 => 1.0)
 *   8       f64   ts
 *   16      u32   seq
 *   20      u32   payloadByteLength
 *   24      ...   payload
 *
 * Little-endian throughout. Self-delimiting: read 24 bytes, then exactly
 * `payloadByteLength` more.
 *
 * WHY THERE IS AN `end` RECORD. The status code is spent the moment headers go
 * out, so a stream that dies has no way to say why — and "somebody took the
 * lease" and "the network dropped" call for opposite responses from a pane
 * (wait and resume vs. reconnect). So the reason travels in-band, as the last
 * record. The reader's rule is one line: a body that ends WITH an `end` record
 * is an explained close; a body that ends without one is a drop.
 */

/** Bumped only for an incompatible layout change; readers refuse anything else. */
export const FRAME_STREAM_VERSION = 1;

/** Fixed header on every record. */
export const FRAME_STREAM_HEADER_BYTES = 24;

export const FRAME_STREAM_KIND = {
  /** A painted JPEG. */
  frame: 1,
  /**
   * Proof of life on a page that is not painting.
   *
   * Load-bearing in both directions: it is what lets a reader tell "connected
   * and subscribed" from "connected", and on the daemon side the same tick
   * drives the lease re-check that a one-way stream would otherwise never run.
   */
  heartbeat: 2,
  /** The last record. Payload is a UTF-8 reason. */
  end: 3,
} as const;

export type FrameStreamKind =
  (typeof FRAME_STREAM_KIND)[keyof typeof FRAME_STREAM_KIND];

/**
 * The largest payload a reader will accept, matching the daemon viewport's own
 * `DEFAULT_MAX_FRAME_BYTES` (`daemon/viewport.ts`).
 *
 * This is a READER'S bound, not a writer's: a corrupt length field is otherwise
 * indistinguishable from a record that has not finished arriving, and the
 * reader would wait forever for bytes nobody is going to send.
 */
export const FRAME_STREAM_MAX_PAYLOAD_BYTES = 256 * 1024;

/** Why a stream ended, when it managed to say so. */
export type FrameStreamEndReason =
  /** A person holds the browser; their frames are not this watcher's to see. */
  | "lease_held"
  /** A hold that ran out. Still theirs — see `daemon/lease.ts`. */
  | "lease_parked"
  /** The tab named at subscribe time does not exist. */
  | "unknown_tab"
  /** It existed and then went away: closed, crashed, or navigated off. */
  | "tab_gone"
  /** The daemon is going down. */
  | "shutting_down";

export interface FrameStreamFrame {
  kind: typeof FRAME_STREAM_KIND.frame;
  deviceWidth: number;
  deviceHeight: number;
  /** Device pixels per CSS pixel, so a click scales against what is shown. */
  scale: number;
  /**
   * Capture time on the SANDBOX's clock, which is not the reader's. Fine for
   * ordering within a stream; useless for measuring lag against `Date.now()`.
   */
  ts: number;
  /**
   * The viewport's monotonic counter — and monotonic only WITHIN one viewport.
   * A tab that is re-created starts again at 1 (`daemon/viewport.ts` scopes
   * `seq` to `createTabViewport`), so a reader must not treat a decrease as
   * corruption.
   */
  seq: number;
  /** Raw JPEG bytes. Not base64. */
  jpeg: Uint8Array;
}

export interface FrameStreamHeartbeat {
  kind: typeof FRAME_STREAM_KIND.heartbeat;
}

export interface FrameStreamEnd {
  kind: typeof FRAME_STREAM_KIND.end;
  reason: string;
}

export type FrameStreamRecord =
  | FrameStreamFrame
  | FrameStreamHeartbeat
  | FrameStreamEnd;

/**
 * Pack one record.
 *
 * `scale` rides as thousandths in a u16, which caps it at 65.535 and quantises
 * to 0.001 — both far outside anything a real display produces. `0` reads back
 * as `1`, matching the shared codec's back-compat rule so the layouts stay
 * identical even though this writer always sets it.
 */
export function encodeFrameStreamRecord(record: FrameStreamRecord): Uint8Array {
  const payload =
    record.kind === FRAME_STREAM_KIND.frame
      ? record.jpeg
      : record.kind === FRAME_STREAM_KIND.end
        ? new TextEncoder().encode(record.reason)
        : new Uint8Array(0);

  const bytes = new Uint8Array(FRAME_STREAM_HEADER_BYTES + payload.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, FRAME_STREAM_VERSION);
  view.setUint8(1, record.kind);
  if (record.kind === FRAME_STREAM_KIND.frame) {
    view.setUint16(2, clampU16(record.deviceWidth), true);
    view.setUint16(4, clampU16(record.deviceHeight), true);
    view.setUint16(6, clampU16(Math.round(record.scale * 1000)), true);
    view.setFloat64(8, record.ts, true);
    view.setUint32(16, record.seq >>> 0, true);
  }
  view.setUint32(20, payload.byteLength, true);
  bytes.set(payload, FRAME_STREAM_HEADER_BYTES);
  return bytes;
}

function clampU16(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(0xffff, Math.round(value));
}

export type FrameStreamDecodeResult =
  | { ok: true; records: FrameStreamRecord[] }
  | { ok: false; error: string };

/**
 * A reader that survives chunk boundaries.
 *
 * It has to: a 256 KiB JPEG never arrives in one piece, so a decoder that
 * assumed whole records would work in every test and fail on the first real
 * frame. Bytes accumulate until a full record is present, and only then is one
 * handed back.
 *
 * A violation is TERMINAL, not skippable. There is no framing marker to
 * resynchronise against — once the reader has lost its place in a byte stream
 * it can never find it again — so detection is the whole of the response, and
 * the caller must drop the connection.
 */
export function createFrameStreamDecoder(): {
  push(chunk: Uint8Array): FrameStreamDecodeResult;
} {
  let buffered = new Uint8Array(0);

  return {
    push(chunk: Uint8Array): FrameStreamDecodeResult {
      if (chunk.byteLength > 0) {
        const merged = new Uint8Array(buffered.byteLength + chunk.byteLength);
        merged.set(buffered);
        merged.set(chunk, buffered.byteLength);
        buffered = merged;
      }

      const records: FrameStreamRecord[] = [];
      for (;;) {
        if (buffered.byteLength < FRAME_STREAM_HEADER_BYTES) break;
        const view = new DataView(
          buffered.buffer,
          buffered.byteOffset,
          buffered.byteLength,
        );
        const version = view.getUint8(0);
        if (version !== FRAME_STREAM_VERSION) {
          return { ok: false, error: `unsupported version ${version}` };
        }
        const kind = view.getUint8(1);
        if (
          kind !== FRAME_STREAM_KIND.frame &&
          kind !== FRAME_STREAM_KIND.heartbeat &&
          kind !== FRAME_STREAM_KIND.end
        ) {
          // Deliberately fatal rather than skipped. A kind this reader does not
          // know is a writer it does not understand, and guessing which of its
          // records still mean what they used to is how a silent divergence
          // becomes a garbled pane.
          return { ok: false, error: `unknown record kind ${kind}` };
        }
        const payloadLength = view.getUint32(20, true);
        if (payloadLength > FRAME_STREAM_MAX_PAYLOAD_BYTES) {
          return { ok: false, error: `record too large (${payloadLength})` };
        }
        const total = FRAME_STREAM_HEADER_BYTES + payloadLength;
        if (buffered.byteLength < total) break; // not all here yet

        const payload = buffered.slice(FRAME_STREAM_HEADER_BYTES, total);
        if (kind === FRAME_STREAM_KIND.frame) {
          const rawScale = view.getUint16(6, true);
          records.push({
            kind: FRAME_STREAM_KIND.frame,
            deviceWidth: view.getUint16(2, true),
            deviceHeight: view.getUint16(4, true),
            scale: rawScale === 0 ? 1 : rawScale / 1000,
            ts: view.getFloat64(8, true),
            seq: view.getUint32(16, true),
            jpeg: payload,
          });
        } else if (kind === FRAME_STREAM_KIND.heartbeat) {
          records.push({ kind: FRAME_STREAM_KIND.heartbeat });
        } else {
          records.push({
            kind: FRAME_STREAM_KIND.end,
            reason: new TextDecoder().decode(payload),
          });
        }
        buffered = buffered.slice(total);
      }
      return { ok: true, records };
    },
  };
}
