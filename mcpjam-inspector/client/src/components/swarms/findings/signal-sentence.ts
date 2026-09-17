import type { SwarmWaveSignalCandidate } from "@/lib/swarm-api";

type RailSignalCandidate = Omit<
  SwarmWaveSignalCandidate,
  "detector" | "subjectKind"
> & { detector: string; subjectKind: string };

export function signalSentence(
  c: RailSignalCandidate,
  opts?: { cohort?: "run" | "window" },
): string {
  // Relative detectors compare a slice against everything else measured. On a
  // swarm that population is "the run"; on a hosted surface it is the window
  // of recent visits, and calling those "the run" would name something the
  // reader has no concept of.
  const rest = opts?.cohort === "window" ? "these sessions" : "the run";
  switch (c.detector) {
    case "tool_errors":
      return `${c.subjectLabel} failed ${
        c.metric ?? c.affectedSessions
      }× across ${c.affectedSessions} of ${c.sliceTotal} sessions`;
    case "hallucinated_tool":
      // "Agents" is swarm vocabulary; a hosted visitor talked to one
      // assistant, and never called it an agent.
      return opts?.cohort === "window"
        ? `The assistant called a tool named "${
            c.subjectLabel
          }" that does not exist, in ${c.affectedSessions} ${plural(
            c.affectedSessions,
            "session",
          )}`
        : `Agents invented a tool named "${c.subjectLabel}" in ${
            c.affectedSessions
          } ${plural(c.affectedSessions, "session")}`;
    // ── User Testing detectors ──
    case "negative_feedback":
      return `${c.affectedSessions} of ${c.sliceTotal} rated ${plural(
        c.sliceTotal,
        "session",
      )} left negative feedback${
        c.subjectKind === "route" || c.subjectKind === "path"
          ? ` on ${c.subjectLabel}`
          : ""
      }`;
    case "cohort_struggles":
      return `${c.subjectLabel} visitors struggled in ${c.affectedSessions} of ${c.sliceTotal} sessions`;
    case "terminal_error_concentration":
      return `${c.affectedSessions} of ${
        c.sliceTotal
      } sessions ended on a tool error${
        c.subjectKind === "route" || c.subjectKind === "path"
          ? ` in ${c.subjectLabel}`
          : ""
      }`;
    case "criterion_fail":
      return `"${c.subjectLabel}" failed in ${c.affectedSessions} of ${c.sliceTotal} graded sessions`;
    case "target_failures":
      // UNITS ARE SESSIONS. The detector used to have a second fire path off
      // launch attempts, where this pair counted attempts and the bare
      // "(1 of 2)" read as sessions. That path is gone (launch outcomes are
      // reported as target health, never mined), so the noun is stated.
      return `Tool errors concentrate on ${c.subjectLabel} in ${
        c.affectedSessions
      } of ${c.sliceTotal} ${plural(c.sliceTotal, "session")}`;
    case "persona_struggles":
      return `${c.subjectLabel} struggled in ${c.affectedSessions} of ${c.sliceTotal} sessions`;
    case "marginal_pass":
      return `${c.affectedSessions} ${plural(
        c.affectedSessions,
        "pass",
        "passes",
      )} in "${c.subjectLabel}" barely cleared the judge threshold`;
    case "turn_cap_grind":
      return `${c.affectedSessions} ${plural(
        c.affectedSessions,
        "session",
      )} in "${c.subjectLabel}" ran out the ${c.metric ?? "max"}-turn budget`;
    case "error_recovered_pass":
      return `${c.affectedSessions} passing ${plural(
        c.affectedSessions,
        "session",
      )} in "${c.subjectLabel}" recovered from tool errors first`;
    case "token_outlier":
      return `"${c.subjectLabel}" uses ~${ratioLabel(
        c,
      )} the tokens of the rest of ${rest}`;
    case "latency_outlier":
      return `${c.subjectLabel} p95 latency is ${ratioLabel(
        c,
      )} the rest of ${rest}`;
    case "no_tools_used":
      return `${c.affectedSessions} ${plural(
        c.affectedSessions,
        "session",
      )} in "${c.subjectLabel}" never called a tool`;
    default:
      return `${c.subjectLabel}: ${c.affectedSessions} of ${c.sliceTotal} sessions`;
  }
}

function plural(n: number, singular: string, pluralForm?: string): string {
  return n === 1 ? singular : pluralForm ?? `${singular}s`;
}

function ratioLabel(c: RailSignalCandidate): string {
  if (
    typeof c.metric !== "number" ||
    typeof c.waveMetric !== "number" ||
    c.waveMetric <= 0
  ) {
    return "well above";
  }
  return `${(c.metric / c.waveMetric).toFixed(1)}×`;
}
