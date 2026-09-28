/** Limits and implementation identity apply only to responseCloseTo. */
export const MAX_RESPONSE_CLOSE_TO_CHARS = 100_000;
export const MAX_RESPONSE_CLOSE_TO_CELLS = 4_000_000;
export const RESPONSE_CLOSE_TO_IMPLEMENTATION = {
  implementationVersion: 1,
  algorithm: "levenshtein-code-points",
  maxCells: MAX_RESPONSE_CLOSE_TO_CELLS,
  maxInputChars: MAX_RESPONSE_CLOSE_TO_CHARS,
} as const;
export function normalizeCloseToText(
  value: string,
  options: { caseSensitive?: boolean; normalizeWhitespace?: boolean }
): string {
  let text = options.caseSensitive ? value : value.toLowerCase();
  if (options.normalizeWhitespace) text = text.replace(/\s+/gu, " ").trim();
  return text;
}
/** Two-row exact distance over Unicode code points. No NFC/NFKC equivalence. */
export function normalizedResponseDistance(
  message: string,
  reference: string,
  options: { caseSensitive?: boolean; normalizeWhitespace?: boolean }
): number {
  if (
    message.length > MAX_RESPONSE_CLOSE_TO_CHARS ||
    reference.length > MAX_RESPONSE_CLOSE_TO_CHARS
  )
    throw new Error("responseCloseTo input exceeds the linear input limit");
  const left = normalizeCloseToText(message, options),
    right = normalizeCloseToText(reference, options);
  if (!right.length)
    throw new Error("responseCloseTo reference is empty after normalization");
  if (
    left.length > MAX_RESPONSE_CLOSE_TO_CHARS ||
    right.length > MAX_RESPONSE_CLOSE_TO_CHARS
  )
    throw new Error(
      "responseCloseTo normalized input exceeds the linear input limit"
    );
  if (left === right) return 0;
  const leftPoints = Array.from(left),
    rightPoints = Array.from(right);
  const denominator = Math.max(leftPoints.length, rightPoints.length);
  // Equal outer spans do not contribute to edit distance. Keep the original
  // denominator: trimming is a work optimization, never score normalization.
  let start = 0,
    leftEnd = leftPoints.length,
    rightEnd = rightPoints.length;
  while (
    start < leftEnd &&
    start < rightEnd &&
    leftPoints[start] === rightPoints[start]
  )
    start++;
  while (
    leftEnd > start &&
    rightEnd > start &&
    leftPoints[leftEnd - 1] === rightPoints[rightEnd - 1]
  ) {
    leftEnd--;
    rightEnd--;
  }
  const a = leftPoints.slice(start, leftEnd),
    b = rightPoints.slice(start, rightEnd);
  if (!a.length || !b.length) return Math.max(a.length, b.length) / denominator;
  if (a.length * b.length > MAX_RESPONSE_CLOSE_TO_CELLS)
    throw new Error(
      "responseCloseTo exceeds the 4000000-cell computation limit"
    );
  // Allocate only the shorter row; the work cap is checked before these arrays.
  const rows = a.length >= b.length ? a : b,
    columns = a.length >= b.length ? b : a;
  let previous = Uint32Array.from({ length: columns.length + 1 }, (_, i) => i),
    current = new Uint32Array(columns.length + 1);
  for (let i = 1; i <= rows.length; i++) {
    current[0] = i;
    for (let j = 1; j <= columns.length; j++)
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (rows[i - 1] === columns[j - 1] ? 0 : 1)
      );
    [previous, current] = [current, previous];
  }
  return previous[columns.length] / denominator;
}
