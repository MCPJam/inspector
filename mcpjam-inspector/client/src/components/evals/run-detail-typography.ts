/**
 * Shared type scale for the run detail view (main column + insight rail).
 *
 * - Hero band: {@link RunAccuracyHeroBand} uses {@link runDetailHeroStatClass}.
 * - Body KPI strip (CI): {@link RunDetailKpiStrip} when `kpiPlacement` is `body`.
 * - Right rail: triage + charts only; section titles stay `text-sm`.
 * - Section bands: {@link runDetailSectionLabelClass} (metrics, recent runs, accuracy).
 * - Tables & chips: {@link runDetailMetaLabelClass} for column chrome; 14px row labels.
 */
export const runDetailSectionTitleClass =
  "text-sm font-medium text-foreground";

/** Column headers and compact field labels (CASE, P50, Client). */
export const runDetailMetaLabelClass =
  "text-xs font-medium uppercase tracking-wide text-muted-foreground";

/** Section titles in run hero, metrics, and AI insights bands. */
export const runDetailSectionLabelClass =
  "text-sm font-semibold tracking-tight text-foreground";

/** Secondary supporting copy */
export const runDetailSupportingClass = "text-xs text-muted-foreground";

/** Mono metrics in tables, chips, and chart axes */
export const runDetailMetricClass =
  "font-mono text-xs tabular-nums text-muted-foreground";

/** Primary readable label in a data row (case title, model name) */
export const runDetailRowLabelClass = "text-sm text-foreground";

/** Hero accuracy on the run detail summary band (page-level headline) */
export const runDetailHeroStatClass =
  "text-3xl font-semibold tabular-nums leading-none tracking-tight text-foreground sm:text-4xl";
