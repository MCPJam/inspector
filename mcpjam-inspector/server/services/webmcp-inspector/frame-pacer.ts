/**
 * One-slot frame pacing, shared by every transport that ships frames.
 *
 * Lifted verbatim out of `routes/web/webmcp-frames.ts`, which still re-exports
 * it, so the WebMCP frame socket keeps the exact behaviour its tests pin. It
 * moved because the browserd DAEMON needs the same pacing for its own frame
 * stream, and the daemon cannot import a Hono route — it is bundled into an
 * artifact that runs on a box with nothing but its own bytes. A second copy of
 * logic this subtle would drift; a neighbour of `frame-throttle.ts`, which the
 * daemon already imports for the same reason, does not.
 *
 * Deliberately transport-agnostic: it knows only a sink that reports when the
 * bytes were actually taken. A WebSocket's `send(data, cb)` and a
 * `ServerResponse`'s `write(chunk, cb)` are the same shape, which is the whole
 * reason one implementation can serve both.
 */
/** A socket that reports when the OS actually took the bytes. */
export interface CallbackSocket {
  send(data: Uint8Array, cb: (error?: Error) => void): void;
}

/** What one record is worth, when the slot has to choose between two. */
export interface PacedRecord {
  /**
   * Never give this slot up to an ordinary record.
   *
   * For an H.264 KEYFRAME, which is the one record a decoder cannot proceed
   * without: replaced by the delta behind it, the pane sits on a frozen
   * picture until the next GOP — four seconds later — while the deltas it is
   * being sent are undecodable. Two essential records still replace each
   * other, newest wins, because a newer keyframe makes an older one useless.
   */
  essential?: boolean;
  /**
   * Does dropping this record mean the link could not carry a PICTURE?
   *
   * False for a heartbeat: it is liveness and counters, another arrives in ten
   * seconds, and counting its overwrite made `dropped.pacer` describe a link
   * that had dropped nothing at all.
   */
  counts?: boolean;
}

export interface FramePacer {
  /** Offer an encoded frame. Sent now, or held as the one pending frame. */
  push(bytes: Uint8Array, record?: PacedRecord): void;
  /** Stop sending and drop anything held. */
  close(): void;
}

/**
 * Pace frames to what the socket actually drains, holding at most one.
 *
 * CALLBACK-ONLY, with no `bufferedAmount` threshold, and that is the design
 * rather than a simplification. A threshold branch can wedge: the send
 * callback fires while `bufferedAmount` is still above the line, nothing is
 * shipped, and no later event ever wakes the held frame — the pane freezes
 * with the stream healthy. Waiting on the callback bounds kernel-side
 * buffering to a single frame (≤256 KiB by `WEBMCP_FRAME_MAX_BYTES`) with no
 * such branch to get wrong.
 *
 * One pending slot, newest wins — the same philosophy as the SSE route's held
 * frame and the hub's coalesced slot. A queue would make a slow consumer
 * watch an ever-older page; one slot converges it on the current paint.
 */
export function createFramePacer(
  sink: CallbackSocket,
  /**
   * Called when a held frame is REPLACED — the only unambiguous "this socket
   * could not take a frame" event this transport produces.
   *
   * Deliberately not called on the first deferral: holding one frame while a
   * send is outstanding is the pacer working, not the link failing. It is the
   * overwrite that means a second frame arrived before the first was taken.
   */
  onDrop?: () => void,
): FramePacer {
  let inFlight = false;
  let pending: { bytes: Uint8Array; record: PacedRecord } | undefined;
  let closed = false;

  const ship = (bytes: Uint8Array) => {
    inFlight = true;
    sink.send(bytes, () => {
      inFlight = false;
      if (closed) return;
      const next = pending;
      pending = undefined;
      if (next) ship(next.bytes);
    });
  };

  return {
    push(bytes, record = {}) {
      if (closed) return;
      if (inFlight) {
        if (pending !== undefined) {
          // An essential record is not given up for an ordinary one: the
          // INCOMING record goes instead, and the one the consumer cannot
          // proceed without keeps the slot.
          if (pending.record.essential && !record.essential) {
            if (record.counts !== false) onDrop?.();
            return;
          }
          // Newest wins: an older frame nobody has seen yet is worth nothing.
          if (pending.record.counts !== false) onDrop?.();
        }
        pending = { bytes, record };
        return;
      }
      ship(bytes);
    },
    close() {
      closed = true;
      pending = undefined;
    },
  };
}
