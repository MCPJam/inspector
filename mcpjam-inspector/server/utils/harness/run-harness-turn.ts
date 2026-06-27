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
import type { EvalTraceSpan } from "@/shared/eval-trace";
import { createE2BHarnessSandboxProvider } from "./e2b-sandbox-provider.js";
import { resolveHarnessSandbox } from "./resolve-sandbox.js";
import { fetchHarnessModelCredential } from "./harness-model-credential.js";
import {
  buildHarnessMcpJson,
  harnessServerInputFromConfig,
  harnessServerKeyToName,
  parseHarnessToolName,
  serializeHarnessMcpJson,
  type HarnessMcpServerInput,
} from "./mcp-config.js";

/** A minimal writer matching what `createUIMessageStream` hands `execute` and
 *  what the no-op (`streamSink: "none"`) path supplies. */
type ChunkWriter = { write: (chunk: UIMessageChunk) => void };

/**
 * Resolve the model credential the harness hands to the in-sandbox CLI — from
 * Convex, like every other model key (keys live in Convex; the inspector holds
 * none by design). The CLI makes its own model calls inside the sandbox, so it
 * needs a real credential; we fetch the system **AI Gateway** key via the
 * bearer-authed Convex endpoint and hand it to the adapter as `auth.gateway`.
 * One key serves Claude Code (Anthropic) and Codex (OpenAI).
 *
 * Per-request Gateway attribution tags (`providerOptions.gateway.user/tags`)
 * are NOT plumbed: the harness adapter only forwards env vars to the CLI
 * (AI_GATEWAY_API_KEY / *_BASE_URL), so it can't carry per-call tags. Issuance
 * is instead audited + rate-limited server-side; full per-generation spend
 * ingestion is a follow-up (see the harness plan).
 *
 * Fails closed: the endpoint rejects (harness disabled / not a member /
 * rate-limited / no gateway key) ⇒ we throw here, BEFORE the computer is woken
 * (this is the first step of the turn), so a misconfigured turn never provisions
 * a box.
 */
async function resolveHarnessModelAuth(args: {
  projectId: string;
  modelId: string;
  bearer: string;
  signal?: AbortSignal;
}): Promise<{
  gateway: { apiKey: string; baseUrl?: string };
}> {
  const result = await fetchHarnessModelCredential({
    projectId: args.projectId,
    modelId: args.modelId,
    bearer: args.bearer,
    ...(args.signal ? { signal: args.signal } : {}),
  });
  if (!result.ok) {
    throw new Error(result.error);
  }
  return {
    gateway: {
      apiKey: result.credential.apiKey,
      ...(result.credential.baseUrl
        ? { baseUrl: result.credential.baseUrl }
        : {}),
    },
  };
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
  return {
    mcpJson: buildHarnessMcpJson(inputs),
    // Sanitized .mcp.json key → serverId, so Claude Code's mcp__<key>__<tool>
    // tool names map back to a serverId for eval matching / spans / MCP App
    // rendering (which all key off serverId + the un-namespaced tool name).
    keyToServerId: harnessServerKeyToName(inputs),
  };
}

/** The Claude Code harness serializes MCP tool-call arguments as a JSON STRING
 *  (e.g. `'{"city":"NYC"}'`), but MCPJam's UI chunks, the onToolCall callback,
 *  eval arg-matching, and MCP App widget capture all expect the structured
 *  object. Parse a string input back to its object/array; fall back to the raw
 *  value when it isn't JSON or doesn't decode to a structure (don't coerce a
 *  bare string/number/bool, and pass already-structured inputs through). */
