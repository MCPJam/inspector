/**
 * Hosted **chat/agent-loop** MRTR resume (MCP 2026-07-28 §12.5, PR5).
 *
 * This is the surface PR3b explicitly descoped to PR5. PR3b's isolated
 * `/mrtr/continuation/resume` route drives a leg through the DEFAULT
 * `requestWithSchema` sender, which — as PR1 flagged (trap #9) — does not
 * reconstruct tool output-schema validation on the tool path. The emulated chat
 * engine, however, splices the driven tool result back into the agent loop and
 * feeds it to the model, so it MUST re-impose the same assertion upstream
 * `callTool` would have, or the model could act on a schema-violating result
 * that the non-MRTR path would have rejected.
 *
 * This module owns:
 *
 * 1. **Driving one resume leg** against the durable continuation, reusing the
 *    PR3b {@link resumeMrtrContinuationLeg} primitive (claim → idempotent submit
 *    → `markWireStarted` fence for side-effecting ops → one leg → finalize /
 *    re-suspend / indeterminate). Exactly-once is inherited: a side-effecting
 *    leg whose lease expires resolves as `indeterminate`, never a silent replay.
 * 2. **Reconstructing output-schema validation** on a completed tool result via
 *    the manager's `assertMrtrToolOutputSchema` seam — the SAME
 *    `DialectAwareJsonSchemaValidator` the local MRTR path uses, not a
 *    divergent copy. Validation runs OUTSIDE the leg (post-completion) so a
 *    schema violation is classified as a tool failure the model can recover
 *    from, never mis-attributed to an indeterminate wire.
 * 3. **Shaping the outcome** into what the engine should do next: splice a
 *    result and resume the model, or pause (re-suspend / terminal).
 *
 * ## Known reconstruction gap (flagged, not reconstructed)
 *
 * SEP-2243 `Mcp-Param-*` header mirroring is done inside upstream `callTool`'s
 * PRIVATE internals and is not reachable through the public API for a RETRY leg
 * (the retry must go through `requestWithSchema` to carry `requestState` /
 * `inputResponses`, which `callTool` cannot pass through). PR1 does not
 * reproduce it on the local MRTR tool path either, so the hosted resume has
 * PARITY with local MRTR — neither mirrors on a retry leg. It is also not
 * exercisable by in-memory/loopback fixtures. Reconstructing it would require
 * SDK-internal changes out of PR5's scope; deferred with this precise reason.
 */
import type { ModelMessage, ToolResultPart } from "ai";
import type { UIMessageChunk } from "ai";
import {
  mcpCallToolResultToModelOutputWithLinkedResources,
  type MCPClientManager,
  type McpLinkedResourceReader,
  type InputResponses,
  type MrtrLegResult,
  type MrtrOperationState,
  type ModelVisibleMcpToolResults,
  resumeInputRequiredOperation,
} from "@mcpjam/sdk";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { mergeMcpToolOriginMetadata } from "@/shared/mcp-tool-origin-metadata";
import {
  HOSTED_MRTR_DATA_PART_TYPE,
  type MrtrContinuationEvent,
  type MrtrResumeSubmission,
} from "@/shared/mrtr-continuation";
import {
  computeMrtrBindingFingerprintFromManager,
  deriveNegotiatedEra,
  resumeMrtrContinuationLeg,
  type ResumeMrtrOutcome,
} from "./mrtr-hosted-collector.js";
import { logger } from "./logger.js";

/**
 * What the engine should do with a resolved resume. A `toolResultMessage` means
 * "splice this into the suspended tool-call slot and resume the model"; its
 * absence means "pause — the operation is not done or was withdrawn".
 */
