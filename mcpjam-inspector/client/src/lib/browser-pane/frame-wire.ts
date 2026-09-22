/**
 * Reading the daemon's frames in the browser, and painting them.
 *
 * WHY THE PANE STOPPED TAKING JSON. A frame arrived as base64 inside a JSON
 * envelope: a third more bytes on the wire, a `JSON.parse` of a quarter-megabyte
 * string on the main thread per paint, and a `data:` URL the browser had to
 * re-parse into an image. The bytes the daemon already produced are the same
 * bytes, and `createImageBitmap` decodes them off the main thread.
 *
 * The DECODER is the daemon's own (`shared/browserd-frame-stream.ts`), not a
 * second implementation of it. A chunk-safe byte reader that has lost its place
 * in a stream can never find it again, and the failure mode of two copies is
 * not a compile error — it is a pane that goes permanently blank on a boundary
 * neither author thought about.
 */
import {
  createFrameStreamDecoder,
  FRAME_STREAM_HEADER_BYTES,
  FRAME_STREAM_KIND,
  type FrameStreamRecord,
} from "@/shared/browserd-frame-stream";

/** One H.264 access unit, as the pane's decoder wants it. */
export interface WireVideoUnit {
  /** Contains an IDR: a decoder can start here. */
  key: boolean;
  au: Uint8Array;
  deviceWidth: number;
  deviceHeight: number;
  scale: number;
  relayTs: number;
  seq: number;
  bytes: number;
}

export type { FrameStreamRecord };

/**
 * A decoded picture, ready to draw, plus the geometry a click maps through.
 *
 * `close()` is not optional politeness: an `ImageBitmap` holds a decoded
 * surface — several megabytes at 1024×768 — and the garbage collector has no
 * idea how expensive it is. A pane at 30 fps that forgot to close them would
 * hold a second of decoded video in memory at all times.
 */
export interface DecodedFrame {
  bitmap: ImageBitmap;
  deviceWidth: number;
  deviceHeight: number;
  scale: number;
  /** The relay's clock — the hop this pane can honestly compare itself to. */
  relayTs: number;
  seq: number;
  /** How long the decode took, in ms. */
  decodeMs: number;
  /** The record's size on the wire, for the kbps figure. */
  bytes: number;
}

/**
 * A reader over one socket's binary messages.
 *
 * Stateful, because records cross message boundaries: a 256 KiB JPEG does not
 * arrive in one WebSocket frame, and a decoder that assumed whole records would
 * work in every test and fail on the first real picture.
 */
