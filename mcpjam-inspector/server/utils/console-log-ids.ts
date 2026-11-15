/**
 * The context fields a dev or verbose console line may show.
 *
 * With telemetry off (`DO_NOT_TRACK=1`, or no Axiom token) the console is the
 * only record of a local run, so its lines carry the IDs that tie them to a
 * run, session, iteration, turn or request. Nothing else from the context is
 * printed: every other field can hold a tool result or user content.
 */
const CONSOLE_ID_KEYS = [
  "runId",
  "sessionId",
  "chatSessionId",
  "sessionIdx",
  "iterationId",
  "turnId",
  "promptIndex",
  "requestId",
] as const;

// An allowlisted key is still only a name: free text under it (spaces,
// newlines, a URL or an email address) is not an ID and stays off the console.
const ID_SHAPED = /^[A-Za-z0-9_.:-]{1,128}$/;

function idValue(value: unknown): string | undefined {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
  return typeof value === "string" && ID_SHAPED.test(value) ? value : undefined;
}

/** `message` followed by ` key=value` for each allowlisted, ID-shaped field. */
export function withConsoleIds(
  message: string,
  context: Record<string, unknown> | undefined,
): string {
  if (!context) return message;
  let line = message;
  for (const key of CONSOLE_ID_KEYS) {
    const value = idValue(context[key]);
    if (value !== undefined) line += ` ${key}=${value}`;
  }
  return line;
}