export type MrtrChatResumeResolution =
  | {
      /** The retry completed with a valid result — feed it to the model. */
      kind: "complete";
      toolResultMessage: ModelMessage;
    }
  | {
      /**
       * The retry failed (leg error, or a completed result that failed
       * output-schema validation). An error-text tool-result is spliced so the
       * agent can recover, exactly as a normal failed tool call would.
       */
      kind: "recover";
      toolResultMessage: ModelMessage;
      reason: string;
    }
  | {
      /** Another round is required. The `data-mrtr-input-required` part was
       *  already emitted by the leg; the engine pauses without a model call. */
      kind: "suspended";
      round: number;
    }
  | {
      /**
       * Terminal without a usable result. For `indeterminate` (a side-effecting
       * wire whose lease expired — may or may not have executed) the engine
       * MUST NOT feed the model a fabricated result; the browser surfaces an
       * explicit retry decision.
       */
      kind: "halted";
      outcome: "cancelled" | "expired" | "indeterminate" | "failed";
      reason: string;
    };

/**
 * The engine-facing resume descriptor threaded through `MCPJamHandlerOptions`.
 * Kept intentionally narrow so the engine stays decoupled from the continuation
 * store: it only knows a tool-call id and a `resolve` closure the caller
 * (chat-v2 / web-chat-turn) builds over {@link resolveMrtrChatResume}.
 */
export interface MrtrEngineResume {
  /** Which unresolved tool-call slot the driven result fills. */
  toolCallId: string;
  /** Drive one resume leg; `emit` writes transient data parts to the stream. */
  resolve: (
    emit: (chunk: UIMessageChunk) => void,
  ) => Promise<MrtrChatResumeResolution>;
}

/**
 * Splice a driven MRTR tool-result into the assistant message that issued the
 * suspended tool-call. Returns `false` when no matching unresolved tool-call is
 * found (the browser sent mismatched history) so the caller can pause instead
 * of running the model on a corrupt turn.
 */
export function spliceMrtrToolResult(
  messageHistory: ModelMessage[],
  toolCallId: string,
  toolResultMessage: ModelMessage,
): boolean {
  for (let i = 0; i < messageHistory.length; i++) {
    const msg = messageHistory[i];
    if (!msg || msg.role !== "assistant" || !Array.isArray((msg as any).content)) {
      continue;
    }
    const hasCall = (msg as any).content.some(
      (c: any) => c?.type === "tool-call" && c.toolCallId === toolCallId,
    );
    if (!hasCall) continue;
    // Guard against a double-splice (idempotent resume): if a tool-result for
    // this id already follows, do not insert a second one.
    const already = messageHistory.some(
      (m) =>
        m?.role === "tool" &&
        Array.isArray((m as any).content) &&
        (m as any).content.some(
          (c: any) => c?.type === "tool-result" && c.toolCallId === toolCallId,
        ),
    );
    if (already) return true;
    // Insert AFTER any tool-result messages already following this assistant
    // message. In a multi-call step the completed siblings were spliced right
    // after the assistant message at suspend time; inserting at `i + 1` would
    // place the resumed result BEFORE them, reversing tool-result order
    // relative to the tool-call order the model emitted. Advancing past the
    // existing `tool` messages preserves that order.
    let insertAt = i + 1;
    while (
      insertAt < messageHistory.length &&
      messageHistory[insertAt]?.role === "tool"
    ) {
      insertAt++;
    }
    messageHistory.splice(insertAt, 0, toolResultMessage);
    return true;
  }
  return false;
}

/**
 * True when `toolCallId` identifies a tool-call in `messageHistory` that has NOT
 * yet been answered by a tool-result. Used to validate a resume request before
 * driving (and consuming) its durable continuation: a stale or tampered
 * `toolCallId` — absent, or already resolved — must not consume a continuation
 * whose result would then have nowhere to be spliced.
 */
export function hasUnresolvedToolCall(
  messageHistory: ModelMessage[],
  toolCallId: string,
): boolean {
  const hasCall = messageHistory.some(
    (m) =>
      m?.role === "assistant" &&
      Array.isArray((m as any).content) &&
      (m as any).content.some(
        (c: any) => c?.type === "tool-call" && c.toolCallId === toolCallId,
      ),
  );
  if (!hasCall) return false;
  const resolved = messageHistory.some(
    (m) =>
      m?.role === "tool" &&
      Array.isArray((m as any).content) &&
      (m as any).content.some(
        (c: any) => c?.type === "tool-result" && c.toolCallId === toolCallId,
      ),
  );
  return !resolved;
}

