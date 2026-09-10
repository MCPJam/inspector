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
 * Protocol edits rotate the daemon bundleHash and relaunch hosted sessions.
 *
 * The inspection socket's single-message adapter delegates to this codec.
 * That adapter additionally requires one complete JPEG per message; this byte
 * stream also supports heartbeat, end and negotiated video records. Keeping
 * the codec here lets the daemon bundle depend on the small wire contract
 * without depending on the inspector's full product protocol.
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

/**
 * The default stream version, and the only one an unnegotiated reader accepts.
 *
 * Bumped only for an incompatible layout change. v2 (below) is not a bump of
 * this: it is requested per stream with `?codec=h264`, so a reader that did not
 * ask can never be handed one — which is what keeps "unknown kind is fatal"
 * safe as the wave adds kinds.
 */
export const FRAME_STREAM_VERSION = 1;

/**
 * The video stream's version.
 *
 * Its own number rather than a bump of the default, because the two carry
 * different KINDS and a v1 reader is deliberately fatal on a kind it does not
 * know. Negotiating per stream means an old reader and a new daemon never meet
 * on a wire either of them can misread.
 */
export const FRAME_STREAM_VERSION_VIDEO = 2;

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
  /**
   * An H.264 access unit that can be decoded on its own — it carries an IDR,
   * and the parameter sets in front of it.
   *
   * Told apart from a delta because a decoder joining mid-stream has to start
   * at one, and because the daemon replays the last one to a late subscriber
   * rather than making them wait out a GOP.
   */
  video_key: 4,
  /** An H.264 access unit that depends on the ones before it. */
  video_delta: 5,
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

/**
 * Per-KIND payload bounds.
 *
 * One number could not serve both: a JPEG above 256 KiB is a frame worth
 * dropping, while an H.264 keyframe of a dense page legitimately exceeds it —
 * the parameter sets and a full intra-coded picture are simply bigger than an
 * inter-coded one. Capping video at the JPEG bound would drop exactly the
 * frames a decoder cannot start without.
 *
 * Still a READER'S bound, for the same reason as before: a corrupt length field
 * is otherwise indistinguishable from a record that has not finished arriving,
 * and the reader would wait forever for bytes nobody is going to send.
 */
export const FRAME_STREAM_MAX_PAYLOAD_BY_KIND: Record<number, number> = {
  [1]: FRAME_STREAM_MAX_PAYLOAD_BYTES, // frame (jpeg)
  [2]: 8 * 1024, // heartbeat (its stats JSON)
  [3]: 1024, // end (a reason)
  [4]: 2 * 1024 * 1024, // video_key
  [5]: 512 * 1024, // video_delta
};

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
  | "shutting_down"
  /**
   * This box cannot encode video: no ffmpeg on the image, the encoder died at
   * spawn, or the kill switch is on. A watcher falls back to JPEG rather than
   * showing an error — the picture is the point, not the codec.
   */
  | "video_unavailable";

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

/**
 * Proof of life, and — since V-4a — what the daemon has been throwing away.
 *
 * The payload is ADDITIVE by construction: v1's decoder already reads the
 * heartbeat's `payloadByteLength`, slices exactly that many bytes and discards
 * them, so an old reader against a new daemon sees the same heartbeat it
 * always did rather than a framing error. That property is what makes this
 * safe to ship without a protocol bump, and it is why the field is optional
 * here rather than required.
 */
export interface FrameStreamHeartbeat {
  kind: typeof FRAME_STREAM_KIND.heartbeat;
  /** UTF-8 JSON. Absent on a heartbeat from a daemon that predates V-4a. */
  stats?: FrameStreamStats;
}

