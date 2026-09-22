/**
 * MRTR History round-grouping (MCP 2026-07-28 §12.4).
 *
 * A modern multi-round-trip operation produces several raw JSON-RPC frames:
 * the original request, an interim `input_required` result, the retry request
 * carrying the collected `inputResponses`, possibly more interim results, and
 * finally the complete result. In a debugger's History these belong to ONE
 * logical operation — but they must be grouped WITHOUT hiding the raw child
 * frames or rewriting their (fresh, per-leg) JSON-RPC ids, and the interim
 * `input_required` result must never read as a *failed* tool call: it is a
 * successful result that simply asks for more input.
 *
 * These are pure functions over already-captured frames, so both the traffic
 * log and any structured History view can share the exact same grouping and
 * classification. Nothing here mutates its input.
 */

/** One captured JSON-RPC frame (shape shared with the traffic-log store). */
export interface RpcFrame {
  id: string;
  direction: string;
  method: string;
  timestamp: string;
  payload: unknown;
}

/** The three MRTR verbs whose results can be `input_required`. */
const MRTR_METHODS = new Set(["tools/call", "prompts/get", "resources/read"]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * `true` iff `payload` is a JSON-RPC result whose body is an `input_required`
 * result (spec §12: `{ result: { resultType: 'input_required', … } }`, or the
 * bare result body). This is the interim-round marker; such a frame is a
 * SUCCESS that asks for input, never an error.
 */
export function isInputRequiredResultPayload(payload: unknown): boolean {
  const top = asRecord(payload);
  if (!top) return false;
  // JSON-RPC envelope: look inside `.result`; otherwise treat the object as the
  // result body itself.
  const body = asRecord(top.result) ?? top;
  return body.resultType === "input_required";
}

/**
 * `true` iff the frame is the *request* leg of an MRTR verb (initial or retry).
 * A retry additionally carries `params.inputResponses` and/or
 * `params.requestState`.
 */
export function isMrtrRequestPayload(payload: unknown): boolean {
  const top = asRecord(payload);
  if (!top) return false;
  return typeof top.method === "string" && MRTR_METHODS.has(top.method);
}

function isMrtrRetryPayload(payload: unknown): boolean {
  const top = asRecord(payload);
  const params = asRecord(top?.params);
  if (!params) return false;
  return params.inputResponses !== undefined || params.requestState !== undefined;
}

/** Classification of a single frame within an MRTR-aware History. */
export type MrtrFrameRole =
  | "original-request"
  | "interim-result" // an `input_required` result — NEVER a failure
  | "retry-request"
  | "final-result"
  | "unrelated";

/** One grouped logical MRTR operation, preserving its raw child frames. */
export interface MrtrLogicalOp {
  /** Synthetic group id (the original request frame's id). Not a wire id. */
  groupId: string;
  method: string;
  /** Number of retry legs performed (interim `input_required` results). */
  rounds: number;
  /** `true` while no complete (final) result has been seen yet. */
  awaitingInput: boolean;
  /**
   * The raw child frames in capture order — untouched, with their original
   * fresh JSON-RPC ids preserved. The interim `input_required` frames are kept,
   * not dropped, and are role-tagged `interim-result`.
   */
  frames: Array<{ frame: RpcFrame; role: MrtrFrameRole }>;
}

/**
 * Groups a chronological (oldest-first) frame list into logical MRTR
 * operations, leaving non-MRTR frames as singleton groups so a caller can
 * render one flat, order-preserving list where the MRTR rounds are collapsed
 * together. Grouping is by same-verb continuity: an MRTR request opens (or
 * continues, when it is a retry) the current group for that verb; an
 * `input_required` result increments its round and keeps it open; a complete
 * result closes it.
 *
 * Frames are never mutated, dropped, or re-id'd. Interleaved unrelated traffic
 * (pings, notifications) is emitted as its own singleton group in place.
 */
export function groupMrtrRounds(frames: RpcFrame[]): MrtrLogicalOp[] {
  const groups: MrtrLogicalOp[] = [];
  // One open group per verb (locally there is at most one in flight, but keying
  // by verb keeps concurrent verbs from colliding).
  const openByMethod = new Map<string, MrtrLogicalOp>();

  const singleton = (frame: RpcFrame, role: MrtrFrameRole): MrtrLogicalOp => ({
    groupId: frame.id,
    method: frame.method,
    rounds: 0,
    awaitingInput: false,
    frames: [{ frame, role }],
  });

  for (const frame of frames) {
    if (isInputRequiredResultPayload(frame.payload)) {
      // Attach to the open verb group (prefer the same verb when the frame
      // carries one); if none is open (result seen before its request in the
      // capture window), anchor a fresh group on this frame.
      const target =
        openByMethod.get(resultMethodHint(frame) ?? "") ?? anyOpen(openByMethod);
      if (target) {
        target.frames.push({ frame, role: "interim-result" });
        target.rounds += 1;
        target.awaitingInput = true;
      } else {
        const g = singleton(frame, "interim-result");
        g.rounds = 1;
        g.awaitingInput = true;
        groups.push(g);
      }
      continue;
    }

    if (isMrtrRequestPayload(frame.payload)) {
      const method = (asRecord(frame.payload)!.method as string) ?? frame.method;
      const existing = openByMethod.get(method);
      if (existing && (isMrtrRetryPayload(frame.payload) || existing.awaitingInput)) {
        // Retry leg of the open op.
        existing.frames.push({ frame, role: "retry-request" });
        existing.awaitingInput = false;
        continue;
      }
      // A fresh operation.
      const g = singleton(frame, "original-request");
      g.method = method;
      openByMethod.set(method, g);
      groups.push(g);
      continue;
    }

    // A non-input_required RESULT for an open MRTR verb closes it (final).
    if (isResultPayload(frame.payload)) {
      const method = resultMethodHint(frame) ?? frame.method;
      const open = openByMethod.get(method) ?? anyOpen(openByMethod);
      if (open) {
        open.frames.push({ frame, role: "final-result" });
        open.awaitingInput = false;
        openByMethod.delete(open.method);
        continue;
      }
    }

    // Unrelated frame — emit in place.
    groups.push(singleton(frame, "unrelated"));
  }

  return groups;
}

function isResultPayload(payload: unknown): boolean {
  const top = asRecord(payload);
  if (!top) return false;
  return "result" in top || top.resultType !== undefined;
}

function resultMethodHint(frame: RpcFrame): string | undefined {
  return MRTR_METHODS.has(frame.method) ? frame.method : undefined;
}

function anyOpen(open: Map<string, MrtrLogicalOp>): MrtrLogicalOp | undefined {
  for (const g of open.values()) return g;
  return undefined;
}
