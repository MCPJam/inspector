/**
 * Compact relative time for session list rows — `9d`, `2h`, `3m` — matching
 * the Sessions redesign (no "ago", no long date-fns phrase).
 */
export function formatCompactRelativeTime(
  timestamp: number,
  now: number = Date.now(),
): string {
  const diff = Math.max(0, now - timestamp);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 365) return `${days}d`;
  return `${Math.floor(days / 365)}y`;
}

export function sessionCountLabel(
  count: number,
  { loading = false, canLoadMore = false }: {
    loading?: boolean;
    canLoadMore?: boolean;
  } = {},
): string {
  if (loading) return "Loading sessions…";
  const plus = canLoadMore ? "+" : "";
  return `${count}${plus} total session${count === 1 ? "" : "s"}`;
}
