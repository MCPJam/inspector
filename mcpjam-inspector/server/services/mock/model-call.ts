/**
 * The model call behind a mock's model answers: one step, no tools, on MCPJam's
 * hosted rail as the caller, so the organization that calls the mock pays for
 * the answer and the backend meters it as it meters any hosted step. The model
 * is the one MCPJam's own agent uses (`MCPJAM_AGENT_MODEL`): small, and
 * available to every signed-in caller.
 */
import { randomUUID } from "node:crypto";
import { MCPClientManager } from "@mcpjam/sdk";
import type { ModelDefinition } from "../../../shared/types.js";
import { MockAnswerError } from "@mcpjam/sdk/mocks";
import {
  MCPJAM_AGENT_MODEL,
  MCPJAM_AGENT_MODEL_DEFINITION,
} from "../../../shared/mcpjam-agent-model.js";
import { resolveTurnRuntime } from "../../utils/resolve-turn-runtime.js";
import { runUnifiedAssistantTurn } from "../../utils/turn-execution.js";
import { logger } from "../../utils/logger.js";
import type { ModelCaller } from "./model-answer.js";

/** The longest answer asked for; the backend holds credits against it. */
const MAX_OUTPUT_TOKENS = 2048;

function textOf(messages: Array<{ role: string; content: unknown }>): string {
  return messages
    .filter((m) => m.role === "assistant")
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .map((part) =>
                part &&
                typeof part === "object" &&
                (part as { type?: unknown }).type === "text"
                  ? String((part as { text?: unknown }).text ?? "")
                  : "",
              )
              .join("")
          : "",
    )
    .join("\n")
    .trim();
}

export function hostedModelCaller(args: {
  bearerToken: string;
  projectId: string;
  /**
   * Ask this model instead of MCPJam's own: an eval answering a server's
   * request for the iteration's model. It is asked as the caller on the same
   * rail, so the call is metered like any hosted step. A model MCPJam does not
   * host is refused: a call it cannot count is not made.
   */
  model?: { definition: ModelDefinition; id: string };
}): ModelCaller {
  const authHeader = `Bearer ${args.bearerToken}`;
  return async ({ system, prompt, signal }) => {
    const chatSessionId = randomUUID();
    const resolved = await resolveTurnRuntime({
      modelDefinition: args.model?.definition ?? MCPJAM_AGENT_MODEL_DEFINITION,
      projectId: args.projectId,
      authHeader,
      sourceType: "direct",
      chatSessionId,
      tools: {},
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
    if (resolved.runtime.kind !== "hosted") {
      throw new MockAnswerError(
        args.model
          ? "A server asked for the run's model, and this run's model is not one MCPJam hosts, so MCPJam cannot ask it and count the call. Run the case on a hosted model."
          : "A model answer needs MCPJam's hosted models, and this deployment does not have them.",
      );
    }
    let engineError: { message: string } | undefined;
    const result = await runUnifiedAssistantTurn({
      runtime: resolved.runtime,
      streamSink: "none",
      persistMode: "caller",
      approvalMode: "auto-deny",
      messages: [{ role: "user", content: prompt }],
      modelDefinition: args.model?.definition ?? MCPJAM_AGENT_MODEL_DEFINITION,
      systemPrompt: system,
      tools: {},
      mcpClientManager: new MCPClientManager(),
      authContext: { kind: "user_bearer", token: authHeader },
      sourceType: "direct",
      origin: "api",
      maxSteps: 1,
      projectId: args.projectId,
      chatSessionId,
      abortSignal: signal,
      onEngineError: (event: { message: string }) => {
        engineError = event;
      },
    });
    const text = textOf(result.newMessages);
    if (engineError || text === "") {
      logger.warn("[mock-route] a model answer came back empty", {
        failed: Boolean(engineError),
      });
      throw new MockAnswerError(
        "The model that answers this mock did not reply. Try the call again.",
      );
    }
    return { text, model: args.model?.id ?? MCPJAM_AGENT_MODEL };
  };
}
