export type ScoreRunnerPhase =
  | "form"
  | "email"
  | "preparing"
  | "authorizing"
  | "running"
  /**
   * Suites have settled but results may not have committed yet. The save
   * is triggered by an effect after the commit.
   */
  | "run-complete"
  | "saving"
  | "done";

export const SCORE_PREVIEW_DIMENSIONS = [
  "Reliability",
  "Protocol",
  "Apps",
  "OAuth",
  "Security",
] as const;

export function isScoreRunnerBusy(phase: ScoreRunnerPhase): boolean {
  return (
    phase === "preparing" ||
    phase === "running" ||
    phase === "run-complete" ||
    phase === "saving"
  );
}

export function scoreRunnerBusyLabel(phase: ScoreRunnerPhase): string | null {
  if (phase === "preparing") return "Preparing…";
  if (phase === "saving" || phase === "run-complete") return "Saving…";
  if (phase === "running") return "Scanning…";
  return null;
}

export function scoreRunnerCopyStage(
  phase: ScoreRunnerPhase,
): "form" | "email" | "scanning" | "authorizing" | "done" {
  if (phase === "email") return "email";
  if (phase === "authorizing") return "authorizing";
  if (phase === "done") return "done";
  if (
    phase === "preparing" ||
    phase === "running" ||
    phase === "run-complete" ||
    phase === "saving"
  ) {
    return "scanning";
  }
  return "form";
}

export function scoreRunnerHeadline(phase: ScoreRunnerPhase): string {
  switch (scoreRunnerCopyStage(phase)) {
    case "email":
      return "Where should we send the scorecard?";
    case "authorizing":
      return "This server requires authentication.";
    case "scanning":
      return "Scanning your MCP server";
    case "done":
      return "Your scorecard is on its way.";
    default:
      return "Know where your MCP server stands.";
  }
}

export function scoreRunnerLead(phase: ScoreRunnerPhase): string {
  switch (scoreRunnerCopyStage(phase)) {
    case "email":
      return "We'll email you a hosted page with the overall score with breakdowns in each category.";
    case "authorizing":
      return "We can't check what a server does for an authorized client without being one. Authorizing sends you to the server's own login and brings you straight back here to finish the scan.";
    case "scanning":
      return "Preparing your results shortly.";
    case "done":
      return "Find it in your inbox, or open the hosted report in the browser.";
    default:
      return "Paste a public MCP URL. We email a scorecard with assessments across reliability, conformance (protocol, apps, OAuth), and security.";
  }
}
