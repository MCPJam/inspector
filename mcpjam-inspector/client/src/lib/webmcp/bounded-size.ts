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
    if (e === OVER) return { bytes: Math.min(emitted, cap) || cap, truncated: true };
    return { bytes: 0, truncated: false };
  }
}
