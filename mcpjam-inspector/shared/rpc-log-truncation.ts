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
  /** Exact size in UTF-8 bytes, when the producer measured it. */
  bytes?: number;
  /** The ceiling that was crossed, when the exact size was never measured. */
  limitBytes?: number;
  /** Why the payload could not be serialized at all (e.g. a cycle). */
  reason?: string;
  /**
   * The first {@link STRING_HEAD_CHARS} characters of a dropped string, when
   * the budget had room for them. Present only on the marker that replaced a
   * single oversized string, never on a frame-level marker — a frame is an
   * object, and objects are shrunk field by field rather than sliced.
   */
  head?: string;
  /** Short scalars preserved off the original frame — see
   *  {@link truncateRpcPayload}. */
  [key: string]: unknown;
};

/**
 * A string this long is kept whole. It was 256 — a threshold that made sense
 * when the marker was all a reader got either way, and made none once the
 * marker started carrying a head: below 8 KB the head WOULD BE the whole
 * string, so wrapping it in a "truncated" marker would claim a loss that never
 * happened.
 */
const MAX_PRESERVED_STRING_CHARS = 8 * 1024;

/**
 * How much of an oversized string the marker carries. Kept only when the
 * remaining budget has room for all of it: a partial head sized by whatever was
 * left would make the amount you see depend on where in the frame the string
 * happened to sit, which is not a property anyone can reason about while
 * debugging.
 */
const STRING_HEAD_CHARS = 8 * 1024;

/** Room for `_truncated`, `bytes`, and the braces around them. */
const STRING_MARKER_OVERHEAD = 64;

/**
 * The names the marker owns.
 *
 * {@link truncateRpcPayload} merges what it preserved off the source frame with
 * the marker, and these have to come from the marker alone:
 * {@link describeTruncatedRpcPayload} reads them as the marker's account of what
 * it dropped. A frame carrying a root-level `head` renders as "Showing the first
 * 2 B" of a payload nothing ever sliced; one carrying `reason` renders the
 * frame's own string as the reason nothing was recorded.
 *
 * None of them is a JSON-RPC field, so a frame losing one off its envelope costs
 * a reader nothing that a truthful notice does not repay. Spreading the marker
 * last is not enough on its own — it only overwrites the keys the marker
 * happens to carry, and `head`, `bytes` and `reason` are exactly the ones it
 * usually does not.
 */
const MARKER_FIELDS = new Set([
  "_truncated",
  "bytes",
  "limitBytes",
  "reason",
  "head",
]);

/**
 * The two sizes this module measures a string by, counted in one pass.
 *
 * `utf8` is the string's own encoded length — what a marker's `bytes` reports,
 * and what an already-serialized frame is measured by. `json` is what the same
 * string costs INSIDE serialized JSON: those bytes with JSON's escapes applied
 * and the surrounding quotes counted. Every budget here is charged `json`.
 *
 * `value.length` used to stand in for both and is neither. It counts UTF-16
 * code units, so `"日本語"` measured 3 where JSON writes 9, and a control
 * character measured 1 where JSON writes the six of `\u0001`. Undercounting was
 * documented as the tolerable direction — a cap that lets a big value through —
 * but no caller uses it that way: `harness-rpc-log-sink` sizes a Convex
 * document against it, and {@link truncateRpcPayload} promises every caller a
 * result under `limitBytes`. A 16 KB limit returning 24 KB of CJK is not a
 * conservative cap, it is a broken one.
 *
 * Both counters stop once `utf8` passes `budget`. `json` is never smaller than
 * `utf8`, so at that point BOTH are over it and a caller comparing either
 * against the same budget still gets the right answer — while the scan costs at
 * most the budget rather than the string. Pass `Infinity` when the exact size is
 * the point.
 */
