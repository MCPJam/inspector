/**
 * Format a minor currency amount (cents/smallest unit) to a localized currency string.
 * @param amount - Numeric value in minor units (e.g., cents for USD)
 * @param currency - ISO 4217 currency code (e.g., "USD", "EUR")
 * @returns Formatted currency string or fallback string if formatting fails
 */
export function formatMinorAmount(amount: unknown, currency: string): string {
  const numeric = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(numeric)) return String(amount ?? "");
  const code = (currency || "USD").toUpperCase();
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
    }).format(numeric / 100);
  } catch {
    return `${numeric / 100} ${code}`;
  }
}