export function createFrameWireReader(
  handlers: {
    onFrame(frame: DecodedFrame): void;
    /**
     * An H.264 access unit, undecoded.
     *
     * Handed over rather than decoded here because a `VideoDecoder` is a
     * long-lived object with its own configuration and error budget — see
     * `video-decoder.ts`. Absent means the caller did not ask for video, and the
     * decoder below is built to refuse a record it never negotiated.
     */
    onVideo?(unit: WireVideoUnit): void;
    /** Proof of life, with the daemon's counters when it sent them. */
    onHeartbeat?(stats: Record<string, unknown> | undefined): void;
    /** The stream said why it stopped. */
    onEnd?(reason: string): void;
    /**
     * The reader lost its place. TERMINAL: there is no framing marker to
     * resynchronise against, so the caller must drop the connection rather than
     * try to carry on.
     */
    onFatal?(error: string): void;
  },
  options: {
    /**
     * Accept the video records too.
     *
     * Off by default, matching the daemon's own decoder: a reader that never
     * asked for video refuses one at the version check rather than guessing at a
     * kind it does not know.
     */
    video?: boolean;
    sharp?: boolean;
  } = {},
): {
  push(chunk: ArrayBuffer | Uint8Array): void;
  /** Refuse whatever is decoding, without ending the reader. */
  drop(): void;
  /** Stop decoding and release the pending bitmap, if any. */
  close(): void;
} {
  const decoder = createFrameStreamDecoder(options);
  let closed = false;
  /**
   * The newest sequence already handed to the caller.
   *
   * JPEG decode is serial with one newest pending record. A late or replayed
   * record must still not paint over a newer frame already delivered.
   */
  let deliveredSeq = -1;

  type JpegRecord = Extract<
    FrameStreamRecord,
    { kind: typeof FRAME_STREAM_KIND.frame }
  >;
  let decoding = false;
  let pendingRecord: JpegRecord | undefined;
  /**
   * Which run of the stream the decode in flight belongs to.
   *
   * A decode cannot be cancelled, so `drop()` cannot stop one — it can only
   * refuse the result. Without that refusal a caller who stops the stream
   * mid-decode gets one more picture AFTER it asked for none, which is a pane
   * that repaints a page the viewer has already been told it is not watching.
   */
  let deliveryGeneration = 0;
  const decodeRecord = (record: JpegRecord) => {
    decoding = true;
    const generation = deliveryGeneration;
    const jpeg = record.jpeg;
    const startedAt = performance.now();
    // OFF THE MAIN THREAD, which is the whole point of the byte wire:
    // `createImageBitmap` decodes in the browser's own image pipeline,
    // where a `data:` URL assigned to an `<img>` cannot.
    //
    // `.slice()` because the decoder hands back a view into a buffer it
    // goes on appending to; a `Blob` over a live view can decode whatever
    // arrived next instead.
    void createImageBitmap(
      new Blob([jpeg.slice().buffer as ArrayBuffer], {
        type: "image/jpeg",
      }),
    )
      .then((bitmap) => {
        if (
          closed ||
          generation !== deliveryGeneration ||
          record.seq <= deliveredSeq
        ) {
          // The socket went while we were decoding, the caller dropped the
          // picture under us, or a newer one already landed. Nobody will draw
          // this, and nobody else will free it.
          bitmap.close();
          return;
        }
        deliveredSeq = record.seq;
        handlers.onFrame({
          bitmap,
          deviceWidth: record.deviceWidth,
          deviceHeight: record.deviceHeight,
          scale: record.scale,
          relayTs: record.ts,
          seq: record.seq,
          decodeMs: performance.now() - startedAt,
          bytes: jpeg.byteLength + FRAME_STREAM_HEADER_BYTES,
        });
      })
      .catch(() => {
        // A frame that will not decode is one frame. The next paint
        // replaces it, and dropping the connection over it would replace a
        // momentary glitch with a reconnect.
      })
      .finally(() => {
        decoding = false;
        const next = pendingRecord;
        pendingRecord = undefined;
        if (!closed && next) decodeRecord(next);
      });
  };

  return {
    push(chunk) {
      if (closed) return;
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      const decoded = decoder.push(bytes);
      if (!decoded.ok) {
        closed = true;
        pendingRecord = undefined;
        handlers.onFatal?.(decoded.error);
        return;
      }
      for (const record of decoded.records) {
        if (record.kind === FRAME_STREAM_KIND.heartbeat) {
          handlers.onHeartbeat?.(
            record.stats as Record<string, unknown> | undefined,
          );
          continue;
        }
        if (record.kind === FRAME_STREAM_KIND.end) {
          handlers.onEnd?.(record.reason);
          continue;
        }
        if (
          record.kind === FRAME_STREAM_KIND.video_key ||
          record.kind === FRAME_STREAM_KIND.video_delta
        ) {
          handlers.onVideo?.({
            key: record.kind === FRAME_STREAM_KIND.video_key,
            au: record.au,
            deviceWidth: record.deviceWidth,
            deviceHeight: record.deviceHeight,
            scale: record.scale,
            relayTs: record.ts,
            seq: record.seq,
            bytes: record.au.byteLength + FRAME_STREAM_HEADER_BYTES,
          });
          continue;
        }
        if (record.kind !== FRAME_STREAM_KIND.frame) continue;
        if (decoding) {
          if (
            record.seq > deliveredSeq &&
            (!pendingRecord || record.seq > pendingRecord.seq)
          ) {
            pendingRecord = { ...record, jpeg: record.jpeg.slice() };
          }
        } else if (record.seq > deliveredSeq) {
          decodeRecord(record);
        }
      }
    },
    /**
     * Abandon what is in flight, and stay open for what comes next.
     *
     * For a caller that stops showing the picture without closing the socket —
     * live view turned off, a navigation that blanks the pane — where `close()`
     * would end the reader for a stream that is about to carry frames again.
     */
    drop() {
      deliveryGeneration += 1;
      pendingRecord = undefined;
    },
    close() {
      closed = true;
      pendingRecord = undefined;
    },
  };
}

/**
 * Draw a frame onto the pane's canvas.
 *
 * The canvas is sized to the PICTURE, not to the element: CSS scales it to fit
 * (`object-contain`), which keeps the letterbox arithmetic in
 * `toPageCoordinates` exactly as it was for the `<img>` — it reads the
 * element's rectangle and the frame's own geometry, and never the backing
 * store.
 */
export function paintFrame(
  canvas: HTMLCanvasElement,
  frame: { bitmap: ImageBitmap; deviceWidth: number; deviceHeight: number },
): boolean {
  if (canvas.width !== frame.deviceWidth) canvas.width = frame.deviceWidth;
  if (canvas.height !== frame.deviceHeight) canvas.height = frame.deviceHeight;
  const context = canvas.getContext("2d");
  // No 2D context is a browser that cannot paint at all (or a test
  // environment). Reported rather than thrown: the pane's answer is to fall
  // back, not to crash the rail.
  if (!context) return false;
  try {
    context.drawImage(frame.bitmap, 0, 0);
  } catch {
    // A bitmap that has already been closed — a double paint of the same
    // frame. One frame late is a frame; a thrown error inside an effect is a
    // blank rail.
    return false;
  }
  return true;
}
