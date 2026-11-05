import { redactForTelemetry } from "@mcpjam/sdk/browser";
import { extractToolErrors } from "@/shared/eval-matching";
import type { ModelMessage } from "ai";
import type {
  EvalTraceSpan,
  RunnerBrowserInteractionStep,
  RunnerWidgetRenderObservation,
} from "@/shared/eval-trace";
import {
  buildToolAuthChallengeMetadata,
  collectToolAuthChallenges,
  toolAuthChallengeOf,
} from "./run-setup-signals.js";

/** Small evidence for the run summary, without downloading trace blobs. */
export function buildIterationErrorMetadata(input: {
  messages?: ModelMessage[];
  spans?: EvalTraceSpan[];
  toolErrors?: unknown[];
  browserInteractionSteps?: RunnerBrowserInteractionStep[];
  widgetRenderObservations?: RunnerWidgetRenderObservation[];
  status: string;
  error?: string;
  stepError?: { source?: string; code?: string };
}): Record<string, unknown> {
  const errors = new Map<string, { reason: string; message: string }>();
  const add = (reason: string, message: string) => {
    const clean = redactForTelemetry(message);
    if (typeof clean !== "string" || !clean.trim()) return;
    const entry = { reason, message: clean.trim() };
    errors.set(JSON.stringify(entry), entry);
  };
  // A tool step that hit a sign-in challenge is reported by its
  // classification and remediation instead of the raw refusal text, under the
  // same reason its kind already files it as.
  const authChallenges = collectToolAuthChallenges([
    ...(input.spans ?? []),
    ...(input.toolErrors ?? []),
  ]);
  const challengedCallIds = new Set(
    authChallenges.flatMap((record) =>
      record.toolCallId ? [record.toolCallId] : [],
    ),
  );
  const toolErrors = [
    ...(input.toolErrors ?? []),
    ...extractToolErrors({
      spans: input.spans ?? [],
      messages: input.messages ?? [],
    }),
  ];
  for (const error of toolErrors) {
    if (!error || typeof error !== "object") continue;
    const record = error as Record<string, unknown>;
    if (typeof record.message !== "string") continue;
    if (
      toolAuthChallengeOf(error) ||
      (typeof record.toolCallId === "string" &&
        challengedCallIds.has(record.toolCallId))
    )
      continue;
    add(
      record.kind === "protocol-error" ? "protocolError" : "toolError",
      record.message,
    );
  }
  for (const record of authChallenges) {
    add(
      record.authChallenge.source === "tool_result_meta"
        ? "toolError"
        : "protocolError",
      `${record.line} ${record.remediation}`,
    );
  }
  for (const observation of input.widgetRenderObservations ?? []) {
    if (observation.status === "rendered") continue;
    for (const message of observation.consoleErrors ?? [])
      add("renderFailed", message);
  }
  for (const step of input.browserInteractionSteps ?? []) {
    for (const call of step.widgetToolCalls ?? []) {
      if (call.error) add("protocolError", call.error);
      for (const error of extractToolErrors([
        {
          role: "tool",
          content: [
            { type: "tool-result", toolName: call.name, result: call.result },
          ],
        },
      ])) {
        if (error.message)
          add(
            error.kind === "protocol-error" ? "protocolError" : "toolError",
            error.message,
          );
      }
    }
  }
  const stopped =
    input.status !== "cancelled" &&
    input.status !== "skipped" &&
    (Boolean(input.error?.trim()) ||
      ["failed", "setup_failed", "timed_out"].includes(input.status));
  if (input.error)
    add(
      input.stepError?.source === "model" ? "providerError" : "setupAborted",
      input.error,
    );
  return {
    ...(errors.size ? { evalErrors: [...errors.values()] } : {}),
    ...buildToolAuthChallengeMetadata(authChallenges),
    ...(stopped
      ? {
          evalExecutionFailure: {
            phase:
              input.status === "setup_failed" ||
              input.stepError?.source === "setup"
                ? "setup"
                : "execution",
            reason:
              input.stepError?.code ??
              (input.status === "timed_out"
                ? "iteration_timeout"
                : "execution_stopped"),
          },
        }
      : {}),
  };
}
