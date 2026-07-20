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
 */
export function boundedJsonByteLength(
  value: unknown,
  cap = 64 * 1024,
): { bytes: number; truncated: boolean } {
  let emitted = 0;
  const OVER = Symbol("over-cap");
  try {
    JSON.stringify(value, (_key, v) => {
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
    if (e === OVER) return { bytes: cap, truncated: true };
    return { bytes: 0, truncated: false };
  }
}