export interface ResolveMrtrChatResumeDeps {
  manager: MCPClientManager;
  bearer: string;
  serverId: string;
  serverName?: string;
  toolCallId: string;
  submission: MrtrResumeSubmission;
  /** Resolved auth principal (user / guest id) — the fingerprint's principal half. */
  authPrincipal: string;
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
  /** Writes a transient `data-mrtr-input-required` / `resolved` part to the stream. */
  emit: (chunk: UIMessageChunk) => void;
  // Seams for testing.
  resume?: typeof resumeMrtrContinuationLeg;
  drive?: (
    state: MrtrOperationState,
    responses: InputResponses,
  ) => Promise<MrtrLegResult<unknown>>;
}

/** Build the model-facing tool-result message for a completed MRTR tool call. */
async function buildToolResultMessage(
  toolCallId: string,
  toolName: string,
  serverId: string,
  result: CallToolResult,
  modelVisibleMcpToolResults: ModelVisibleMcpToolResults | undefined,
  manager: MCPClientManager,
): Promise<ModelMessage> {
  // Resource-link hydration parity with `executeToolCallsFromMessages`: the
  // non-MRTR tool path reads embedded resource links so the model sees image /
  // resource output. Thread a reader over the SAME per-request manager so a
  // resumed call preserves that behavior instead of emitting bare links.
  const readResource: McpLinkedResourceReader = ({ uri, options: readOptions }) =>
    manager.readResource(
      serverId,
      { uri },
      readOptions?.abortSignal ? { signal: readOptions.abortSignal } : undefined,
    );
  let output: ToolResultPart["output"];
  try {
    const mapped = (await mcpCallToolResultToModelOutputWithLinkedResources(
      result as any,
      { modelVisibleMcpToolResults, readResource },
    )) as ToolResultPart["output"] | undefined;
    output = mapped ?? ({ type: "json", value: result as unknown } as any);
  } catch {
    output = { type: "json", value: result as unknown } as any;
  }
  const providerOptions = mergeMcpToolOriginMetadata(undefined, serverId);
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId,
        toolName,
        output,
        // Preserve the raw result (incl. _meta / structuredContent) for UI
        // hydration, matching `executeToolCallsFromMessages`.
        result,
        serverId,
        ...(providerOptions ? { providerOptions } : {}),
      },
    ],
  } as unknown as ModelMessage;
}

/** Build an error-text tool-result so the model can recover from a failed retry. */
function buildErrorToolResultMessage(
  toolCallId: string,
  toolName: string,
  message: string,
): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId,
        toolName,
        output: { type: "error-text", value: message } as any,
      },
    ],
  } as unknown as ModelMessage;
}

/**
 * Drive one hosted-chat MRTR resume leg and shape it for the agent loop.
 *
 * `toolName` is taken from the continuation's original params (server-side),
 * NOT the browser, so the spliced result is labeled with the real tool the
 * server executed.
 */
