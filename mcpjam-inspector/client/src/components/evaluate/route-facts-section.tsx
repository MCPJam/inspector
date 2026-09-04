/**
 * Collapsed "Routes" and "Expected vs observed" expanders on a case row.
 *
 * Progressive disclosure only. Flag-off callers must not mount this.
 */

import type { EvalRunRouteFacts, EvalRunRouteFactsCase } from "@mcpjam/sdk/contract";

import { EvaluateToolList } from "./evaluate-tool-list";
import { mismatchLines } from "./route-facts-model";

function namesOf(
  rows: readonly { tool: string }[] | undefined,
): string[] {
  return (rows ?? []).map((row) => row.tool);
}

export function RouteFactsSection({
  facts,
  catalogState,
  computedHere,
  variantLabel,
}: {
  facts: EvalRunRouteFactsCase;
  catalogState: EvalRunRouteFacts["catalogState"];
  /** True when the section is using the page-local producer, not the persisted row. */
  computedHere?: boolean;
  /**
   * Which execution variant this section describes. Set only when the row
   * holds more than one, so a single-variant row reads as before.
   */
  variantLabel?: string;
}) {
  const mismatch = facts.mismatch;
  const lines = mismatchLines(facts, catalogState);
  const showMismatch = mismatch.state !== "excludedNegativeTest";
  const expectedNames =
    mismatch.state === "measured" ? namesOf(mismatch.expected) : [];
  const unexpectedNames =
    mismatch.state === "measured" ? namesOf(mismatch.unexpected) : [];
  const missing =
    mismatch.state === "measured"
      ? mismatch.expected
          .filter((row) => row.notCalledIn > 0)
          .map((row) => row.tool)
      : [];

  return (
    <div className="flex flex-col gap-2" data-testid="route-facts-section">
      {variantLabel ? (
        <p
          className="font-mono text-[12px] text-foreground"
          data-testid="route-facts-variant"
        >
          {variantLabel}
        </p>
      ) : null}
      {computedHere ? (
        <p className="text-[12px] text-muted-foreground">computed here</p>
      ) : null}
      <details className="group rounded-lg border border-border/40 bg-muted/20 px-3.5 py-2.5">
        <summary className="cursor-pointer list-none text-[12.5px] text-muted-foreground marker:content-none hover:text-foreground">
          Routes
        </summary>
        <ul className="mt-2 flex flex-col gap-1 text-[12.5px] text-foreground">
          {facts.routes.routes.map((route) => (
            <li key={route.pathKey} className="font-mono">
              {route.pathKey}
              <span className="ml-2 font-sans tabular-nums text-muted-foreground">
                {route.passed}/{route.trials}
              </span>
            </li>
          ))}
          {facts.routes.otherRoutes ? (
            <li className="text-muted-foreground">
              other routes
              <span className="ml-2 tabular-nums">
                {facts.routes.otherRoutes.passed}/{facts.routes.otherRoutes.trials}
              </span>
            </li>
          ) : null}
        </ul>
      </details>

      {showMismatch ? (
        <details className="group rounded-lg border border-border/40 bg-muted/20 px-3.5 py-2.5">
          <summary className="cursor-pointer list-none text-[12.5px] text-muted-foreground marker:content-none hover:text-foreground">
            Expected vs observed
          </summary>
          <p className="mt-2 text-[12px] text-muted-foreground">
            counted by tool name — a call with the wrong arguments counts as
            called
          </p>
          <div className="mt-2 grid gap-4 sm:grid-cols-2">
            <EvaluateToolList
              label="Expected"
              names={expectedNames.filter((name) => !missing.includes(name))}
              missing={missing}
            />
            <EvaluateToolList label="Observed extra" names={unexpectedNames} />
          </div>
          {lines.length > 0 ? (
            <ul className="mt-2.5 flex list-disc flex-col gap-1 pl-4 text-[12.5px] leading-relaxed text-muted-foreground">
              {lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
        </details>
      ) : (
        <p className="text-[12.5px] text-muted-foreground">
          Negative test — mismatch facts are not measured.
        </p>
      )}
    </div>
  );
}
