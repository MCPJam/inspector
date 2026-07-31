/**
 * browser-live-frame.ts — the "watch it click" wire shape.
 *
 * A live frame is emitted the moment a Computer Use action completes, so a
 * viewer sees the agent drive a widget while it happens. It is deliberately NOT
 * the durable artifact: the persisted `browserInteractionStep` carries the
 * full-resolution screenshot (uploaded to storage once, per turn), while this
 * carries a byte-capped thumbnail that is cheap enough to push down a stream on
 * every click.
 *
 * Two properties the transport depends on:
 *
 *   - Frames are COALESCED, not queued. Only the latest frame per session is
 *     retained, so a click-happy agent can't evict lifecycle or trace events out
 *     of a bounded event buffer.
 *   - `sequence` is monotonic per session, so a consumer can drop a frame that
 *     arrives out of order rather than flashing backwards.
 */

/** Hard cap on a live frame's decoded thumbnail bytes. */
export const LIVE_FRAME_MAX_BYTES = 48 * 1024;

export type LiveBrowserFrame = {
  /** Monotonic per session. A consumer drops anything not greater than what it has. */
  sequence: number;
  /** Persona turn the action belongs to. */
  promptIndex: number;
  /** Identity of the durable step this frame previews — `(toolCallId, stepIndex)`. */
  toolCallId: string;
  stepIndex: number;
  /** Computer Use action verb (`left_click`, `type`, …). */
  action: string;
  coordinateX?: number;
  coordinateY?: number;
  /**
   * Byte-capped thumbnail. ABSENT when the frame couldn't be encoded small
   * enough (or at all) — the frame is still worth delivering for its action
   * metadata, and the viewer keeps showing the last image it had.
   */
  thumbnailBase64?: string;
  thumbnailMediaType?: "image/jpeg" | "image/png";
  /** Wall-clock capture time. */
  ts: number;
};

/**
 * Narrow an untrusted wire value to a live frame at the stream boundary. Frames
 * cross a version gap in both directions (a newer runner streaming to an older
 * client, and a client replaying a buffer written by a newer runner), so a
 * malformed or partial frame must be DROPPED rather than rendered — the same
 * closed-union discipline `isEvalTraceBrowserStepNote` applies to step notes.
 */
export function isLiveBrowserFrame(value: unknown): value is LiveBrowserFrame {
  if (!value || typeof value !== "object") return false;
  const frame = value as Record<string, unknown>;
  if (typeof frame.sequence !== "number" || !Number.isFinite(frame.sequence)) {
    return false;
  }
  if (
    typeof frame.promptIndex !== "number" ||
    typeof frame.stepIndex !== "number" ||
    typeof frame.toolCallId !== "string" ||
    typeof frame.action !== "string" ||
    typeof frame.ts !== "number"
  ) {
    return false;
  }
  if (
    frame.thumbnailBase64 !== undefined &&
    typeof frame.thumbnailBase64 !== "string"
  ) {
    return false;
  }
  return true;
}

/** Stable identity shared with the persisted step and the replay filmstrip. */
export function liveFrameStepKey(frame: LiveBrowserFrame): string {
  return `${frame.toolCallId}:${frame.stepIndex}`;
}
