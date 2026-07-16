import type { CompatVerdict, HostCompatReport } from "@/lib/host-compat/types";

export type CompatDisplayStatus = "green" | "orange" | null;

/**
 * User-facing status deliberately has only two colors. A green status means
 * the profile explicitly covers the capabilities this server uses. Orange
 * means there is a concrete limitation affecting this server. Missing data
 * and informational metadata do not earn either color.
 */
export function getCompatDisplayStatus(
  report: Pick<HostCompatReport, "verdict" | "findings">
): CompatDisplayStatus {
  if (
    report.findings.some(
      (finding) =>
        finding.severity === "blocker" || finding.severity === "degraded"
    )
  ) {
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
    label: "Known limitation",
    dot: "bg-amber-500",
    text: "text-amber-600 dark:text-amber-400",
  },
};

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
