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
