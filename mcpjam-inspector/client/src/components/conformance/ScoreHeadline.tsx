import {
  describeConformanceScore,
  type ConformanceScore,
} from "@mcpjam/sdk/browser";

/**
 * The one big number, with everything that makes it honest attached to it.
 *
 * Shared by the in-product Conformance panel and score.mcpjam.com so the two
 * cannot disagree about what a score means. Four rules are load-bearing:
 *
 *   - No card at all when nothing was applicable. A "—/100" over a run with
 *     nothing to score is noise dressed as a number.
 *   - The denominator and protocol version always travel with the score.
 *     "100 of 11 applicable" and "100 of 38 applicable" are different servers.
 *   - `notApplicable` and an unscored OAuth suite are stated, never silently
 *     folded in. Not scored and scored zero are opposite claims.
 *   - Checks the run's conformance profile does not score yet are stated too —
 *     `describeConformanceScore` names them, so a reader can tell "asked 36,
 *     scored 36" from "asked 39, scored 36" without opening the report.
 */
export function ScoreHeadline({
  score,
  oauthNotScored = false,
  size = "compact",
}: {
  score: ConformanceScore | undefined;
  /** OAuth produced a score object with nothing applicable in it. */
  oauthNotScored?: boolean;
  size?: "compact" | "hero";
}) {
  if (!score || score.score === null) return null;

  const hero = size === "hero";
  const toneClass =
    score.outcome === "failed"
      ? "text-red-400"
      : score.outcome === "incomplete"
      ? "text-amber-500"
      : "text-green-500";

  return (
    <div
      className={`flex items-center gap-4 rounded-md border border-border/50 bg-muted/30 ${
        hero ? "px-6 py-5" : "px-4 py-3"
      }`}
    >
      <div
        className={`font-semibold tabular-nums leading-none ${
          hero ? "text-6xl" : "text-3xl"
        }`}
      >
        {score.score}
        <span
          className={`ml-0.5 font-normal text-muted-foreground ${
            hero ? "text-lg" : "text-sm"
          }`}
        >
          /100
        </span>
      </div>
      <div className="min-w-0 space-y-0.5">
        <div
          className={`font-medium ${toneClass} ${hero ? "text-sm" : "text-xs"}`}
        >
          {score.outcome === "failed"
            ? "Not conformant"
            : score.outcome === "incomplete"
            ? "Incomplete run"
            : score.advisories.length > 0
            ? "Conformant, with advice"
            : "Fully conformant"}
        </div>
        <div
          className={`truncate text-muted-foreground ${
            hero ? "text-xs" : "text-[11px]"
          }`}
        >
          {describeConformanceScore(score)}
          {score.notApplicable > 0
            ? ` · ${score.notApplicable} not applicable`
            : ""}
          {oauthNotScored
            ? " · OAuth not applicable (no auth) — not scored"
            : ""}
        </div>
      </div>
    </div>
  );
}
