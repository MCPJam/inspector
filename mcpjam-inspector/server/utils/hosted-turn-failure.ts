import type { PersistedTurnTrace } from "./chat-ingestion.js";

/** Shared by evals and synthetic sessions. A trace alone does not prove success. */
export function getHostedTurnFailure(args: {
  turnTrace: Pick<PersistedTurnTrace, "spans"> | undefined;
  newMessageCount: number;
}): string | null {
  if (!args.turnTrace) {
    return "Backend stream failed during iteration (engine caught an error mid-turn)";
  }
  if (args.newMessageCount === 0) {
    return "Backend step returned no content (stream error or empty response)";
  }
  // Tool failures belong to the caller's tool-error policy. Child error spans
  // carrying a toolCallId are tool evidence too, even with another category.
  const failedStep = args.turnTrace.spans.find(
    (span) =>
      span.status === "error" && span.category !== "tool" && !span.toolCallId,
  );
  return failedStep ? `Backend step failed mid-turn: ${failedStep.name}` : null;
}
