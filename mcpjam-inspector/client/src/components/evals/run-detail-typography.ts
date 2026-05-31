/**
 * Shared type scale for the run detail view (main column + insight rail).
 *
 * - Hero band: {@link RunAccuracyHeroBand} uses {@link runDetailHeroStatClass}.
 * - Body KPI strip (CI): {@link RunDetailKpiStrip} when `kpiPlacement` is `body`.
 * - Right rail: triage + charts only; section titles stay `text-sm`.
 * - Tables & chips: 12px (text-xs) for metrics; 14px (text-sm) for primary labels.
 */
export const runDetailSectionTitleClass =
  "text-sm font-medium text-foreground";

/** Column headers, chart titles, chip section labels */
export const runDetailMetaLabelClass =
  "text-xs font-medium uppercase tracking-wide text-muted-foreground";

/** Secondary supporting copy */
export const runDetailSupportingClass = "text-xs text-muted-foreground";

/** Mono metrics in tables, chips, and chart axes */
export const runDetailMetricClass =
  "font-mono text-xs tabular-nums text-muted-foreground";

/** Primary readable label in a data row (case title, model name) */
export const runDetailRowLabelClass = "text-sm text-foreground";

/** Hero accuracy on the run detail summary band (page-level headline) */
export const runDetailHeroStatClass =
  "font-mono text-4xl font-semibold tabular-nums leading-none tracking-tight text-foreground sm:text-5xl";
