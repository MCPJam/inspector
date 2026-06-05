const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export const formatCreditResetText = (resetAt: number): string => {
  if (!resetAt || !Number.isFinite(resetAt)) return "resets daily";
  const diffMs = resetAt - Date.now();
  if (diffMs <= 0) return "resets shortly";
  if (diffMs < MS_PER_HOUR) {
    const minutes = Math.max(1, Math.round(diffMs / 60000));
    return `resets in ${minutes}m`;
  }
  if (diffMs < MS_PER_DAY) {
    const hours = Math.max(1, Math.round(diffMs / MS_PER_HOUR));
    return `resets in ${hours}h`;
  }
  return "resets tomorrow";
};

/**
 * Reset copy for the monthly team allowance. The daily formatter caps at
 * "resets tomorrow" for anything over a day, which is useless across a ~30-day
 * cycle — this one counts in days and appends the absolute reset date so the
 * use-it-or-lose-it refresh is unambiguous ("resets in 12 days (Jun 30)").
 */
export const formatMonthlyResetText = (
  resetAt: number | null | undefined,
  options?: { withDate?: boolean }
): string => {
  if (resetAt == null || !Number.isFinite(resetAt)) return "resets monthly";
  const diffMs = resetAt - Date.now();
  if (diffMs <= 0) return "resets shortly";
  const days = Math.ceil(diffMs / MS_PER_DAY);
  const base = `resets in ${days} day${days === 1 ? "" : "s"}`;
  // The absolute date disambiguates the refresh day, but it crowds the narrow
  // sidebar strip — callers there opt out via { withDate: false }.
  if (options?.withDate === false) return base;
  const date = new Date(resetAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return `${base} (${date})`;
};