/** What the daemon says about its own side of the stream. */
export interface FrameStreamStats {
  framesIn?: number;
  framesOut?: number;
  bytesOut?: number;
  dropped?: { dedupe?: number; oversize?: number; pacer?: number };
  subscribers?: number;
  /**
   * The encoder has nothing to send.
   *
   * Load-bearing for the adaptive tier: silence from an idle encoder is a
   * quiet page, and reading it as loss would step the quality down on a page
   * that is simply not moving.
   */
  encoderIdle?: boolean;
  /**
   * What is open, and which one is on screen.
   *
   * Rides the heartbeat rather than a record kind of its own: it is only
   * interesting to somebody already reading this stream, it changes rarely, and
   * a new kind would be a protocol bump for a field that is pure information.
   *
   * Load-bearing for the VIDEO stream specifically. That stream grabs the X
   * display, so a model `activate_tab` changes what a watching person is
   * looking at — and kiosk hides Chromium's own tab strip, so nothing else in
   * the picture would say so.
   */
  tabs?: { active?: string; list?: Array<{ id: string; url: string }> };
  /**
   * The page's WebMCP tools, as a CHANGE SIGNAL rather than a list.
   *
   * `{revision, hash, count}` and nothing else: the definitions are big
   * (a declarative `<select>` becomes an `anyOf` branch per option) and this
   * rides an 8 KiB heartbeat several times a second. The pane fetches the real
   * list once, when the revision moves — which turns a poll into an event and
   * is the only reason the Tools pane can be live at all without a second
   * stream.
   *
   * Additive, like `tabs` beside it: an older reader slices this payload by its
   * length and discards what it does not know.
   */
  webmcp?: {
    revision: number;
    hash: string;
    count: number;
    url?: string;
  };
}

export interface FrameStreamEnd {
  kind: typeof FRAME_STREAM_KIND.end;
  reason: string;
}

/**
 * One H.264 access unit.
 *
 * ANNEX-B on the wire, as ffmpeg writes it: start codes, with the parameter
 * sets in front of every key unit (`repeat-headers=1`). The CLIENT converts to
 * AVCC before handing it to `VideoDecoder`, because Safari's support for the
 * `annexb` description format is unverified while AVCC works everywhere — so
 * one conversion in one place beats a per-browser branch.
 *
 * The header's geometry is the CAPTURE's, and `scale` is capture ÷ the CSS
 * viewport, so a click maps through exactly as it does for a JPEG.
 */
export interface FrameStreamVideo {
  kind:
    typeof FRAME_STREAM_KIND.video_key | typeof FRAME_STREAM_KIND.video_delta;
  deviceWidth: number;
  deviceHeight: number;
  scale: number;
  ts: number;
  seq: number;
  /** Raw Annex-B bytes. */
  au: Uint8Array;
}

export type FrameStreamRecord =
  FrameStreamFrame | FrameStreamHeartbeat | FrameStreamEnd | FrameStreamVideo;

/**
 * Pack one record.
 *
 * `scale` rides as thousandths in a u16, which caps it at 65.535 and quantises
 * to 0.001 — both far outside anything a real display produces. `0` reads back
 * as `1`, matching the shared codec's back-compat rule so the layouts stay
 * identical even though this writer always sets it.
 */