export async function resolveMrtrChatResume(
  deps: ResolveMrtrChatResumeDeps,
): Promise<MrtrChatResumeResolution> {
  const resume = deps.resume ?? resumeMrtrContinuationLeg;
  const { serverId, toolCallId } = deps;

  // Warm the connection: the client (and its negotiated identity, needed for
  // the binding fingerprint) must exist before the leg runs. `listTools` is not
  // an MRTR verb, so it can never itself return input_required.
  await deps.manager.listTools(serverId);
  const client = deps.manager.getManagedClient(serverId);
  if (!client) {
    return {
      kind: "halted",
      outcome: "failed",
      reason: `MCP server "${serverId}" did not connect for resume`,
    };
  }

  const negotiatedEra = deriveNegotiatedEra(deps.manager, serverId);
  const bindingFingerprint = computeMrtrBindingFingerprintFromManager(
    deps.manager,
    { serverId, negotiatedEra, authPrincipal: deps.authPrincipal },
  );

  // Capture the tool name + the completed result across the leg so
  // output-schema validation can run OUTSIDE the leg (see module doc): a
  // schema failure must be a tool failure, not an indeterminate wire.
  let toolName: string | undefined;
  let completedResult: unknown;
  const drive =
    deps.drive ??
    (async (state: MrtrOperationState, responses: InputResponses) => {
      const raw = state.originalParams?.name;
      toolName = typeof raw === "string" ? raw : undefined;
      const leg = await resumeInputRequiredOperation(client, state, responses);
      if (leg.status === "complete") completedResult = leg.result;
      return leg;
    });

  const emitContinuation = (event: MrtrContinuationEvent) => {
    deps.emit({
      type: HOSTED_MRTR_DATA_PART_TYPE,
      data: event,
      transient: true,
    } as unknown as UIMessageChunk);
  };

  let outcome: ResumeMrtrOutcome;
  try {
    outcome = await resume({
      bearer: deps.bearer,
      submission: deps.submission,
      bindingFingerprint,
      driveLeg: drive,
      emit: emitContinuation,
      ...(deps.serverName ? { serverName: deps.serverName } : {}),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error("[mrtr-chat] resume leg threw", { reason });
    return { kind: "halted", outcome: "failed", reason };
  }

  const resolvedName = toolName ?? "tool";

  switch (outcome.outcome) {
    case "input_required":
      return { kind: "suspended", round: outcome.round };

    case "completed": {
      const result = (outcome.result ?? completedResult) as
        | CallToolResult
        | undefined;
      // A terminal-replay claim returns no result (the continuation was already
      // finalized). Nothing to splice — treat as a benign halt so the caller
      // does not fabricate a result.
      if (result === undefined) {
        return {
          kind: "halted",
          outcome: "failed",
          reason: "continuation already completed; no result to resume",
        };
      }
      // §Trap #9: reconstruct upstream callTool's output-schema assertion on
      // the final tool result (the requestWithSchema leg bypassed it). Runs
      // post-completion so a mismatch is a recoverable tool failure, not an
      // indeterminate wire.
      try {
        await deps.manager.assertMrtrToolOutputSchema(
          serverId,
          resolvedName,
          result,
        );
      } catch (err) {
        const reason =
          err instanceof Error ? err.message : "tool output-schema validation failed";
        return {
          kind: "recover",
          reason,
          toolResultMessage: buildErrorToolResultMessage(
            toolCallId,
            resolvedName,
            reason,
          ),
        };
      }
      return {
        kind: "complete",
        toolResultMessage: await buildToolResultMessage(
          toolCallId,
          resolvedName,
          serverId,
          result,
          deps.modelVisibleMcpToolResults,
          deps.manager,
        ),
      };
    }

    case "failed":
      // A failed (non-side-effecting) leg: give the model an actionable error
      // result so the conversation is not stuck.
      return {
        kind: "recover",
        reason: outcome.reason,
        toolResultMessage: buildErrorToolResultMessage(
          toolCallId,
          resolvedName,
          `The tool call could not be completed: ${outcome.reason}`,
        ),
      };

    case "indeterminate":
    case "cancelled":
    case "expired":
      // No usable result. Indeterminate MUST NOT feed the model a fabricated
      // result (exactly-once: a side-effecting wire may or may not have run).
      // Cancelled / expired are user/TTL withdrawals. The `resolved` part was
      // already emitted by the leg; the engine pauses.
      return {
        kind: "halted",
        outcome: outcome.outcome,
        reason: outcome.reason,
      };

    default:
      return {
        kind: "halted",
        outcome: "failed",
        reason: "unknown resume outcome",
      };
  }
}
