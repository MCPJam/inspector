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

export function scoreRunnerHeadline(phase: ScoreRunnerPhase): string {
  if (phase === "email") return "Where should we send the scorecard?";
  if (phase === "authorizing") return "This server requires authentication.";
  if (phase === "done") return "Your scorecard is ready.";
  return "Know where your MCP server stands.";
}

export function scoreRunnerLead(phase: ScoreRunnerPhase): string {
  if (phase === "email") {
    return "We'll email a hosted page with the overall score, five dimensions, and the check ledger.";
  }
  if (phase === "authorizing") {
    return "We can't check what a server does for an authorized client without being one. Authorizing sends you to the server's own login and brings you straight back here to finish the scan.";
  }
  if (phase === "done") {
    return "Anyone with this link can read the report. It is not listed anywhere.";
  }
  return "Paste a public MCP URL. We email a scorecard with assessments across reliability, conformance (protocol, apps, OAuth), and security.";
}
