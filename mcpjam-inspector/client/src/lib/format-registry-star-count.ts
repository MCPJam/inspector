/**
 * Format registry star counts for display: exact below 1000, then Nk+ buckets.
 */
export function formatRegistryStarCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "0";
  if (count < 1000) return String(Math.floor(count));
  return `${Math.floor(count / 1000)}k+`;
}