export function encodeFrameStreamRecord(record: FrameStreamRecord): Uint8Array {
  const video = isVideoRecord(record);
  const payload =
    record.kind === FRAME_STREAM_KIND.frame
      ? record.jpeg
      : video
        ? record.au
        : record.kind === FRAME_STREAM_KIND.end
          ? new TextEncoder().encode(record.reason)
          : record.stats
            ? new TextEncoder().encode(JSON.stringify(record.stats))
            : new Uint8Array(0);

  const bytes = new Uint8Array(FRAME_STREAM_HEADER_BYTES + payload.byteLength);
  const view = new DataView(bytes.buffer);
  // A video record declares the VIDEO version, so a reader that never asked
  // for one refuses it at the version check rather than at the kind check —
  // the same refusal, one field earlier, and with a message that names the
  // thing that actually happened.
  view.setUint8(0, video ? FRAME_STREAM_VERSION_VIDEO : FRAME_STREAM_VERSION);
  view.setUint8(1, record.kind);
  if (record.kind === FRAME_STREAM_KIND.frame || video) {
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

function isVideoRecord(record: FrameStreamRecord): record is FrameStreamVideo {
  return (
    record.kind === FRAME_STREAM_KIND.video_key ||
    record.kind === FRAME_STREAM_KIND.video_delta
  );
}

function clampU16(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(0xffff, Math.round(value));
}

export type FrameStreamDecodeResult =
  { ok: true; records: FrameStreamRecord[] } | { ok: false; error: string };

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
export function createFrameStreamDecoder(
  options: {
    /**
     * Also accept the VIDEO version and its kinds.
     *
     * Off by default, and that default is what makes "an unknown kind is
     * fatal" safe: a reader that never asked for video can never be handed a
     * record it would have to guess about. The caller turns it on only when it
     * requested `codec=h264`, which is the same negotiation the daemon gates
     * the stream behind.
     */
    video?: boolean;
  } = {},
): {
  push(chunk: Uint8Array): FrameStreamDecodeResult;
} {
  const acceptVideo = options.video === true;
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
        if (
          version !== FRAME_STREAM_VERSION &&
          !(acceptVideo && version === FRAME_STREAM_VERSION_VIDEO)
        ) {
          return { ok: false, error: `unsupported version ${version}` };
        }
        const kind = view.getUint8(1);
        const isVideoKind =
          kind === FRAME_STREAM_KIND.video_key ||
          kind === FRAME_STREAM_KIND.video_delta;
        if (
          kind !== FRAME_STREAM_KIND.frame &&
          kind !== FRAME_STREAM_KIND.heartbeat &&
          kind !== FRAME_STREAM_KIND.end &&
          !(acceptVideo && isVideoKind)
        ) {
          // Deliberately fatal rather than skipped. A kind this reader does not
          // know is a writer it does not understand, and guessing which of its
          // records still mean what they used to is how a silent divergence
          // becomes a garbled pane.
          return { ok: false, error: `unknown record kind ${kind}` };
        }
        const payloadLength = view.getUint32(20, true);
        const maxPayload =
          FRAME_STREAM_MAX_PAYLOAD_BY_KIND[kind] ??
          FRAME_STREAM_MAX_PAYLOAD_BYTES;
        if (payloadLength > maxPayload) {
          return { ok: false, error: `record too large (${payloadLength})` };
        }
        // A frame with no JPEG in it is corruption, not a frame. The encoder
        // cannot produce one, and a reader that forwards it hands the pane an
        // empty `data:image/jpeg;base64,` — which REPLACES the picture with a
        // blank one. Fatal, like every other way this stream can stop making
        // sense: a byte stream that has lost its place cannot be recovered by
        // guessing.
        if (kind === FRAME_STREAM_KIND.frame && payloadLength === 0) {
          return { ok: false, error: "frame record carries no image" };
        }
        // Same rule for video: an access unit with no bytes is not a picture,
        // and handing an empty chunk to a decoder desynchronises it just as
        // surely as losing our place in the stream would.
        if (isVideoKind && payloadLength === 0) {
          return { ok: false, error: "video record carries no access unit" };
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
        } else if (isVideoKind) {
          const rawScale = view.getUint16(6, true);
          records.push({
            kind: kind as FrameStreamVideo["kind"],
            deviceWidth: view.getUint16(2, true),
            deviceHeight: view.getUint16(4, true),
            scale: rawScale === 0 ? 1 : rawScale / 1000,
            ts: view.getFloat64(8, true),
            seq: view.getUint32(16, true),
            au: payload,
          });
        } else if (kind === FRAME_STREAM_KIND.heartbeat) {
          // A payload that will not parse is DROPPED, not fatal. Unlike an
          // unknown kind, this cannot desynchronise the reader — the length
          // field already told us exactly where the record ends — so the
          // recoverable answer is a heartbeat without stats, which is what
          // every heartbeat was before V-4a.
          records.push({
            kind: FRAME_STREAM_KIND.heartbeat,
            ...decodeHeartbeatStats(payload),
          });
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

/** `{ stats }` when the payload is readable, `{}` otherwise. */
function decodeHeartbeatStats(payload: Uint8Array): {
  stats?: FrameStreamStats;
} {
  if (payload.byteLength === 0) return {};
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(payload));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return { stats: parsed as FrameStreamStats };
  } catch {
    return {};
  }
}
