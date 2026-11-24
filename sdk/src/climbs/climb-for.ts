/**
 * "Climb for": the one list of things a climb can try to improve. Each option
 * names its measure, the number behind it counted on steering cases, and up to
 * three failed runs from steering cases that point at it.
 *
 * Tokens, cost and tool calls are their own measures. Every option about a part
 * of the server measures pass rate and keeps its suggestions to that part. The
 * counts are of baseline iterations, so they say where the failures point, not
 * how much a change will gain.
 */
import type { PlatformClimb, PlatformClimbMeasure } from "../platform/climb-types.js";
import { pickFailedRuns } from "./failed-runs.js";
import type { ClimbEvidence, ClimbForId, ClimbForOption } from "./types.js";

type Spec = { id: ClimbForId; label: string; measure: PlatformClimbMeasure };

const SPECS: readonly Spec[] = [
  { id: "tool_descriptions", label: "Tool descriptions", measure: "pass_rate" },
  { id: "tool_inputs", label: "Tool inputs", measure: "pass_rate" },
  { id: "pass_rate", label: "Pass rate", measure: "pass_rate" },
  { id: "tokens", label: "Tokens", measure: "tokens" },
  { id: "cost", label: "Cost", measure: "cost" },
  { id: "tool_calls", label: "Tool calls", measure: "tool_calls" },
  { id: "tool_results", label: "Tool results", measure: "pass_rate" },
  { id: "instructions", label: "Instructions", measure: "pass_rate" },
  { id: "skills", label: "Skills", measure: "pass_rate" },
  { id: "apps", label: "Apps", measure: "pass_rate" },
  { id: "prompts_and_resources", label: "Prompts and resources", measure: "pass_rate" },
  { id: "fewer_tools", label: "Fewer tools", measure: "pass_rate" },
  { id: "missing_capability", label: "Something the server lacks", measure: "pass_rate" },
];

/** Which failure categories point at which part of a server. A category can point at more than one. */
const POINTS_AT: Readonly<Record<string, readonly ClimbForId[]>> = {
  metadata: ["tool_descriptions"],
  selection: ["tool_descriptions", "fewer_tools", "instructions"],
  arguments: ["tool_inputs"],
  serverData: ["tool_results"],
  userValue: ["tool_results", "instructions"],
};

const FEWER_TOOLS_FROM = 12;

export function climbForOptions(
  climb: Pick<PlatformClimb, "baseline" | "measure">,
  evidence: readonly ClimbEvidence[],
  server: { toolCount?: number } = {},
): ClimbForOption[] {
  const counted = evidence.filter((item) => item.outcome !== "lost");
  const failed = evidence.filter((item) => item.outcome === "failed");
  const options = SPECS.map((spec): ClimbForOption => {
    if (spec.id === "pass_rate") {
      return option(spec, failed, `${failed.length} of ${counted.length} steering iterations failed`, failed.length);
    }
    const { measure } = spec;
    if (measure !== "pass_rate") return measureOption(spec, measure, climb, counted, failed);
    if (spec.id === "missing_capability") {
      const lacking = failed.filter((item) => item.expectedToolNotListed);
      return option(spec, lacking, `${lacking.length} failed steering iterations expect a tool the server does not list`, lacking.length);
    }
    const pointing = failed.filter((item) =>
      item.failureCategory ? POINTS_AT[item.failureCategory]?.includes(spec.id) === true : false,
    );
    if (spec.id === "fewer_tools" && (server.toolCount ?? 0) < FEWER_TOOLS_FROM) {
      return option(spec, [], `The server lists ${server.toolCount ?? 0} tools, which is not many enough for the number to matter`, 0);
    }
    if (spec.id === "skills" || spec.id === "apps" || spec.id === "prompts_and_resources") {
      return option(spec, [], "No failed steering iteration points at this", 0);
    }
    return option(spec, pointing, `${pointing.length} of ${failed.length} failed steering iterations point at this`, pointing.length);
  });
  // The parts of a server with failures behind them first, then the measures, then the rest.
  const weight = (entry: ClimbForOption) => {
    if (!entry.available) return -1;
    return entry.number.unit === "failed_iterations" ? (entry.number.value ?? 0) * 1000 : 500;
  };
  return options
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => weight(b.entry) - weight(a.entry) || a.index - b.index)
    .map(({ entry }) => entry);
}

function option(spec: Spec, pointing: readonly ClimbEvidence[], text: string, value: number): ClimbForOption {
  return {
    id: spec.id,
    label: spec.label,
    measure: spec.measure,
    available: true,
    number: { value, unit: "failed_iterations", text },
    failedRuns: pickFailedRuns(pointing),
  };
}

const MEASURE_FIELD = { tokens: "tokens", cost: "costUsd", tool_calls: "toolCalls" } as const;
const MEASURE_UNIT = { tokens: "tokens", cost: "usd", tool_calls: "tool_calls" } as const;

function measureOption(
  spec: Spec,
  measure: Exclude<PlatformClimbMeasure, "pass_rate">,
  climb: Pick<PlatformClimb, "baseline">,
  counted: readonly ClimbEvidence[],
  failed: readonly ClimbEvidence[],
): ClimbForOption {
  const unit = MEASURE_UNIT[measure];
  const recording = climb.baseline?.environments.filter((env) => env.recorded[measure]) ?? [];
  if (climb.baseline && recording.length === 0) {
    return {
      id: spec.id,
      label: spec.label,
      measure: spec.measure,
      available: false,
      reason: `No environment recorded ${spec.label.toLowerCase()} on every iteration, so a climb cannot be for it.`,
      number: { value: null, unit, text: "Not recorded" },
      failedRuns: [],
    };
  }
  const field = MEASURE_FIELD[measure];
  const recordingIds = new Set(recording.map((env) => env.environmentId));
  const passing = counted.filter(
    (item) => item.outcome === "passed" && item[field] !== undefined && (recordingIds.size === 0 || recordingIds.has(item.environmentId)),
  );
  const total = passing.reduce((sum, item) => sum + (item[field] ?? 0), 0);
  const mean = passing.length > 0 ? total / passing.length : null;
  const rounded = mean === null ? null : measure === "cost" ? Math.round(mean * 10_000) / 10_000 : Math.round(mean * 10) / 10;
  return {
    id: spec.id,
    label: spec.label,
    measure: spec.measure,
    available: true,
    number: {
      value: rounded,
      unit,
      text:
        rounded === null
          ? "No passing steering iteration recorded it yet"
          : `${rounded} ${measure === "cost" ? "USD" : measure === "tokens" ? "tokens" : "tool calls"} per passing steering iteration`,
    },
    // A climb for this measure is never stopped for lack of failures; the failures shown are context.
    failedRuns: pickFailedRuns(failed),
  };
}
