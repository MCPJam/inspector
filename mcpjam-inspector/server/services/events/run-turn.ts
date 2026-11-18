/**
 * One event run's turn, in and out: the prompt it starts from, and how its
 * result, spend refusals and errors are reported back.
 */

import type { ModelMessage } from "ai";
import { renderEventTurnMessages } from "@mcpjam/sdk/events";
import { isTransientSpendRefusal } from "@/shared/swarm-attempt-error";
import type { EventRunInput } from "./backend-client.js";

const MAX_RESULT_TEXT_CHARS = 4_000;
const MAX_ERROR_CHARS = 300;

/** Backend denial codes that mean "the spend precheck refused this step". */
const SPEND_REFUSAL_CODES = new Set([
  "platform_free_budget_exhausted",
  "account_suspended",
  "guest_model_not_allowed",
  "guest_input_too_large",
  "user_rate_limit",
  "wallet_locked",
  "org_rate_limit",
  "billing_limit_reached",
  "billing_feature_not_included",
  "spend_budget_reached",
  "free_tier_model_restricted",
  "spending_reservation_busy",
]);

/**
 * The run's prompt, in the ONE shape event turns use everywhere (the SDK's
 * `renderEventTurnMessages`, shared with evals so an eval measures what runs
 * unattended): the trigger's instructions are the only instruction, and the
 * event is a JSON block marked untrusted whose contents cannot close it.
 */
export function buildEventRunMessages(
  input: EventRunInput,
  options: { serverName?: string } = {},
): {
  systemPrompt: string;
  messages: ModelMessage[];
} {
  const data = input.event.data;
  const { systemPrompt, userMessage } = renderEventTurnMessages({
    instructions: input.trigger.instructions,
    event: {
      ...(input.event.eventId ? { eventId: input.event.eventId } : {}),
      name: input.event.name,
      ...(input.event.timestamp ? { timestamp: input.event.timestamp } : {}),
      data:
        data && typeof data === "object" && !Array.isArray(data)
          ? (data as Record<string, unknown>)
          : { value: data ?? null },
    },
    ...(options.serverName ? { source: { serverName: options.serverName } } : {}),
  });
  return {
    systemPrompt: `${systemPrompt}\n\nNo person is watching this run and no one can answer questions. When you are done, reply with a short summary of what you did.`,
    messages: [{ role: "user", content: userMessage }],
  };
}

function toolResultOk(output: unknown): boolean {
  if (!output || typeof output !== "object") return true;
  const typed = output as { type?: unknown; value?: unknown };
  if (typeof typed.type === "string") {
    if (typed.type.startsWith("error") || typed.type === "execution-denied") {
      return false;
    }
    const value = typed.value as { isError?: unknown } | undefined;
    if (value && typeof value === "object" && value.isError === true) return false;
    return true;
  }
  return (output as { isError?: unknown }).isError !== true;
}

function isTextPart(part: unknown): part is { type: "text"; text: string } {
  const typed = part as { type?: unknown; text?: unknown } | null;
  return typed?.type === "text" && typeof typed.text === "string";
}

function textOf(message: ModelMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isTextPart)
    .map((part) => part.text)
    .join("");
}

export interface EventRunResultSummary {
  text: string;
  toolCalls: Array<{ name: string; ok: boolean }>;
  steps: number;
}

export function summarizeEventRun(result: {
  newMessages: ModelMessage[];
  toolCalls: Array<{ toolCallId: string; toolName: string }>;
  toolResults: Array<{ toolCallId: string; output: unknown }>;
}): EventRunResultSummary {
  const assistants = result.newMessages.filter((message) => message.role === "assistant");
  const lastText = [...assistants].reverse().map(textOf).find((text) => text.trim()) ?? "";
  const outputs = new Map(result.toolResults.map((entry) => [entry.toolCallId, entry.output]));
  return {
    text:
      lastText.length > MAX_RESULT_TEXT_CHARS
        ? `${lastText.slice(0, MAX_RESULT_TEXT_CHARS)}…`
        : lastText,
    toolCalls: result.toolCalls.map((call) => ({
      name: call.toolName,
      ok: outputs.has(call.toolCallId) ? toolResultOk(outputs.get(call.toolCallId)) : false,
    })),
    steps: assistants.length,
  };
}

export function isSpendRefusal(event: {
  code?: string;
  refusalReason?: string;
} | undefined): boolean {
  if (!event?.code) return false;
  return (
    SPEND_REFUSAL_CODES.has(event.code) ||
    isTransientSpendRefusal(event.code, event.refusalReason)
  );
}

export function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS)}…` : message;
}
