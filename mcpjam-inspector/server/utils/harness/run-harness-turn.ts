/**
 * `runHarnessTurn` — the real Claude Code runtime behind a host's
 * `harness: "claude-code"` field. Drop-in alternative to `runChatEngineLoop`:
 * same `(MCPJamHandlerOptions, streamSink)` in, same `ChatEngineLoopResult`
 * out, same callbacks/trace, so chat / playground / eval all reuse it through
 * `runAssistantTurn`.
 *
 * Instead of MCPJam's emulated Convex `/stream` loop, it runs the AI SDK
 * **Claude Code harness** inside the host's E2B computer (Phase 2 provider),
 * attaches the host's MCP servers via a generated `.mcp.json` (Phase 3), and
 * adapts the harness event stream back into MCPJam's UI chunks + persistence.
 *
 * ── dual-`ai` boundary ────────────────────────────────────────────────────
 * The harness packages run on `ai@7-canary` (installed nested); this server is
 * `ai@6`. We never let v7 types cross into the typed server code: the harness
 * `fullStream` is read LOOSELY (by part `type`) and we hand-build `ai@6`
 * `UIMessageChunk`s. The `agent.stream(...)` input is cast at the call site.
 *
 * ── NOT runtime-verified here ─────────────────────────────────────────────
 * This compiles against the real APIs, but the live path (E2B connect, harness
 * bootstrap, exact fullStream part shapes, transcript reconstruction) needs a
 * live box + a model credential to exercise — same gate the Phase 0 spike ran.
 * Treat the stream-part mapping + message reconstruction as first-cut until a
 * live run confirms them.
 */
