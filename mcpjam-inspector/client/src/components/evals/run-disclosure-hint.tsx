import { ShieldQuestion } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";

import { cn } from "@/lib/utils";
import {
  useRunDisclosure,
  type RunDisclosureState,
} from "@/hooks/use-run-disclosure";

/**
 * Info icon whose tooltip shows what a run of this suite would disclose —
 * which models it calls and where, whether analyzers/judges fire, retention
 * and region facts. Sibling of `RunCostEstimateHint`: purely presentational,
 * the caller owns the fetch state, and the disclosure is fetched only while
 * the tooltip is open (see `use-run-disclosure`).
 *
 * READ-ONLY. This control NEVER gates, disables, or delays the run button —
 * it is a hint beside the CTA, exactly like the cost estimate. A failed or
 * still-loading disclosure changes only what the tooltip says, never whether
 * the run can start.
 *
 * `execution` vs `executionAbsence` render DIFFERENT copy, and the two
 * `executionAbsence` kinds render DIFFERENT copy from each other —
 * `'ingested-run'` ("MCPJam did not execute this") must never be shown for
 * `'plan-unresolved'` ("this WILL execute, models are just not resolved
 * yet"). Collapsing them here would reintroduce, at the presentation layer,
 * the exact bug g4a fixed on the backend.
 */
export function RunDisclosureHint({
  state,
  label = "What this run discloses",
  className,
  side = "bottom",
  align = "center",
}: {
  state: RunDisclosureState;
  label?: string;
  className?: string;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
}) {
  const summary = formatRunDisclosureSummary(state);
  const detail = describeRunDisclosureDetail(state);

  return (
    <Tooltip open={state.open} onOpenChange={state.setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          data-testid="run-disclosure-hint"
          onClick={(e) => {
            // Same reasoning as `RunCostEstimateHint`: stop the click reaching
            // a surrounding row/card handler, without suppressing Radix's own
            // keyboard/touch activation.
            e.stopPropagation();
          }}
          className={cn(
            "rounded-full p-0.5 text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
        >
          <ShieldQuestion className="size-3" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent
        variant="muted"
        side={side}
        align={align}
        className="max-w-[22rem] px-2.5 py-2"
      >
        <div className="space-y-1 text-xs leading-snug">
          <p className="font-medium">{summary}</p>
          {detail.length > 0 ? (
            <ul className="space-y-0.5 text-muted-foreground">
              {detail.map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/** Headline copy, keyed on status and (once loaded) on `execution` vs the two
 *  `executionAbsence` kinds. See the module header — the absence kinds must
 *  never share wording. */
export function formatRunDisclosureSummary(
  state: Pick<RunDisclosureState, "status" | "disclosure" | "error">,
): string {
  if (state.status === "loading" || state.status === "idle") {
    return "Checking what this run discloses…";
  }
  if (state.status === "error" || !state.disclosure) {
    return state.error?.contractUnavailable
      ? "Disclosure not available on this deployment yet"
      : "Disclosure unavailable";
  }
  const { disclosure } = state;
  if (disclosure.execution) {
    const modelCount = disclosure.execution.models.length;
    if (modelCount > 0) {
      return `Calls ${modelCount} model${modelCount === 1 ? "" : "s"} via ${disclosure.execution.engine}`;
    }
    // An empty `models` list with `modelsUnresolved` set means models WILL
    // run but are not derivable here — never the same claim as "no models",
    // which would hide that the launch calls models at all.
    return disclosure.execution.modelsUnresolved
      ? `Runs via ${disclosure.execution.engine} — its models aren't resolved yet`
      : `Runs via ${disclosure.execution.engine}`;
  }
  if (disclosure.executionAbsence?.kind === "ingested-run") {
    return "This run was ingested — MCPJam did not execute it";
  }
  // 'plan-unresolved': WILL execute, models are just not derivable yet. Never
  // rendered as "nothing leaves" — that is the ingested-run copy above.
  return "This run will execute — its models aren't resolved yet";
}

/**
 * The tooltip's detail lines: WHICH models are called and where they route,
 * which analyzers reach where, retention, region, and the subprocessors
 * actually engaged. Every field the contract discloses gets a line — a hint
 * whose whole purpose is disclosure must not silently drop the destinations
 * it promises just to stay short.
 */
export function describeRunDisclosureDetail(
  state: Pick<RunDisclosureState, "status" | "disclosure">,
): string[] {
  if (state.status !== "ready" || !state.disclosure) return [];
  const { disclosure } = state;
  const lines: string[] = [];
  if (disclosure.execution) {
    for (const model of disclosure.execution.models) {
      const destination =
        model.byok?.baseUrlHost ??
        (model.rail.managed
          ? model.rail.possibleDestinations.join(" or ")
          : model.tenantEgress);
      lines.push(`Model: ${model.modelId} — ${destination}`);
    }
    if (disclosure.execution.modelsUnresolved) {
      lines.push(
        `Models: not derivable — ${disclosure.execution.modelsUnresolved.reason}`,
      );
    }
  }
  const firing = disclosure.analysis.filter(
    (touchpoint) => typeof touchpoint.fires === "string",
  );
  if (firing.length > 0) {
    // One line PER touchpoint — different touchpoints can have different
    // destinations, and pooling them under the first one's would misattribute
    // where the others' evidence actually goes.
    for (const touchpoint of firing) {
      lines.push(
        `Analysis: ${touchpoint.label} → ${touchpoint.destinations.join(", ")}`,
      );
    }
  } else {
    lines.push("No analyzer or judge can fire for this run");
  }
  lines.push(
    disclosure.retention.effectiveToday === "kept-indefinitely"
      ? "Retention: kept indefinitely"
      : `Retention: swept after ${disclosure.retention.policyDays ?? "?"} day(s)`,
  );
  lines.push(
    disclosure.region.stated
      ? `Region: ${disclosure.region.value}`
      : "Region: not stated",
  );
  const engagedSubprocessors = disclosure.subprocessors.filter(
    (entry) => entry.engaged,
  );
  if (engagedSubprocessors.length > 0) {
    lines.push(
      `Subprocessors: ${engagedSubprocessors.map((entry) => entry.vendor).join(", ")}`,
    );
  }
  return lines;
}

/**
 * Suite "Run all" variant, gated then mounted exactly like
 * `SuiteRunCostEstimateHint` — the fetch hook lives in a child component only
 * mounted once the gate passes, so a hidden hint touches no network at all.
 */
export function SuiteRunDisclosureHint({
  suiteId,
  environmentIds,
  suppressed = false,
  label = "What running this suite discloses",
  className,
  side = "bottom",
  align = "center",
}: {
  suiteId: string | null | undefined;
  environmentIds?: readonly string[];
  /** Set when Run all cannot launch at all (no cases, no servers configured). */
  suppressed?: boolean;
  label?: string;
  className?: string;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
}) {
  if (suppressed || !suiteId) {
    return null;
  }
  return (
    <SuiteDisclosureFetcher
      suiteId={suiteId}
      environmentIds={environmentIds}
      label={label}
      className={className}
      side={side}
      align={align}
    />
  );
}

function SuiteDisclosureFetcher({
  suiteId,
  environmentIds,
  label,
  className,
  side,
  align,
}: {
  suiteId: string;
  environmentIds?: readonly string[];
  label?: string;
  className?: string;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
}) {
  const state = useRunDisclosure({
    enabled: true,
    suiteId,
    ...(environmentIds && environmentIds.length > 0 ? { environmentIds } : {}),
  });
  return (
    <RunDisclosureHint
      state={state}
      label={label}
      className={className}
      side={side}
      align={align}
    />
  );
}