export function measureString(
  value: string,
  budget: number,
): { utf8: number; json: number } {
  let utf8 = 0;
  let escapes = 0;
  for (let i = 0; i < value.length; i++) {
    if (utf8 > budget) break;
    const code = value.charCodeAt(i);
    if (code < 0x80) {
      utf8 += 1;
      if (code === 0x22 || code === 0x5c) {
        escapes += 1; // \" and \\
      } else if (code < 0x20) {
        // \b \t \n \f \r have two-character escapes; every other control
        // character is written as \u00xx.
        escapes +=
          code === 8 || code === 9 || code === 10 || code === 12 || code === 13
            ? 1
            : 5;
      }
      continue;
    }
    if (code < 0x800) {
      utf8 += 2;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(i + 1);
      // NaN past the end of the string, so an unpaired trailing high surrogate
      // falls through to the branch below rather than reading off the end.
      if (low >= 0xdc00 && low <= 0xdfff) {
        utf8 += 4;
        i++;
        continue;
      }
    }
    if (code >= 0xd800 && code <= 0xdfff) {
      // An unpaired surrogate encodes as the three-byte replacement character,
      // but `JSON.stringify` writes it as the six of `\udXXX`.
      utf8 += 3;
      escapes += 3;
      continue;
    }
    utf8 += 3;
  }
  return { utf8, json: utf8 + escapes + 2 };
}

/**
 * The first {@link STRING_HEAD_CHARS} characters of a string, never splitting a
 * surrogate pair — half of one is not text, it is a `�` in the panel.
 */
function headOf(value: string): string {
  const last = value.charCodeAt(STRING_HEAD_CHARS - 1);
  return value.slice(
    0,
    last >= 0xd800 && last <= 0xdbff
      ? STRING_HEAD_CHARS - 1
      : STRING_HEAD_CHARS,
  );
}

/**
 * Depth ceiling for the shrink walk. Deep enough for any JSON-RPC frame
 * (`result.content[n].text` is four), shallow enough that a cyclic or
 * adversarially nested value terminates without a stack guard.
 */
