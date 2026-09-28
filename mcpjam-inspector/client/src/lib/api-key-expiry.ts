/**
 * Expiry for MCPJam API keys (`sk_…`), as the settings pages show it.
 *
 * Every key minted now expires; the server defaults to 90 days and accepts
 * 1–365 (`server/routes/web/api-keys.ts`). A key minted before expiry existed
 * has no `expires_at` and keeps working until someone revokes it — that is
 * shown as "No expiry", never as expired.
 */

/** Lifetimes offered when creating a key, in days. */
export const API_KEY_EXPIRY_OPTIONS = [7, 30, 60, 90, 180, 365] as const;

/** What the create dialog selects unless the user picks another lifetime. */
export const DEFAULT_API_KEY_EXPIRY_DAYS = 90;

/** Within this many days of expiring, a key is flagged as expiring soon. */
const EXPIRING_SOON_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

export type ApiKeyExpiryState = "none" | "active" | "expiring" | "expired";

export interface ApiKeyExpiry {
  state: ApiKeyExpiryState;
  /** Human wording, e.g. "Expires Mar 3, 2027" or "Expired". */
  label: string;
}

function formatDate(instant: number): string {
  return new Date(instant).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** The option label for a lifetime in days. */
export function formatExpiryOption(days: number): string {
  if (days === 365) return "1 year";
  return `${days} days`;
}

export function describeApiKeyExpiry(
  expiresAt: string | null | undefined,
  now: number = Date.now(),
): ApiKeyExpiry {
  const instant = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (!Number.isFinite(instant)) {
    return { state: "none", label: "No expiry" };
  }
  if (instant <= now) {
    return { state: "expired", label: `Expired ${formatDate(instant)}` };
  }
  const daysLeft = Math.ceil((instant - now) / DAY_MS);
  if (daysLeft <= EXPIRING_SOON_DAYS) {
    return {
      state: "expiring",
      label:
        daysLeft === 1 ? "Expires in 1 day" : `Expires in ${daysLeft} days`,
    };
  }
  return { state: "active", label: `Expires ${formatDate(instant)}` };
}

/** Whether a key has stopped working because its expiry has passed. */
export function isApiKeyExpired(
  expiresAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  return describeApiKeyExpiry(expiresAt, now).state === "expired";
}
