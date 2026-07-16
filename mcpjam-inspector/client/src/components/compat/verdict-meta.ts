import type { CompatVerdict, HostCompatReport } from "@/lib/host-compat/types";

export type CompatDisplayStatus = "green" | "orange" | null;

/**
 * User-facing status deliberately has only two colors. A green status means
 * the profile explicitly covers the server's relevant requirements. Orange
 * means something relevant is unsupported or not verified for this server.
 * Purely cosmetic findings (for example, dropped widget logs) do not earn a
 * color. Missing data stays uncolored while analysis is in progress or failed.
 */
export function getCompatDisplayStatus(
  report: Pick<HostCompatReport, "verdict" | "findings">
): CompatDisplayStatus {
  const needsVerification = report.findings.some(
    (finding) =>
      finding.severity === "blocker" ||
      finding.severity === "degraded" ||
      finding.code === "protocol_version_mismatch"
  );
  if (needsVerification) {
    return "orange";
  }
  return report.verdict === "works" ? "green" : null;
}

export const COMPAT_DISPLAY_META: Record<
  Exclude<CompatDisplayStatus, null>,
  { label: string; dot: string; text: string }
> = {
  green: {
    label: "Supported",
    dot: "bg-emerald-500",
    text: "text-emerald-600 dark:text-emerald-400",
  },
  orange: {
    label: "Not verified",
    dot: "bg-amber-500",
    text: "text-amber-600 dark:text-amber-400",
  },
};

/**
 * Explicit degraded/blocked findings come from a profile that says a required
 * capability is unavailable. Protocol-only uncertainty remains "Not verified"
 * because the host may still negotiate a shared version.
 */
export function getCompatDisplayLabel(
  report: Pick<HostCompatReport, "verdict" | "findings">
): string | null {
  const status = getCompatDisplayStatus(report);
  if (!status) return null;
  if (
    status === "orange" &&
    (report.verdict === "degraded" || report.verdict === "blocked")
  ) {
    return "Unsupported";
  }
  return COMPAT_DISPLAY_META[status].label;
}

/**
 * Three-way semantic tone (good / bad / neutral) → dot + text colors. Shared
 * by surfaces that key on pass/fail rather than a compat verdict (e.g. the
 * live-render status row), so the emerald/red/muted tokens live in one place.
 * (Verdict styling keeps its own `degraded`=amber tone, so the two maps
 * deliberately don't fully collapse.)
 */
export type CompatTone = "ok" | "bad" | "neutral";
export const TONE_META: Record<CompatTone, { dot: string; text: string }> = {
  ok: { dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" },
  bad: { dot: "bg-red-500", text: "text-red-600 dark:text-red-400" },
  neutral: { dot: "bg-muted-foreground/40", text: "text-muted-foreground" },
};

/**
 * Verdict styling shared across the compat surfaces (single-server report rows
 * and the multi-server matrix): a colored dot + colored label, no pill — keeps
 * each verdict to a single quiet visual.
 */
export const VERDICT_META: Record<
  CompatVerdict,
  { label: string; dot: string; text: string }
> = {
  works: {
    label: "Works",
    dot: "bg-emerald-500",
    text: "text-emerald-600 dark:text-emerald-400",
  },
  degraded: {
    label: "Degraded",
    dot: "bg-amber-500",
    text: "text-amber-600 dark:text-amber-400",
  },
  blocked: {
    label: "Blocked",
    dot: "bg-red-500",
    text: "text-red-600 dark:text-red-400",
  },
  unknown: {
    label: "Unknown",
    dot: "bg-muted-foreground/40",
    text: "text-muted-foreground",
  },
};
