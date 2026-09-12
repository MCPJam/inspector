/**
 * Approximate a value's serialized size WITHOUT materializing a huge string.
 *
 * A snapshot provider must stay cheap: a multi-megabyte resource/prompt body
 * would otherwise be fully `JSON.stringify`-d just to report its size, blocking
 * the UI thread and defeating the bounded snapshot serializer. This stringifies
 * through a length-tracking replacer that aborts once it has emitted more than
 * `cap`, so the work is bounded regardless of the input. The returned byte count
 * is approximate (it sums primitive lengths, ignoring JSON punctuation/keys) —
 * enough for an "approxSizeBytes" signal, never a payload.
 *
 * TWO budgets, because a scalar-byte cap alone doesn't bound traversal: the
 * replacer runs per node, but a node-heavy shape (deeply nested containers,
 * millions of `null`s / `{}`s) carries almost no scalar bytes, so it would walk
 * the whole structure before tripping `cap`. A separate node budget aborts on
 * container/null-heavy inputs too, so the work is bounded for ALL shapes.
 */
const DEFAULT_NODE_BUDGET = 200_000;

export function boundedJsonByteLength(
  value: unknown,
  cap = 64 * 1024,
  nodeBudget = DEFAULT_NODE_BUDGET,
): { bytes: number; truncated: boolean } {
  let emitted = 0;
  let nodes = 0;
  const OVER = Symbol("over-cap");
  try {
    JSON.stringify(value, (_key, v) => {
      // Every node — string, number, boolean, null, object, array — costs one
      // traversal step; bound the count so node-heavy shapes can't run away.
      nodes += 1;
      if (nodes > nodeBudget) throw OVER;
      if (typeof v === "string") {
        emitted += v.length;
        if (emitted > cap) throw OVER;
      } else if (typeof v === "number" || typeof v === "boolean") {
        emitted += 8;
        if (emitted > cap) throw OVER;
      }
      return v;
    });
    return { bytes: emitted, truncated: false };
  } catch (e) {
    if (e === OVER)
      return { bytes: Math.min(emitted, cap) || cap, truncated: true };
    return { bytes: 0, truncated: false };
  }
}

/**
 * The per-result text budget for a `ui_*` tool, shared by the group helpers
 * that build results (`groups/shared.ts`) and the executor that bounds
 * whatever a handler returns (`ui-tool-execution.ts`). One definition,
 * because a result clamped to one number and checked against another is a
 * silent truncation bug.
 */
export const MAX_RESULT_CHARS = 16 * 1024;

export function clampText(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}… [truncated]`;
}

/**
 * `JSON.stringify` that CANNOT build a string bigger than `cap`, and cannot
 * walk more than `nodeBudget` values getting there.
 *
 * The difference from stringify-then-truncate: that materializes the whole
 * thing first, so a handler returning a 100 MB object costs 100 MB before a
 * single character is thrown away. Here long strings are cut down inside the
 * replacer, and a value that blows either budget aborts the walk and returns
 * `null` — the caller substitutes a marker rather than a head of JSON no
 * reader could parse anyway.
 */
export function boundedJsonString(
  value: unknown,
  cap = MAX_RESULT_CHARS,
  nodeBudget = DEFAULT_NODE_BUDGET,
): string | null {
  let emitted = 0;
  let nodes = 0;
  const OVER = Symbol("over-budget");
  try {
    const text = JSON.stringify(value, (_key, v) => {
      nodes += 1;
      if (nodes > nodeBudget) throw OVER;
      // Everything below counts what this node will COST in the output, and
      // gives up the moment the total would exceed the cap.
      if (typeof v === "string") {
        const room = cap - emitted;
        if (room <= 0) throw OVER;
        emitted += Math.min(v.length, room);
        // Truncate IN the replacer: one multi-megabyte scalar is a single
        // node, so no node budget would catch it.
        return v.length > room ? `${v.slice(0, room)}…` : v;
      }
      if (typeof v === "number" || typeof v === "boolean") {
        emitted += 8;
        if (emitted > cap) throw OVER;
      }
      return v;
    });
    return text ?? null;
  } catch {
    // Over budget, or a value that cannot be serialized at all (a cycle, a
    // throwing `toJSON`). Both mean the same thing to the caller: there is
    // nothing safe to render here.
    return null;
  }
}
