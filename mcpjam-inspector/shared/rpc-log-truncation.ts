/**
 * The stand-in a JSON-RPC log payload is replaced with when it is too large to
 * retain.
 *
 * Shared because three retention points independently drop oversized payloads
 * and the Logs panel has to recognize all of them: the in-process replay
 * buffer (`server/services/rpc-log-bus.ts`), the browser store
 * (`client/src/stores/traffic-log-store.ts`), and the cross-instance Convex
 * sink (`server/utils/harness/harness-rpc-log-sink.ts`, which already emitted
 * this shape). One marker means one predicate in the UI.
 *
 * `bytes` and `limitBytes` are both optional because the producers know
 * different things. A producer that already held the serialized string reports
 * the exact `bytes`; one that stopped measuring at a ceiling reports only the
 * `limitBytes` it crossed. Serializing a frame just to size it is the
 * allocation these caps exist to avoid, so "we only know it was over" is the
 * honest answer here, not a gap to fill in.
 */
export type TruncatedRpcPayload = {
  _truncated: true;
  /** Exact serialized size, when the producer already had it in hand. */
  bytes?: number;
  /** The ceiling that was crossed, when the exact size was never measured. */
  limitBytes?: number;
  /** Why the payload could not be serialized at all (e.g. a cycle). */
  reason?: string;
  /** Short scalars preserved off the original frame — see
   *  {@link truncateRpcPayload}. */
  [key: string]: unknown;
};

/**
 * A preserved string this long is a label, not a payload. Anything longer is
 * the thing being dropped.
 */
const MAX_PRESERVED_STRING_CHARS = 256;

/**
 * Node ceiling for {@link probeSerializedSize}. A value with this many nodes is
 * pathological whatever its byte count, and the walk must never become the cost
 * it exists to avoid. Crossing it reports `exceeded`, which truncates — the
 * safe direction, and the same answer a cyclic value gets.
 */
const MAX_PROBE_NODES = 50_000;

/**
 * Approximate serialized size, abandoned as soon as it passes `budget`.
 *
 * Deliberately NOT `JSON.stringify(value).length`. Serializing a multi-megabyte
 * tool result to decide whether to keep it allocates the very string the caller
 * is trying to avoid, and that allocation is itself a recorded main-process
 * crash (INSPECTOR-ELECTRON-VG and -V0, both `Builtin_JsonStringify` ->
 * `Zone::Expand` in the browser process). The walk stops at `budget`, so its
 * cost is bounded by the cap rather than by the value.
 *
 * Counts UTF-16 code units, not UTF-8 bytes, so a CJK payload is undercounted
 * by up to 3x. That is the tolerable direction for a retention cap: it can let
 * an oversized value through, never truncate one that would have fit.
 *
 * Cycles terminate at the node ceiling rather than throwing, so a caller can
 * treat `exceeded` as "do not keep this" without a separate cycle check.
 */
export function probeSerializedSize(
  value: unknown,
  budget: number,
): { bytes: number; exceeded: boolean } {
  let bytes = 0;
  let nodes = 0;
  const stack: unknown[] = [value];

  while (stack.length > 0) {
    if (bytes > budget) return { bytes, exceeded: true };
    if (++nodes > MAX_PROBE_NODES) return { bytes, exceeded: true };

    const node = stack.pop();
    if (typeof node === "string") {
      bytes += node.length + 2; // surrounding quotes
      continue;
    }
    if (node === null || typeof node !== "object") {
      // Numbers, booleans, null and undefined all serialize to a handful of
      // characters. A flat constant is close enough for a size ceiling.
      bytes += 5;
      continue;
    }
    // Both child loops re-check the budget as they go rather than enqueuing
    // every child and testing at the top. A ten-million-element sparse array or
    // an object with that many keys would otherwise build a ten-million-entry
    // stack before the first check — the unbounded allocation this walk exists
    // to avoid, reintroduced inside the avoidance.
    if (Array.isArray(node)) {
      bytes += 2 + node.length; // brackets + separators
      for (const item of node) {
        if (bytes > budget) return { bytes, exceeded: true };
        stack.push(item);
      }
      continue;
    }
    bytes += 2; // braces
    for (const key in node) {
      if (!Object.hasOwn(node, key)) continue;
      bytes += key.length + 4; // quotes, colon, separator
      if (bytes > budget) return { bytes, exceeded: true };
      stack.push((node as Record<string, unknown>)[key]);
    }
  }

  return { bytes, exceeded: bytes > budget };
}

