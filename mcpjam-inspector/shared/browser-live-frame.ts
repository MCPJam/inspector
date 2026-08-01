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

/**
 * Standard base64: 4-char groups, optionally ending in a padded group. Anchored,
 * so a payload with embedded markup or whitespace fails rather than being handed
 * to a `data:` URI. Empty is allowed through here and treated as "no thumbnail"
 * by the size check below it.
 */
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

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

  // Every number must be FINITE, not merely typed `number`. A NaN `stepIndex`
  // poisons the step key the filmstrip dedupes on; an Infinity `ts` breaks its
  // ordering. `undefined` is fine for the optional coordinates and nothing else.
  const finite = (v: unknown): boolean =>
    typeof v === "number" && Number.isFinite(v);
  const finiteOrAbsent = (v: unknown): boolean => v === undefined || finite(v);

  if (
    !finite(frame.sequence) ||
    !finite(frame.promptIndex) ||
    !finite(frame.stepIndex) ||
    !finite(frame.ts) ||
    !finiteOrAbsent(frame.coordinateX) ||
    !finiteOrAbsent(frame.coordinateY) ||
    typeof frame.toolCallId !== "string" ||
    typeof frame.action !== "string"
  ) {
    return false;
  }

  if (frame.thumbnailBase64 !== undefined) {
    if (typeof frame.thumbnailBase64 !== "string") return false;
    // Charset-check the payload. React escapes the attribute this ends up in and
    // the media type beside it is allowlisted, so a junk value renders a broken
    // image rather than injecting anything — this is defence in depth, and it
    // fails a malformed frame at the boundary instead of shipping a `data:` URI
    // that can only ever 404 in the viewer.
    if (!BASE64_RE.test(frame.thumbnailBase64)) return false;
    // Enforce the byte bound at the READ boundary too, not only at emit. A
    // frame arrives from another process; trusting its size would let a buggy or
    // hostile runner defeat the cap on whoever renders it. base64 inflates 4/3.
    if ((frame.thumbnailBase64.length * 3) / 4 > LIVE_FRAME_MAX_BYTES) {
      return false;
    }
    // The media type is interpolated straight into a `data:` URI downstream, so
    // it must be one of the two literals we actually produce — never arbitrary
    // caller-supplied text.
    if (
      frame.thumbnailMediaType !== undefined &&
      frame.thumbnailMediaType !== "image/jpeg" &&
      frame.thumbnailMediaType !== "image/png"
    ) {
      return false;
    }
  }

  return true;
}

/** Stable identity shared with the persisted step and the replay filmstrip. */
export function liveFrameStepKey(frame: LiveBrowserFrame): string {
  return `${frame.toolCallId}:${frame.stepIndex}`;
}
