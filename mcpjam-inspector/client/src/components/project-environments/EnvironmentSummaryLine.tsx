import {
  describeServerScope,
  environmentImageLabel,
  environmentLabel,
  environmentPinCounts,
  type EnvironmentLabelContext,
  type EnvironmentLabelRow,
} from "@/lib/environment-label";

/**
 * The two-or-three line identity block for one environment: label, client, and
 * the composition summary.
 *
 * Shared by the Connect strip, the Environments list, and the ad-hoc detail
 * view so the vocabulary cannot drift between them. It renders the same content
 * `environmentDetailLine` produces as a string — both compose the same helpers
 * — but as JSX, so the sandbox-image chip can carry its tooltip.
 *
 * `label` is an override for callers that ran the list through
 * `disambiguateLabels` and need the `#n`-suffixed form; omit it and the row
 * labels itself.
 */
export function EnvironmentSummaryLine({
  environment,
  ctx,
  label,
  testIdPrefix,
}: {
  environment: EnvironmentLabelRow;
  ctx: EnvironmentLabelContext;
  label?: string;
  /** Set to keep an existing surface's `data-testid` contract intact. */
  testIdPrefix?: string;
}) {
  const displayLabel = label ?? environmentLabel(environment, ctx);
  // Optional call: `hostName` is omitted on surfaces that don't list ad-hoc
  // rows. Every caller of THIS component passes a real context, so the fallback
  // is for type honesty rather than a case we expect to hit.
  const hostName = ctx.hostName?.(environment.hostId) ?? "Unknown client";
  const { skillPins, pluginPins, skillVersionPins } =
    environmentPinCounts(environment);
  const imageLabel = environmentImageLabel(environment, ctx);

  return (
    <>
      <p className="truncate text-sm font-medium">{displayLabel}</p>
      <p className="truncate text-[11px] text-muted-foreground">{hostName}</p>
      <p className="text-[11px] text-muted-foreground">
        {describeServerScope(environment)}
        {" · "}
        {skillPins} skill pin{skillPins === 1 ? "" : "s"}
        {/* Exact-version pins are called out because they change what a future
            edit does: a skill on Latest follows the edit, a pinned one does
            not. */}
        {skillVersionPins > 0 ? ` (${skillVersionPins} at a version)` : ""}
        {" · "}
        {pluginPins} plugin pin{pluginPins === 1 ? "" : "s"}
        {/* Image chip only when pinned AND the computers flag is on — absence is
            semantic (default image), so unpinned rows show nothing rather than a
            filler label. Deleted image ⇒ truncated raw id, never a silent
            blank. */}
        {imageLabel ? (
          <span
            title="Sandbox image for eval runs and published user testing scenarios in this environment — Playground and swarms don't use it yet."
            {...(testIdPrefix
              ? {
                  "data-testid": `${testIdPrefix}-${environment.environmentId}`,
                }
              : {})}
          >
            {" · "}
            {imageLabel}
          </span>
        ) : null}
      </p>
    </>
  );
}
