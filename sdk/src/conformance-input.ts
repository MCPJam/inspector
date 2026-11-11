/**
 * A setup gap on the caller's side (a missing or unusable tool, bad arguments,
 * no login) leaves a requirement untested without costing points: the server
 * is not to blame. The check shows as gray "Not run" with a plain fix.
 */
export type ConformanceInputKey =
  "tasksProbe" | "logProbe" | "inputRequiredProbe" | "toolCallProbe" | "login";

/** `details` key holding the setup gap's own plain-English fix, when it has one. */
export const MISSING_INPUT_MESSAGE_DETAIL = "missingInputMessage";

/**
 * `details` marking a check that could not run because of the caller's setup.
 * `message` overrides the generic copy for that input, so each gap can say
 * exactly what to change.
 */
export function needsSetupDetails(
  input: ConformanceInputKey,
  message?: string
): Record<string, unknown> {
  return {
    missingInput: input,
    ...(message ? { [MISSING_INPUT_MESSAGE_DETAIL]: message } : {}),
  };
}

type InputCheck = {
  id?: string;
  status: string;
  skipReason?: string;
  details?: unknown;
  error?: unknown;
};

function inputDetail(details: unknown): ConformanceInputKey | undefined {
  if (!details || typeof details !== "object" || !("missingInput" in details))
    return undefined;
  switch (details.missingInput) {
    case "tasksProbe":
    case "logProbe":
    case "inputRequiredProbe":
    case "toolCallProbe":
    case "login":
      return details.missingInput;
    default:
      return undefined;
  }
}

/** Recognizes raw SDK checks and saved report cases, including older reports. */
export function missingInputForCheck(
  check: InputCheck
): ConformanceInputKey | undefined {
  if (check.status !== "skipped" || check.skipReason !== "could-not-run")
    return undefined;
  const details = check.details;
  const marked =
    inputDetail(details) ??
    inputDetail(
      details && typeof details === "object" && "details" in details
        ? details.details
        : undefined
    );
  if (marked) return marked;

  // Saved reports without a marker carry these specific configuration diagnostics.
  const id = typeof check.id === "string" ? check.id : "";
  const message = errorMessage(check.error);
  if (
    id.startsWith("tasks-") &&
    (message.startsWith("no probe tool could be selected automatically:") ||
      message.startsWith("no listed tool advertises `execution.taskSupport`"))
  )
    return "tasksProbe";
  if (
    id === "modern-logs-require-log-level" &&
    message.startsWith("No logProbe configured")
  )
    return "logProbe";
  if (
    id === "modern-undeclared-capability-error" &&
    message.startsWith("No inputRequiredProbe configured")
  )
    return "inputRequiredProbe";
  if (
    id === "modern-tool-output-schema-conformant" &&
    /^\d+ tool\(s\) declare an outputSchema, but no tools\/call fixture was configured:/.test(
      message
    )
  )
    return "toolCallProbe";
  return undefined;
}

export function isMissingInputCheck(check: InputCheck): boolean {
  return missingInputForCheck(check) !== undefined;
}

const INPUT_MESSAGES: Record<ConformanceInputKey, string> = {
  tasksProbe: "Select a tool that creates a task in setup, then run again.",
  logProbe: "Select a tool that emits logs in setup, then run again.",
  inputRequiredProbe:
    "Select a tool that asks for input in setup, then run again.",
  toolCallProbe: "Select a tool to check output in setup, then run again.",
  login: "This server needs a login. Log in, then run again.",
};

function ownMessage(details: unknown): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const value = (details as Record<string, unknown>)[
    MISSING_INPUT_MESSAGE_DETAIL
  ];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Product copy for the missing input; raw diagnostics stay in the report. */
export function missingInputMessage(check: InputCheck): string | undefined {
  const input = missingInputForCheck(check);
  if (!input) return undefined;
  const details = check.details;
  return (
    ownMessage(details) ??
    ownMessage(
      details && typeof details === "object" && "details" in details
        ? details.details
        : undefined
    ) ??
    INPUT_MESSAGES[input]
  );
}

/**
 * A tasks check whose chosen tool returned a normal result instead of a task.
 * The first form is the current SDK text; the second is what older saved
 * reports carry. Group 1 is the tool name as a JSON string.
 */
const NO_TASK_CREATED =
  /^(?:the probed tool )?("(?:[^"\\]|\\.)*") returned a normal result/;

/**
 * Product copy for a tasks check that had no task to inspect because the
 * chosen tool returned a normal result, for reports saved before that case
 * carried the setup marker. Those older reports still cost a point.
 */
export function noTaskCreatedMessage(check: InputCheck): string | undefined {
  if (check.status !== "skipped" || check.skipReason !== "could-not-run")
    return undefined;
  if (typeof check.id !== "string" || !check.id.startsWith("tasks-"))
    return undefined;
  const match = NO_TASK_CREATED.exec(errorMessage(check.error));
  if (!match) return undefined;
  let tool: unknown;
  try {
    tool = JSON.parse(match[1]!);
  } catch {
    return undefined;
  }
  if (typeof tool !== "string") return undefined;
  return noTaskCreatedCopy(tool);
}

/** The plain fix when the picked tool answered normally instead of making a task. */
export function noTaskCreatedCopy(tool: string): string {
  return `"${tool}" did not create a task, so there was nothing to check. Select a tool that creates a task in setup, or change its arguments so it does, then run again.`;
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  return error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : "";
}
