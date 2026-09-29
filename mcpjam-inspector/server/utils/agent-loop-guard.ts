/**
 * Refuse a chat continuation that cannot make progress — before it costs a
 * model call, an MCP connection or a persisted turn.
 *
 * The browser drives the agent loop: when a response ends on tool calls that
 * have all settled, it posts the same history back automatically
 * (`sendAutomaticallyWhen`). The engine counts steps per user message across
 * those requests, so once the budget is spent a resumed request runs no model
 * call — it used to come back as an empty, successful response whose last step
 * still looked resumable, and the browser resent it every few seconds for as
 * long as the tab stayed open. Each round trip still connected MCP servers and
 * persisted a turn.
 *
 * The browser now stops on its own (`client/src/lib/chat-auto-resume.ts`), but
 * a tab keeps the JavaScript it loaded, so only the server can stop one that
 * has not reloaded. This guard answers such a request with a 409 the browser
 * treats as a failed request, which is the one thing that always ends its
 * automatic resend.
 *
 * Only continuations are checked: a request whose last message is the user's
 * starts a fresh budget and is never refused here.
 */
import type { Context } from "hono";
import {
  countAssistantStepsSincePrompt,
  isTurnContinuation,
  repeatedToolInputFailure,
  REPEATED_TOOL_FAILURE_REFUSAL_MESSAGE,
  REPEATED_TOOL_INPUT_FAILURE_LIMIT,
  STEP_LIMIT_REFUSAL_MESSAGE,
} from "@/shared/turn-step-budget";
import { ErrorCode, webError } from "../routes/web/errors.js";
import { logger } from "./logger.js";
import { getRequestLogger } from "./request-logger.js";

export type AgentLoopGuardSurface = "mcpjam_agent" | "chat_v2";

export type AgentLoopGuardVerdict =
  | {
      reason: "step_limit";
      steps: number;
      maxSteps: number;
    }
  | {
      reason: "repeated_tool_input_error";
      steps: number;
      maxSteps: number;
      toolName: string;
    };

/**
 * Why this continuation must not run, or `null` when it may.
 *
 * `maxSteps` is the ceiling the engine will enforce for THIS turn — the guard
 * must use the same number, or it either refuses steps the engine would take
 * (lower) or lets through requests the engine can do nothing with (higher).
 */
export function checkAgentLoopGuard(args: {
  messages: readonly unknown[];
  maxSteps: number;
}): AgentLoopGuardVerdict | null {
  const { messages, maxSteps } = args;
  if (!isTurnContinuation(messages)) return null;
  const steps = countAssistantStepsSincePrompt(messages);
  if (steps >= maxSteps) {
    return { reason: "step_limit", steps, maxSteps };
  }
  const repeated = repeatedToolInputFailure(
    messages,
    REPEATED_TOOL_INPUT_FAILURE_LIMIT,
  );
  if (repeated) {
    return {
      reason: "repeated_tool_input_error",
      steps,
      maxSteps,
      toolName: repeated.toolName,
    };
  }
  return null;
}

/**
 * The refusal: one structured event (counts and the tool's name only, never
 * message content) and a 409 in the hosted error envelope, which both chat
 * surfaces already render.
 */
export function refuseAgentLoop(
  c: Context,
  verdict: AgentLoopGuardVerdict,
  surface: AgentLoopGuardSurface,
): Response {
  const payload = {
    surface,
    reason: verdict.reason,
    steps: verdict.steps,
    maxSteps: verdict.maxSteps,
    ...(verdict.reason === "repeated_tool_input_error"
      ? { toolName: verdict.toolName }
      : {}),
  };
  try {
    getRequestLogger(c, `utils.agent-loop-guard.${surface}`).event(
      "agent.loop_guard.tripped",
      payload,
    );
  } catch {
    // Mounted outside the request-log middleware (tests, local tools): keep
    // the row rather than lose it.
    logger.warn("[agent-loop-guard] continuation refused", payload);
  }
  return webError(
    c,
    409,
    ErrorCode.AGENT_STEP_LIMIT,
    verdict.reason === "step_limit"
      ? STEP_LIMIT_REFUSAL_MESSAGE
      : REPEATED_TOOL_FAILURE_REFUSAL_MESSAGE,
    {
      reason: verdict.reason,
      steps: verdict.steps,
      maxSteps: verdict.maxSteps,
    },
  ) as Response;
}