function coerceToolInput(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? parsed : raw;
  } catch {
    return raw;
  }
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
    onStepFinish,
    onEngineError,
    onLiveTextDelta,
    requireToolApproval,
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
  // Cumulative tool spans for the turn trace, hoisted so onFinishEngine (a
  // sibling closure) can read them into PersistedTurnTrace.spans.
  const capturedSpans: EvalTraceSpan[] = [];

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
      // Interactive tool approval isn't bridged into the harness yet (no
      // tool-approval-request continuation handling), and the harness runs
      // allow-all — it can neither pause for approval nor selectively deny one
      // call. So fail closed when the host actually wants approval gating:
      // requireToolApproval. Every harness-reachable caller threads the host's
      // real requireToolApproval through (chat/playground directly; eval +
      // synthetic forward resolvedExecution.requireToolApproval), so this is the
      // authoritative signal.
      //
      // approvalMode "auto-deny" alone is NOT rejected: it's the headless
      // "no human in the loop" default eval/synthetic always set. With a
      // non-approval host nothing needs denying, so allow-all is faithful; an
      // approval host is already caught by requireToolApproval above. To run a
      // Claude Code harness host that requires approval, use the emulated engine
      // until approval continuations land.
      if (requireToolApproval) {
        throw new Error(
          "harness (Claude Code) turns don't support interactive tool approval " +
            "yet — turn off requireToolApproval on this host, or use the " +
            "emulated engine, until approval continuation handling lands",
        );
      }

      // 1. Resolve the model credential FIRST — fetched from Convex (the
      // project org's BYOK Anthropic key). Fail-fast: a project with no Anthropic
      // provider throws here, BEFORE resolveHarnessSandbox wakes/provisions the
      // user's computer (and bumps its activity), so a misconfigured turn never
      // touches the box.
      const auth = await resolveHarnessModelAuth({
        projectId,
        modelId,
        bearer: authHeader,
        ...(abortSignal ? { signal: abortSignal } : {}),
      });

      // 2. Build the .mcp.json from the selected servers. Pure + fail-fast —
      // harnessServerInputFromConfig throws e.g. for a local stdio server with
      // no tunnel — so build it BEFORE waking the computer: a bad MCP config
      // shouldn't wake/provision the box (or bump its activity) only to fail.
      //
      // Progressive tool discovery (progressivePlan / discoveryState) is
      // intentionally NOT applied here. It is an EMULATED-engine mechanism:
      // runChatEngineLoop injects MCPJam's meta-tools (search_mcp_tools, …) and
      // narrows the advertised tool catalog per step to mimic how a host lazily
      // reveals tools. In harness mode the REAL Claude Code runs its own native
      // tool discovery from the .mcp.json (the CLI's real progressiveToolDiscovery
      // behavior), so we attach the full selected-server set and let the runtime
      // own discovery. Re-applying the emulation would double it, defeat the
      // "observe the real runtime" purpose, and isn't expressible anyway —
      // .mcp.json has no knob to inject MCPJam meta-tools into the real loop.
      const { mcpJson, keyToServerId } = buildMcpJsonFromManager(
        mcpClientManager,
        selectedServers ?? [],
      );

      // 3. Resolve (and wake) the host's computer → sandbox id.
      const { sandboxId } = await resolveHarnessSandbox({
        bearer: authHeader,
        projectId,
        signal: abortSignal,
      });

      // 4. Assemble the harness over the host's E2B computer.
      const sandbox = createE2BHarnessSandboxProvider({ sandboxId });
      // Approval-required turns are refused above, so the remaining turns run
      // with full tool access (the agentic default).
      const permissionMode = "allow-all" as const;

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

      // maxSteps (MCPJamHandlerOptions) is intentionally NOT enforced here. It
      // caps MCPJam's *emulated* agentic loop; the harness exposes no equivalent
      // knob and the real Claude Code owns its own loop, so its "steps" aren't
      // MCPJam steps — a client-side cap would cut the real agent off mid-task
      // and defeat the point of observing it (same rationale as progressive tool
      // discovery above). The turn-level abortSignal/timeout (propagated into
      // agent.stream below) is the cost/runaway backstop.
      const session = await agent.createSession();
      try {
        // v6 messages → v7 agent input: a documented loose cast at the boundary.
        // `session` is REQUIRED — agent.stream() reads options.session in
        // _startTurn (session.promptTurn); omitting it throws "Cannot read
        // properties of undefined (reading 'promptTurn')". `_resolveTurnInput`
        // accepts `messages` and uses the last role:"user" entry as the prompt.
        const res = await agent.stream({
          session,
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
        // Step + tool-identity tracking. A "step" spans assistant content + its
        // tool results; the next assistant content after results begins the next
        // step. finishStep emits the emulated engine's onStepFinish contract
        // (eval's stream runner turns it into a `step_finish` SSE snapshot).
        let stepIndex = 0;
        const toolMeta = new Map<
          string,
          { serverId?: string; toolName: string }
        >();
        const toolStartMs = new Map<string, number>();
        const finishStep = () => {
          onStepFinish?.({
            stepIndex,
            promptIndex: 0,
            // Usage is only known at the harness `finish`, so intermediate steps
            // carry what's settled (matches the engine's cumulative semantics).
            ...(usage ? { turnUsage: usage } : {}),
            settledWithError: false,
            turnSpans: [...capturedSpans],
          });
          stepIndex += 1;
        };
        // [harness][debug] TEMP: surface what the harness fullStream actually
        // emits so we can align the part→UI-chunk mapping. Remove once verified.
        const dbgTypeCounts = new Map<string, number>();
        const dbgSeenType = new Set<string>();
        logger.info("[harness][debug] stream loop starting");
        for await (const part of res.fullStream as AsyncIterable<
          Record<string, unknown> & { type?: string }
        >) {
          if (abortSignal?.aborted) {
            aborted = true;
            break;
          }
          const type = part.type;
          // [harness][debug] TEMP — inline JSON in the message (logger drops the
          // 2nd metadata arg in this console).
          {
            const pt = String(type ?? "<none>");
            dbgTypeCounts.set(pt, (dbgTypeCounts.get(pt) ?? 0) + 1);
            if (!dbgSeenType.has(pt)) {
              dbgSeenType.add(pt);
              let dump = "";
              try {
                dump = JSON.stringify(part).slice(0, 800);
              } catch {
                dump = `keys=${JSON.stringify(Object.keys(part))}`;
              }
              logger.info(`[harness][debug] first part type=${pt} :: ${dump}`);
            }
          }
          if (type === "text-delta" || type === "text") {
            const delta = String(
              (part as { text?: unknown; delta?: unknown }).delta ??
                (part as { text?: unknown }).text ??
                "",
            );
            if (!delta) continue;
            // Assistant text after tool results begins the next step.
            if (pendingResults.length > 0) {
              flushSegment();
              finishStep();
            }
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
            if (pendingResults.length > 0) {
              flushSegment();
              finishStep();
            }
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
            const rawToolName = String(
              (part as { toolName?: unknown }).toolName ?? "tool",
            );
            // Claude Code namespaces MCP tools as mcp__<server>__<tool>; map back
            // to { serverId, un-namespaced toolName } so the UI chunks, engine
            // callbacks, and persisted transcript carry MCPJam tool identity
            // (eval matching + MCP App rendering key off it). Native harness
            // tools (Bash, Read, …) have no prefix → serverId stays undefined.
            const { serverId, toolName } = parseHarnessToolName(
              rawToolName,
              keyToServerId,
            );
            const input = coerceToolInput(
              (part as { input?: unknown }).input ??
                (part as { args?: unknown }).args ??
                {},
            );
            toolMeta.set(toolCallId, {
              ...(serverId ? { serverId } : {}),
              toolName,
            });
            toolStartMs.set(toolCallId, Date.now());
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
              stepIndex,
              promptIndex: 0,
              serverId,
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
            // Reuse the identity resolved at tool-call time (the result part may
            // omit the name); fall back to parsing the result's own toolName.
            const meta =
              toolMeta.get(toolCallId) ??
              parseHarnessToolName(
                String((part as { toolName?: unknown }).toolName ?? "tool"),
                keyToServerId,
              );
            writer.write({ type: "tool-output-available", toolCallId, output });
            await onToolResult?.({
              toolCallId,
              toolName: meta.toolName,
              output,
              isError,
              stepIndex,
              promptIndex: 0,
              serverId: meta.serverId,
            });
            // Record a tool span for the turn trace (cumulative; snapshotted into
            // each onStepFinish and the final PersistedTurnTrace.spans).
            capturedSpans.push({
              id: crypto.randomUUID(),
              name: meta.toolName,
              category: "tool",
              startMs: toolStartMs.get(toolCallId) ?? Date.now(),
              endMs: Date.now(),
              promptIndex: 0,
              stepIndex,
              status: isError ? "error" : "ok",
              toolCallId,
              toolName: meta.toolName,
              ...(meta.serverId ? { serverId: meta.serverId } : {}),
            });
            pendingResults.push({
              toolCallId,
              toolName: meta.toolName,
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
        // [harness][debug] TEMP: what did the stream actually contain?
        logger.info(
          `[harness][debug] loop ended counts=${JSON.stringify(
            Object.fromEntries(dbgTypeCounts)
          )} assistantParts=${assistantParts.length} pendingResults=${pendingResults.length} finishReason=${turnFinishReason}`
        );
        // Close any open text block first so BOTH the cancelled and normal
        // paths leave a balanced UI stream.
        if (textId !== undefined) writer.write({ type: "text-end", id: textId });

        // Cancelled mid-stream: do NOT drain res.text (it would block until the
        // full harness run finishes). The finally below destroys the harness
        // session, stopping the in-sandbox Claude Code run.
        if (aborted) return;

        // Settle usage/finish on res.
        // [harness][debug] TEMP: log the settled text length / any settle error.
        try {
          const settledText = await res.text;
          logger.info(
            `[harness][debug] res.text settled len=${
              typeof settledText === "string" ? settledText.length : -1
            } preview=${JSON.stringify(
              typeof settledText === "string" ? settledText.slice(0, 200) : settledText
            )}`
          );
        } catch (settleErr) {
          logger.error("[harness][debug] res.text threw", settleErr);
          throw settleErr;
        }

        // Flush the final step's assistant message + its tool results. Earlier
        // steps were flushed as new assistant content arrived after results, so
        // the persisted history preserves assistant → tool → assistant ordering.
        flushSegment();
        // Final step settles now that usage is known from the finish part.
        finishStep();
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
        spans: [...capturedSpans],
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
    // Mirror the emulated engine (mcpjam-stream-handler.ts): a cleanup/teardown
    // error must not reject stream finalization after an otherwise successful
    // turn (the trace + onConversationComplete already ran above).
    try {
      await onStreamComplete?.();
    } catch (cleanupError) {
      logger.error("[harness] error while running stream cleanup", cleanupError);
    }
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
