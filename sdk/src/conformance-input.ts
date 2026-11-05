/** Missing caller inputs leave a requirement untested without costing points. */
export type ConformanceInputKey =
  "tasksProbe" | "logProbe" | "inputRequiredProbe" | "toolCallProbe";

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
};

/** Product copy for the missing input; raw diagnostics stay in the report. */
export function missingInputMessage(check: InputCheck): string | undefined {
  const input = missingInputForCheck(check);
  return input ? INPUT_MESSAGES[input] : undefined;
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
 * chosen tool returned a normal result. The SDK text names CLI flags; the app
 * points at setup instead. Unlike a missing input, this still costs points.
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