const MAX_SHRINK_DEPTH = 8;

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
 * Strings are measured by {@link measureString}, so what is counted is what
 * `JSON.stringify` would actually write — UTF-8, escapes included. Everything
 * else is approximated by a flat constant, which is why this is a ceiling
 * rather than an exact size.
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
      bytes += measureString(node, budget - bytes).json;
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
      bytes += measureString(key, budget - bytes).json + 2; // colon, separator
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
 * So: short own scalars are copied, and every other own field keeps its key.
 * No knowledge of which frame shape (request, response, notification) this was
 * handed is needed.
 *
 * What that field's VALUE becomes is where the cost of the old shape showed.
 * Every non-scalar used to collapse to `{_truncated: true}` at depth one,
 * unconditionally, so a megabyte of text and an empty object produced identical
 * rows: `result` vanished whole, and `result._meta` went with it despite being
 * ~150 bytes that would always have fit. Nothing in the row said how much had
 * been dropped, which is the one fact a reader needs to tell a capped log entry
 * apart from a genuinely empty response.
 *
 * The walk now descends instead, spending a budget as it goes:
 *   - a scalar, or a string that still fits, is copied;
 *   - a longer string becomes `{_truncated, bytes, head}` — its true length and
 *     its first {@link STRING_HEAD_CHARS} characters when they fit, `bytes`
 *     alone when they do not. The length is kept even when the head cannot be:
 *     knowing a value was 2 MB is most of what makes the row readable;
 *   - an object or array is rebuilt field by field until the budget runs out.
 *
 * Two properties from the original are load-bearing and preserved. The walk
 * ABANDONS a partial container the moment the budget is gone rather than
 * filling in the rest — a pathologically wide frame must never be materialized
 * only to be rejected. And the result is re-probed at the end: every caller
 * sizes its own storage on the guarantee that this returns something under
 * `limitBytes` (`harness-rpc-log-sink` guards a Convex document limit with it),
 * so the ceiling holds for every input shape, not just well-formed frames.
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

  let spent = 0;
  let nodes = 0;
  /**
   * The containers currently on the path from the root, so a self-reference
   * becomes one marker instead of {@link MAX_SHRINK_DEPTH} levels of nesting.
   * Entries are removed on the way back out: a value referenced twice as
   * SIBLINGS is not a cycle, and dropping the second copy would hide a field
   * that was perfectly renderable.
   */
  const path = new Set<object>();

  /** The nested marker carries no `limitBytes`; the top level states it once. */
  const dropped = (bytes?: number): TruncatedRpcPayload =>
    bytes === undefined ? { _truncated: true } : { _truncated: true, bytes };

  const shrink = (value: unknown, depth: number): unknown => {
    if (++nodes > MAX_PROBE_NODES) return dropped();

    if (typeof value === "string") {
      const measured = measureString(value, limitBytes - spent);
      if (
        value.length <= MAX_PRESERVED_STRING_CHARS &&
        spent + measured.json <= limitBytes
      ) {
        spent += measured.json;
        return value;
      }
      // Past the fits-whole check the marker reports the size either way, and
      // `measured` stopped at the budget rather than at the end of the string.
      const bytes = measureString(value, Number.POSITIVE_INFINITY).utf8;
      const head = headOf(value);
      // A head equal to the string is not a head. The two constants are equal
      // today so this only fires on a surrogate pair straddling the cut, but
      // the honesty of the marker should not rest on their staying equal.
      if (head.length < value.length) {
        const headBytes = measureString(head, Number.POSITIVE_INFINITY).json;
        if (spent + headBytes + STRING_MARKER_OVERHEAD <= limitBytes) {
          spent += headBytes + STRING_MARKER_OVERHEAD;
          return { _truncated: true, bytes, head };
        }
      }
      spent += STRING_MARKER_OVERHEAD;
      return dropped(bytes);
    }

    if (value === null || typeof value !== "object") {
      spent += 5;
      return value;
    }

    if (depth >= MAX_SHRINK_DEPTH || path.has(value)) return dropped();
    path.add(value);

    if (Array.isArray(value)) {
      spent += 2;
      const out: unknown[] = [];
      for (const item of value) {
        spent += 1;
        if (spent > limitBytes) {
          path.delete(value);
          return dropped();
        }
        out.push(shrink(item, depth + 1));
      }
      path.delete(value);
      return out;
    }

    spent += 2;
    const out: Record<string, unknown> = {};
    for (const key in value as Record<string, unknown>) {
      if (!Object.hasOwn(value, key)) continue;
      spent += measureString(key, limitBytes - spent).json + 2;
      if (spent > limitBytes) {
        path.delete(value);
        return dropped();
      }
      out[key] = shrink((value as Record<string, unknown>)[key], depth + 1);
    }
    path.delete(value);
    return out;
  };

  const shrunk = shrink(payload, 0);
  const preserved: Record<string, unknown> = {};
  if (
    !isTruncatedRpcPayload(shrunk) &&
    typeof shrunk === "object" &&
    shrunk !== null
  ) {
    for (const [key, field] of Object.entries(shrunk)) {
      // Dropped, not overwritten: the marker does not carry `head`, `bytes` or
      // `reason` on every frame, so spreading it last leaves whichever of them
      // the FRAME supplied standing — and the notice then describes the frame's
      // own field as the marker's account of what was dropped. See MARKER_FIELDS.
      if (!MARKER_FIELDS.has(key)) preserved[key] = field;
    }
  }
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
 * One line explaining why a row has no body — or, now, a partial one. Reads the
 * same whichever producer dropped it, and says what the reader lost rather than
 * that something failed.
 *
 * "Not recorded" and "truncated" are deliberately different words. A reader who
 * sees the first 8 KB of a value needs to know the rest exists somewhere; a
 * reader who sees nothing needs to know the row never carried a body at all.
 * One line for both states cannot say which of the two happened, and the
 * difference is what tells a shortened row apart from an empty response.
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
  if (typeof payload.head === "string") {
    // No claim about where the rest is: this module describes frames of every
    // kind, and only SOME of them have a tool-result card holding the original.
    // Measured, not `head.length`: the sentence next to it reports `bytes` in
    // UTF-8, and two numbers in different units invite exactly the comparison
    // that makes a reader think a third of the payload survived.
    return `Payload truncated — ${limit}.${size} Showing the first ${formatBytes(
      measureString(payload.head, Number.POSITIVE_INFINITY).utf8,
    )}.`;
  }
  return `Payload not recorded — ${limit}.${size}`;
}
