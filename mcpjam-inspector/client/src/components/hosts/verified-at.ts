/**
 * One definition of "when did we last check this client profile" — shared by
 * the Host Compare matrix (caniuse) and the client editor header, so the two
 * surfaces can never disagree on the date, the format, or when it goes stale.
 */

const VERIFIED_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "UTC",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Past this age the exact date stops being useful — we say so instead. */
export const STALE_VERIFICATION_MS = 30 * 24 * 60 * 60 * 1000;

/** Shown in place of the date once it crosses `STALE_VERIFICATION_MS`. */
export const STALE_VERIFIED_AT_LABEL = "Last checked over 30 days ago";

export function formatVerifiedAt(verifiedAt: number | undefined): string {
  if (verifiedAt === undefined || !Number.isFinite(verifiedAt)) return "—";
  return VERIFIED_DATE_FORMATTER.format(new Date(verifiedAt));
}

export function isVerifiedAtStale(verifiedAt: number | undefined): boolean {
  if (verifiedAt === undefined || !Number.isFinite(verifiedAt)) return false;
  return Date.now() - verifiedAt > STALE_VERIFICATION_MS;
}

/**
 * The MCPJam profile describes THIS app, so its facts are as fresh as the
 * deploy that shipped them — the catalog's hand-stamped date would age even
 * though the profile never does. Every other host keeps its catalog date.
 */
export function resolveVerifiedAt(
  hostId: string,
  catalogVerifiedAt: number | undefined,
  mcpjamWebDeployedAt: number | null,
): number | undefined {
  if (
    hostId !== "mcpjam" ||
    mcpjamWebDeployedAt === null ||
    !Number.isFinite(mcpjamWebDeployedAt) ||
    mcpjamWebDeployedAt <= 0
  ) {
    return catalogVerifiedAt;
  }
  return mcpjamWebDeployedAt;
}