/**
 * Replace a payload too large to keep, preserving the JSON-RPC envelope so the
 * row keeps its identity.
 *
 * Two things have to survive. `jsonrpc`, `id` and `method` are what the Logs
 * panel labels a row by and what correlates a frame to its HTTP exchange, and
 * all three are short scalars — the weight is always in `params` or `result`.
 * `null` counts as one of those scalars: an error response to a frame that
 * never parsed carries `id: null`, and replacing it with a marker would claim a
 * body was dropped where there was none. And the KEY of a dropped field has to
 * stay, because `extractMethod` labels a response by the presence of `result`
 * or `error`; drop the key and every truncated response reads as "unknown"
 * instead of "result".
 *
 * So: short own scalars are copied, and every other own field keeps its key
 * with a nested marker for its value. No knowledge of which frame shape
 * (request, response, notification) this was handed is needed.
 */
export function truncateRpcPayload(
  payload: unknown,
  limitBytes: number,
): TruncatedRpcPayload {
  const marker: TruncatedRpcPayload = { _truncated: true, limitBytes };
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return marker;
  }

  const preserved: Record<string, unknown> = {};
  let preservedBytes = 0;
  for (const key in payload) {
    if (!Object.hasOwn(payload, key)) continue;
    const value = (payload as Record<string, unknown>)[key];
    const isShortScalar =
      value === null ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      (typeof value === "string" && value.length <= MAX_PRESERVED_STRING_CHARS);
    // The nested marker carries no `limitBytes`; the top level states it once.
    preserved[key] = isShortScalar ? value : { _truncated: true };
    // Stop building the envelope the moment it can no longer fit, rather than
    // materializing one entry per key and rejecting the result afterwards: a
    // pathologically wide frame would allocate the whole thing first.
    preservedBytes +=
      key.length + 4 + probeSerializedSize(preserved[key], limitBytes).bytes;
    if (preservedBytes > limitBytes) return marker;
  }
  // Marker last: it must win over any same-named field on the frame.
  const truncated = { ...preserved, ...marker };

  // The loop above bails on the envelope's own size, but the marker fields it
  // does not count still have to fit. Coming back STILL over the limit is the
  // one thing every caller relies on this not doing — they size their own
  // storage on it (`harness-rpc-log-sink` guards a Convex document limit with
  // it), so the ceiling has to hold for every input shape, not just for
  // well-formed JSON-RPC frames.
  return probeSerializedSize(truncated, limitBytes).exceeded
    ? marker
    : truncated;
}

export function isTruncatedRpcPayload(
  payload: unknown,
): payload is TruncatedRpcPayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { _truncated?: unknown })._truncated === true
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * One line explaining why a row has no body. Reads the same whichever producer
 * dropped it, and says what the reader lost rather than that something failed.
 */
export function describeTruncatedRpcPayload(
  payload: TruncatedRpcPayload,
): string {
  if (payload.reason) {
    return `Payload not recorded: ${payload.reason}.`;
  }
  const limit =
    typeof payload.limitBytes === "number"
      ? `over the ${formatBytes(payload.limitBytes)} log limit`
      : "over the log size limit";
  const size =
    typeof payload.bytes === "number"
      ? ` It was ${formatBytes(payload.bytes)}.`
      : "";
  return `Payload not recorded — ${limit}.${size}`;
}