import type { ModelMessage } from "@ai-sdk/provider-utils";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type FinishReason,
  type UIMessageChunk,
} from "ai";
import { HarnessAgent, type HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { tunnelManager } from "../../services/tunnel-manager.js";
import { logger } from "../logger.js";
import type {
  ChatEngineLoopResult,
  MCPJamHandlerOptions,
} from "../mcpjam-stream-handler.js";
import type { PersistedTurnTrace } from "../chat-ingestion.js";
import { createE2BHarnessSandboxProvider } from "./e2b-sandbox-provider.js";
import { resolveHarnessSandbox } from "./resolve-sandbox.js";
import {
  buildHarnessMcpJson,
  harnessServerInputFromConfig,
  serializeHarnessMcpJson,
  type HarnessMcpServerInput,
} from "./mcp-config.js";

/** A minimal writer matching what `createUIMessageStream` hands `execute` and
 *  what the no-op (`streamSink: "none"`) path supplies. */
type ChunkWriter = { write: (chunk: UIMessageChunk) => void };

/**
 * Resolve the model credential the harness hands to the in-sandbox Claude Code
 * CLI. The inspector server holds no long-lived model key by design (keys live
 * in Convex), so this reads a deploy-configured credential.
 *
 * MVP seam: `AI_GATEWAY_API_KEY` (preferred) or `ANTHROPIC_API_KEY`. Production
 * hardening (per the plan): a short-lived, project-scoped AI-Gateway token
 * minted by Convex per turn — swap this function's body for that mint without
 * touching the rest of the turn.
 */
function resolveHarnessModelAuth():
  | { gateway: { apiKey: string; baseUrl?: string } }
  | { anthropic: { apiKey?: string; authToken?: string; baseUrl?: string } } {
  // Fail closed: this hands a deploy-level model key to the in-sandbox Claude
  // Code CLI (and the generated .mcp.json may carry per-server auth headers)
  // inside a reused executable computer, which crosses the server-side trust
  // boundary. Require an explicit operator opt-in until the per-turn
  // Convex-minted token replaces it.
  if (process.env.MCPJAM_HARNESS_ALLOW_ENV_CREDENTIAL !== "true") {
    throw new Error(
      "harness env credential path is disabled — set " +
        "MCPJAM_HARNESS_ALLOW_ENV_CREDENTIAL=true to opt in (dev/owner only; " +
        "production uses a per-turn scoped token minted by Convex)",
    );
  }
  const gatewayKey = process.env.AI_GATEWAY_API_KEY?.trim();
  if (gatewayKey) {
    return {
      gateway: {
        apiKey: gatewayKey,
        ...(process.env.AI_GATEWAY_BASE_URL
          ? { baseUrl: process.env.AI_GATEWAY_BASE_URL }
          : {}),
      },
    };
  }
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  const anthropicToken = process.env.ANTHROPIC_AUTH_TOKEN?.trim();
  if (anthropicKey || anthropicToken) {
    return {
      anthropic: {
        ...(anthropicKey ? { apiKey: anthropicKey } : {}),
        ...(anthropicToken ? { authToken: anthropicToken } : {}),
        ...(process.env.ANTHROPIC_BASE_URL
          ? { baseUrl: process.env.ANTHROPIC_BASE_URL }
          : {}),
      },
    };
  }
  throw new Error(
    "harness model credential not configured — set AI_GATEWAY_API_KEY or " +
      "ANTHROPIC_API_KEY on the inspector server (production: per-turn scoped " +
      "token minted by Convex)",
  );
}

/**
 * Build the harness `.mcp.json` from the selected servers' live configs.
 * Resolves each id via `mcpClientManager.getServerConfig` and, for stdio
 * servers, the inspector's already-open tunnel (local processes aren't
 * reachable from the sandbox). A selected id with no config is skipped.
 */
function buildMcpJsonFromManager(
  manager: MCPJamHandlerOptions["mcpClientManager"],
  selectedServerIds: string[],
) {
  const inputs: HarnessMcpServerInput[] = [];
  for (const id of selectedServerIds) {
    const config = manager.getServerConfig(id);
    if (!config) {
      logger.warn("[harness] selected server has no live config; skipping", {
        serverId: id,
      });
      continue;
    }
    const tunnelUrl = tunnelManager.getServerTunnelUrl(id);
    inputs.push(harnessServerInputFromConfig(id, config, { tunnelUrl }));
  }
  return buildHarnessMcpJson(inputs);
}

export async function runHarnessTurn(
  options: MCPJamHandlerOptions,
  streamSink: "ui" | "none",
): Promise<ChatEngineLoopResult> {
  const {
    messages,
    modelId,
    systemPrompt,
    authHeader,
    projectId,
    mcpClientManager,
    selectedServers,
    abortSignal,
    onConversationComplete,
    onStreamComplete,
    onStreamWriterReady,
    onToolCall,
    onToolResult,
    onEngineError,
    onLiveTextDelta,
    requireToolApproval,
    approvalMode,
  } = options;

  // The engine mutates a single messageHistory ref through the turn (parity
  // with runChatEngineLoop); we seed it with the inbound prompt messages.
  const messageHistory: ModelMessage[] = [...messages];
  const turnStartedAt = Date.now();
  const turnId = crypto.randomUUID();
  let aborted = false;
  let runSucceeded = false;
  let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
  let turnFinishReason: FinishReason = "stop";
  let capturedTurnTrace: PersistedTurnTrace | undefined;

  const executeEngine = async ({ writer }: { writer: ChunkWriter }) => {
    onStreamWriterReady?.(writer);
    if (abortSignal?.aborted) {
      aborted = true;
      return;
    }

    // Hoisted so the catch can close an open text block if the turn fails
    // after emitting text-start.
    let textId: string | undefined;

    try {
      if (!projectId) {
        throw new Error("harness turn requires a projectId to resolve the computer");
      }
      if (!authHeader) {
        throw new Error("harness turn requires an auth bearer to resolve the computer");
      }

      // 1. Resolve (and wake) the host's computer → sandbox id.
      const { sandboxId } = await resolveHarnessSandbox({
        bearer: authHeader,
        projectId,
        signal: abortSignal,
      });

      // 2. Build the .mcp.json from the selected servers.
      const mcpJson = buildMcpJsonFromManager(
        mcpClientManager,
        selectedServers ?? [],
      );

      // 3. Resolve the model credential (env seam; Convex mint is the harden).
      const auth = resolveHarnessModelAuth();

      // 4. Assemble the harness over the host's E2B computer.
      const sandbox = createE2BHarnessSandboxProvider({ sandboxId });
      // Map the host's approval policy onto the harness permission mode.
      // Interactive approval bridging is deferred, so fail closed: when the
      // host requires approval (or the synthetic "auto-deny" path), only
      // auto-approve reads instead of everything.
      const permissionMode: "allow-reads" | "allow-edits" | "allow-all" =
        requireToolApproval || approvalMode === "auto-deny"
          ? "allow-reads"
          : "allow-all";

      const harness = createClaudeCode({ model: modelId, auth });
      const agent = new HarnessAgent({
        // Dual-`ai` boundary cast: createClaudeCode returns a HarnessV1 from its
        // own (nested) @ai-sdk/harness copy, nominally distinct from this
        // server's copy that HarnessAgent uses. Structurally identical; the
        // drive below reads the resulting stream loosely.
        harness: harness as unknown as HarnessAgentAdapter,
        sandbox,
        ...(systemPrompt ? { instructions: systemPrompt } : {}),
        permissionMode,
        onSandboxSession: async ({ session, sessionWorkDir }) => {
          // Write the host's MCP servers into the session workdir before
          // Claude Code starts, so it connects to them on launch.
          await session.writeTextFile({
            path: `${sessionWorkDir}/.mcp.json`,
            content: serializeHarnessMcpJson(mcpJson),
          });
        },
      });

      const session = await agent.createSession();
      try {
        // v6 messages → v7 agent input: a documented loose cast at the boundary.
        const res = await agent.stream({
          messages,
          // Hand the harness the abort signal so a cancel propagates into the
          // in-sandbox run rather than only stopping our forwarding.
          ...(abortSignal ? { abortSignal } : {}),
        } as unknown as Parameters<typeof agent.stream>[0]);

        // Read the harness fullStream LOOSELY and hand-build ai@6 UI chunks.
        // Reconstruct the transcript INCREMENTALLY so persisted history keeps
        // the required assistant → tool → assistant ordering across steps:
        // assistantParts holds the in-progress assistant message (text
        // interleaved with tool-calls in stream order); pendingResults holds the
        // current step's tool results. New assistant content after results means
        // the next step has begun, so the prior segment is flushed first.
        const assistantParts: Array<
          | { type: "text"; text: string }
          | {
              type: "tool-call";
              toolCallId: string;
              toolName: string;
              input: unknown;
            }
        > = [];
        const pendingResults: Array<{
          toolCallId: string;
          toolName: string | undefined;
          output: unknown;
          isError: boolean;
        }> = [];
        const flushSegment = () => {
          if (assistantParts.length > 0) {
            messageHistory.push({
              role: "assistant",
              content: [...assistantParts],
            } as unknown as ModelMessage);
            assistantParts.length = 0;
          }
          for (const tr of pendingResults) {
            messageHistory.push({
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: tr.toolCallId,
                  toolName: tr.toolName ?? "tool",
                  // Failures use error-text (matches the emulated engine) so
                  // eval/trace consumers distinguish errors from success.
                  output: tr.isError
                    ? {
                        type: "error-text",
                        value:
                          typeof tr.output === "string"
                            ? tr.output
                            : JSON.stringify(tr.output),
                      }
                    : { type: "json", value: tr.output },
                },
              ],
            } as unknown as ModelMessage);
          }
          pendingResults.length = 0;
        };
        for await (const part of res.fullStream as AsyncIterable<
          Record<string, unknown> & { type?: string }
        >) {
          if (abortSignal?.aborted) {
            aborted = true;
            break;
          }
          const type = part.type;
          if (type === "text-delta" || type === "text") {
            const delta = String(
              (part as { text?: unknown; delta?: unknown }).delta ??
                (part as { text?: unknown }).text ??
                "",
            );
            if (!delta) continue;
            // Assistant text after tool results begins the next step.
            if (pendingResults.length > 0) flushSegment();
            if (textId === undefined) {
              textId = crypto.randomUUID();
              writer.write({ type: "text-start", id: textId });
            }
            // Append to the open trailing text part, or start a new one, so
            // text keeps its order relative to tool-calls.
            const lastPart = assistantParts[assistantParts.length - 1];
            if (lastPart && lastPart.type === "text") {
              lastPart.text += delta;
            } else {
              assistantParts.push({ type: "text", text: delta });
            }
            writer.write({ type: "text-delta", id: textId, delta });
            onLiveTextDelta?.(delta);
          } else if (type === "tool-call" || type === "tool-input-available") {
            // A tool-call after tool results begins the next step.
            if (pendingResults.length > 0) flushSegment();
            // Flush any open text block before the tool so the UI stream stays
            // balanced (matches the emulated engine's flush-before-tool order);
            // later text opens a fresh block with a new id.
            if (textId !== undefined) {
              writer.write({ type: "text-end", id: textId });
              textId = undefined;
            }
            const toolCallId = String(
              (part as { toolCallId?: unknown }).toolCallId ?? crypto.randomUUID(),
            );
            const toolName = String(
              (part as { toolName?: unknown }).toolName ?? "tool",
            );
            const input =
              (part as { input?: unknown }).input ??
              (part as { args?: unknown }).args ??
              {};
            writer.write({
              type: "tool-input-available",
              toolCallId,
              toolName,
              input,
            });
            await onToolCall?.({
              toolCallId,
              toolName,
              input,
              stepIndex: 0,
              promptIndex: 0,
              serverId: undefined,
            });
            assistantParts.push({ type: "tool-call", toolCallId, toolName, input });
          } else if (
            type === "tool-result" ||
            type === "tool-output-available"
          ) {
            const toolCallId = String(
              (part as { toolCallId?: unknown }).toolCallId ?? "",
            );
            const output =
              (part as { output?: unknown }).output ??
              (part as { result?: unknown }).result;
            // Surface tool failures the harness reports so eval/trace consumers
            // that key off isError classify them correctly.
            const isError =
              (part as { isError?: unknown }).isError === true ||
              (part as { error?: unknown }).error != null;
            writer.write({ type: "tool-output-available", toolCallId, output });
            await onToolResult?.({
              toolCallId,
              toolName: (part as { toolName?: string }).toolName,
              output,
              isError,
              stepIndex: 0,
              promptIndex: 0,
              serverId: undefined,
            });
            pendingResults.push({
              toolCallId,
              toolName: (part as { toolName?: string }).toolName,
              output,
              isError,
            });
          } else if (type === "finish") {
            const fr = (part as { finishReason?: unknown }).finishReason;
            if (typeof fr === "string" && fr) turnFinishReason = fr as FinishReason;
            const u = (part as { totalUsage?: unknown; usage?: unknown })
              .totalUsage ?? (part as { usage?: unknown }).usage;
            if (u && typeof u === "object") {
              const ur = u as Record<string, unknown>;
              usage = {
                ...(typeof ur.inputTokens === "number"
                  ? { inputTokens: ur.inputTokens }
                  : {}),
                ...(typeof ur.outputTokens === "number"
                  ? { outputTokens: ur.outputTokens }
                  : {}),
                ...(typeof ur.totalTokens === "number"
                  ? { totalTokens: ur.totalTokens }
                  : {}),
              };
            }
          }
        }
        // Cancelled mid-stream: do NOT drain res.text (it would block until the
        // full harness run finishes). The finally below destroys the harness
        // session, stopping the in-sandbox Claude Code run.
        if (aborted) return;
        if (textId !== undefined) writer.write({ type: "text-end", id: textId });

        // Settle usage/finish on res.
        await res.text;

        // Flush the final step's assistant message + its tool results. Earlier
        // steps were flushed as new assistant content arrived after results, so
        // the persisted history preserves assistant → tool → assistant ordering.
        flushSegment();
        writer.write({
          type: "finish",
          finishReason: turnFinishReason,
          ...(usage ? { messageMetadata: usage } : {}),
        });
        runSucceeded = true;
      } finally {
        try {
          await session.destroy();
        } catch (destroyErr) {
          logger.warn("[harness] session.destroy failed", { error: destroyErr });
        }
      }
    } catch (err) {
      if (abortSignal?.aborted || isAbortError(err)) {
        aborted = true;
        return;
      }
      const errorText = err instanceof Error ? err.message : String(err);
      logger.error("[harness] turn failed", err);
      // Close any open text block so the UI stream stays balanced.
      if (textId !== undefined) writer.write({ type: "text-end", id: textId });
      writer.write({ type: "error", errorText });
      onEngineError?.({
        message: errorText,
        rawText: errorText,
        promptIndex: 0,
      });
    }
  };

  const onFinishEngine = async () => {
    if (runSucceeded && !aborted) {
      const trace: PersistedTurnTrace = {
        turnId,
        promptIndex: 0,
        startedAt: turnStartedAt,
        endedAt: Date.now(),
        spans: [],
        ...(usage ? { usage } : {}),
        finishReason: turnFinishReason,
        modelId,
      };
      capturedTurnTrace = trace;
      try {
        await onConversationComplete?.([...messageHistory], trace);
      } catch (persistErr) {
        logger.error("[harness] onConversationComplete failed", persistErr);
      }
    }
    await onStreamComplete?.();
  };

  if (streamSink === "ui") {
    const stream = createUIMessageStream({
      execute: executeEngine,
      onFinish: onFinishEngine,
    });
    const response = createUIMessageStreamResponse({ stream });
    return { response, messageHistory, aborted: false };
  }

  // streamSink === "none": run inline against a no-op writer; trace +
  // onConversationComplete still fire via closures.
  const noopWriter: ChunkWriter = { write: () => {} };
  try {
    await executeEngine({ writer: noopWriter });
  } finally {
    await onFinishEngine();
  }
  return {
    messageHistory,
    aborted,
    ...(capturedTurnTrace ? { turnTrace: capturedTurnTrace } : {}),
  };
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.name === "TimeoutError")
  );
}
