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
export function createFrameWireReader(handlers: {
  onFrame(frame: DecodedFrame): void;
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
}): {
  push(chunk: ArrayBuffer | Uint8Array): void;
  /** Stop decoding and release the pending bitmap, if any. */
  close(): void;
} {
  const decoder = createFrameStreamDecoder();
  let closed = false;

  return {
    push(chunk) {
      if (closed) return;
      const bytes =
        chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      const decoded = decoder.push(bytes);
      if (!decoded.ok) {
        closed = true;
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
        const startedAt = performance.now();
        // OFF THE MAIN THREAD, which is the whole point of the byte wire:
        // `createImageBitmap` decodes in the browser's own image pipeline,
        // where a `data:` URL assigned to an `<img>` cannot.
        //
        // `.slice()` because the decoder hands back a view into a buffer it
        // goes on appending to; a `Blob` over a live view can decode whatever
        // arrived next instead.
        void createImageBitmap(
          new Blob([record.jpeg.slice().buffer as ArrayBuffer], {
            type: "image/jpeg",
          }),
        )
          .then((bitmap) => {
            if (closed) {
              // The socket went while we were decoding. Nobody will draw this,
              // and nobody else will free it.
              bitmap.close();
              return;
            }
            handlers.onFrame({
              bitmap,
              deviceWidth: record.deviceWidth,
              deviceHeight: record.deviceHeight,
              scale: record.scale,
              relayTs: record.ts,
              seq: record.seq,
              decodeMs: performance.now() - startedAt,
              bytes: record.jpeg.byteLength + FRAME_STREAM_HEADER_BYTES,
            });
          })
          .catch(() => {
            // A frame that will not decode is one frame. The next paint
            // replaces it, and dropping the connection over it would replace a
            // momentary glitch with a reconnect.
          });
      }
    },
    close() {
      closed = true;
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
