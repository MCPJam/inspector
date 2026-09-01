/**
 * `codex app-server` notifications → harness stream parts.
 *
 * The whole reason MCPJam owns an adapter rather than wrapping one: app-server
 * reports what the agent did as TYPED ITEMS, and every product surface MCPJam
 * has (trace spans, eval assertions, the tool timeline) keys on named tool
 * calls. This module is where one becomes the other.
 *
 * Three invariants it exists to hold, each of which was a real bug in one of
 * the transports that came before:
 *
 *  1. A `tool-approval-request` MUST follow a `tool-call` with the same
 *     `toolCallId` — the framework throws on an approval for an unknown call.
 *     Codex sends the approval BEFORE `item/started` (measured; see
 *     `.spike-codex-appserver/RESULTS.md`), so the call cannot be synthesized
 *     from the item. {@link Translator.ensureToolCall} lets the approval path
 *     seed it and makes the later `item/started` a no-op.
 *  2. Exactly ONE `tool-call` per item. Two would double-count in every
 *     downstream aggregation.
 *  3. Nothing is silently dropped. Every notification is also emitted as a
 *     `raw` part, so a payload this translator does not model is still visible
 *     to anyone reading the trace.
 */
import type { BridgeEvent } from "@ai-sdk/harness/bridge";
import {
  CODEX_APPSERVER_NATIVE_TOOL_NAMES,
  CODEX_APPSERVER_TOOL_NAMES,
} from "../shared/tool-names.js";
import type {
  CommandAction,
  FileChangeEntry,
  JsonRpcNotification,
  ThreadItem,
  ThreadTokenUsage,
  TokenUsageBreakdown,
  TurnStatus,
} from "./app-server-protocol.js";
import { createStepTracker, type StepTracker } from "./step-tracker.js";
import {
  addBreakdowns,
  diffUsage,
  toHarnessUsage,
  zeroUsage,
  type HarnessUsage,
} from "./usage.js";

export type ToolCallSeed = {
  toolName: string;
  nativeName?: string;
  input: unknown;
  providerExecuted?: boolean;
  dynamic?: boolean;
};

export type TurnOutcome = {
  status: TurnStatus;
  error?: { message: string };
};

export type Translator = {
  handleNotification(notification: JsonRpcNotification): void;
  /**
   * Emit a `tool-call` for `itemId` unless one was already emitted. Returns the
   * `toolCallId` either way, so an approval and the item that follows it agree.
   */
  ensureToolCall(itemId: string, seed: ToolCallSeed): string;
  /** Close every open block and emit the turn's `finish`. Idempotent. */
  finishTurn(outcome: TurnOutcome): void;
  /** Resolves when the turn reaches a terminal status. */
  waitForTurn(): Promise<TurnOutcome>;
};

type ItemState = {
  type: string;
  toolCallId?: string;
  toolName?: string;
  emittedResult?: boolean;
  textId?: string;
  streamedText: string;
  reasoningId?: string;
  streamedReasoning: string;
  summaryIndex: number;
};

export function createStreamTranslator(input: {
  emit(event: BridgeEvent): void;
  emitWarning(input: { message: string }): void;
  emitError(input: { error: unknown; message?: string }): void;
  /** Items whose `server` matches this are suppressed: the host-tool relay
   *  emits its own canonical pair with MCPJam's tool name. */
  relayServerName: string;
  /** Turn-scoped; `false` suppresses `raw` passthrough for quieter fixtures. */
  emitRaw?: boolean;
  stepTracker?: StepTracker;
}): Translator {
  const { emit, emitWarning, emitError, relayServerName } = input;
  const emitRaw = input.emitRaw ?? true;
  const steps = input.stepTracker ?? createStepTracker();

  const items = new Map<string, ItemState>();
  let usageAtTurnStart: TokenUsageBreakdown | undefined;
  let latestTotal: TokenUsageBreakdown | undefined;
  let latestLast: TokenUsageBreakdown | undefined;
  let summedLast: TokenUsageBreakdown = {};
  let sawUsage = false;
  let finished = false;
  let pendingCompaction: "manual" | "auto" | undefined;
  let tokensBeforeCompaction: number | undefined;

  let resolveTurn: ((outcome: TurnOutcome) => void) | undefined;
  const turnPromise = new Promise<TurnOutcome>((resolve) => {
    resolveTurn = resolve;
  });

  const state = (itemId: string, type: string): ItemState => {
    const existing = items.get(itemId);
    if (existing) return existing;
    const created: ItemState = {
      type,
      streamedText: "",
      streamedReasoning: "",
      summaryIndex: 0,
    };
    items.set(itemId, created);
    return created;
  };

  const closeText = (item: ItemState) => {
    if (item.textId === undefined) return;
    emit({ type: "text-end", id: item.textId });
    item.textId = undefined;
  };
  const closeReasoning = (item: ItemState) => {
    if (item.reasoningId === undefined) return;
    emit({ type: "reasoning-end", id: item.reasoningId });
    item.reasoningId = undefined;
  };
  const closeAllBlocks = () => {
    for (const item of items.values()) {
      closeText(item);
      closeReasoning(item);
    }
  };

  const emitStepFinish = (reason: "tool-calls" | "stop") => {
    emit({
      type: "finish-step",
      finishReason: { unified: reason },
      usage: toHarnessUsage(latestLast),
    });
  };

  /** Total usage for the TURN: the cumulative delta when trustworthy, the sum
   *  of per-request values when compaction made the delta meaningless. */
  const turnUsage = (): HarnessUsage => {
    if (!sawUsage) return zeroUsage();
    return (
      diffUsage(latestTotal, usageAtTurnStart) ?? toHarnessUsage(summedLast)
    );
  };

  const ensureToolCall: Translator["ensureToolCall"] = (itemId, seed) => {
    const item = state(itemId, seed.toolName);
    if (item.toolCallId) return item.toolCallId;
    item.toolCallId = itemId;
    item.toolName = seed.toolName;
    emit({
      type: "tool-call",
      toolCallId: itemId,
      toolName: seed.toolName,
      // The harness wire type is a JSON STRING, not an object. Passing the
      // object through here is the single easiest way to produce a part that
      // fails schema validation downstream, so it is stringified once, here.
      input: JSON.stringify(seed.input ?? {}),
      providerExecuted: seed.providerExecuted ?? true,
      ...(seed.dynamic ? { dynamic: true } : {}),
      ...(seed.nativeName ? { nativeName: seed.nativeName } : {}),
    });
    return itemId;
  };

  const emitToolResult = (
    itemId: string,
    toolName: string,
    result: unknown,
    isError: boolean,
  ) => {
    const item = state(itemId, toolName);
    if (item.emittedResult) return;
    item.emittedResult = true;
    emit({
      type: "tool-result",
      toolCallId: itemId,
      toolName,
      result,
      ...(isError ? { isError: true } : {}),
    });
  };

  const seedForItem = (item: ThreadItem): ToolCallSeed | undefined => {
    switch (item.type) {
      case "commandExecution": {
        const command = (item as { command?: string }).command;
        const cwd = (item as { cwd?: unknown }).cwd;
        const actions = (item as { commandActions?: CommandAction[] })
          .commandActions;
        return {
          toolName: CODEX_APPSERVER_TOOL_NAMES.commandExecution,
          nativeName: CODEX_APPSERVER_NATIVE_TOOL_NAMES.commandExecution,
          input: {
            command,
            ...(typeof cwd === "string" ? { cwd } : {}),
            ...(actions?.length ? { commandActions: actions } : {}),
          },
        };
      }
      case "fileChange": {
        const changes = (item as { changes?: FileChangeEntry[] }).changes ?? [];
        return {
          toolName: CODEX_APPSERVER_TOOL_NAMES.fileChange,
          nativeName: CODEX_APPSERVER_NATIVE_TOOL_NAMES.fileChange,
          input: {
            changes: changes.map((change) => ({
              path: change.path,
              ...(change.kind?.type ? { kind: change.kind.type } : {}),
            })),
          },
        };
      }
      case "webSearch":
        return {
          toolName: CODEX_APPSERVER_TOOL_NAMES.webSearch,
          nativeName: CODEX_APPSERVER_NATIVE_TOOL_NAMES.webSearch,
          input: { query: (item as { query?: string }).query },
        };
      case "mcpToolCall": {
        const mcp = item as {
          server: string;
          tool: string;
          arguments?: unknown;
        };
        // The relay's own calls already produced a canonical host-tool
        // `tool-call`/`tool-result` pair under MCPJam's name. Emitting Codex's
        // view of the same call would show every host tool twice.
        if (mcp.server === relayServerName) return undefined;
        return {
          toolName: `${mcp.server}__${mcp.tool}`,
          input: mcp.arguments ?? {},
          dynamic: true,
        };
      }
      default:
        return undefined;
    }
  };

  const resultForItem = (
    item: ThreadItem,
  ): { result: unknown; isError: boolean } => {
    switch (item.type) {
      case "commandExecution": {
        const command = item as {
          status: string;
          exitCode?: number | null;
          aggregatedOutput?: string | null;
          durationMs?: number | null;
        };
        return {
          result: {
            status: command.status,
            ...(command.exitCode != null ? { exitCode: command.exitCode } : {}),
            ...(command.aggregatedOutput != null
              ? { output: command.aggregatedOutput }
              : {}),
            ...(command.durationMs != null
              ? { durationMs: command.durationMs }
              : {}),
          },
          isError: command.status === "failed" || command.status === "declined",
        };
      }
      case "fileChange": {
        const change = item as { status: string; changes?: FileChangeEntry[] };
        return {
          result: {
            status: change.status,
            changes: (change.changes ?? []).map((entry) => ({
              path: entry.path,
              ...(entry.kind?.type ? { kind: entry.kind.type } : {}),
            })),
          },
          isError: change.status === "failed" || change.status === "declined",
        };
      }
      case "webSearch": {
        const search = item as { results?: unknown };
        return { result: search.results ?? null, isError: false };
      }
      case "mcpToolCall": {
        const mcp = item as {
          status: string;
          result?: unknown;
          error?: { message: string } | null;
        };
        return {
          result: mcp.error ?? mcp.result ?? null,
          isError: mcp.status === "failed" || Boolean(mcp.error),
        };
      }
      default:
        return { result: null, isError: false };
    }
  };

  const onItemStarted = (item: ThreadItem) => {
    const tracked = state(item.id, item.type);
    tracked.type = item.type;
    steps.itemStarted(item.id, item.type);
    const seed = seedForItem(item);
    if (seed) ensureToolCall(item.id, seed);
  };

  const onItemCompleted = (item: ThreadItem) => {
    const tracked = state(item.id, item.type);

    if (item.type === "agentMessage") {
      // Reconcile: a non-streamed response arrives with the whole text on the
      // completed item and no deltas at all, and a streamed one can still be
      // truncated relative to the final text. Emitting the REMAINDER covers
      // both without duplicating what already streamed.
      const text = (item as { text?: string }).text ?? "";
      if (text.length > tracked.streamedText.length) {
        const id = tracked.textId ?? `${item.id}`;
        if (tracked.textId === undefined) {
          emit({ type: "text-start", id });
          tracked.textId = id;
        }
        emit({
          type: "text-delta",
          id,
          delta: text.slice(tracked.streamedText.length),
        });
        tracked.streamedText = text;
      }
      closeText(tracked);
    }

    if (item.type === "reasoning") {
      const summary = ((item as { summary?: string[] }).summary ?? []).join(
        "\n\n",
      );
      if (summary.length > tracked.streamedReasoning.length) {
        const id = tracked.reasoningId ?? `${item.id}`;
        if (tracked.reasoningId === undefined) {
          emit({ type: "reasoning-start", id });
          tracked.reasoningId = id;
        }
        emit({
          type: "reasoning-delta",
          id,
          delta: summary.slice(tracked.streamedReasoning.length),
        });
        tracked.streamedReasoning = summary;
      }
      closeReasoning(tracked);
    }

    if (item.type === "contextCompaction") {
      emit({
        type: "compaction",
        trigger: pendingCompaction ?? "auto",
        summary: "",
        ...(tokensBeforeCompaction !== undefined
          ? { tokensBefore: tokensBeforeCompaction }
          : {}),
        ...(latestTotal?.totalTokens !== undefined
          ? { tokensAfter: latestTotal.totalTokens }
          : {}),
      });
      pendingCompaction = undefined;
    }

    const seed = seedForItem(item);
    if (seed) {
      const toolCallId = ensureToolCall(item.id, seed);
      const { result, isError } = resultForItem(item);
      emitToolResult(toolCallId, seed.toolName, result, isError);
    }

    if (steps.itemCompleted(item.id, item.type)) emitStepFinish("tool-calls");
  };

  const handleNotification: Translator["handleNotification"] = (
    notification,
  ) => {
    const { method } = notification;
    const params = (notification.params ?? {}) as Record<string, unknown>;
    if (emitRaw) emit({ type: "raw", rawValue: notification });

    switch (method) {
      case "thread/started": {
        const thread = params.thread as { id?: string } | undefined;
        if (thread?.id) emit({ type: "bridge-thread", threadId: thread.id });
        return;
      }

      case "item/agentMessage/delta": {
        const itemId = String(params.itemId ?? "");
        const delta = String(params.delta ?? "");
        if (!itemId || !delta) return;
        const item = state(itemId, "agentMessage");
        if (item.textId === undefined) {
          item.textId = itemId;
          emit({ type: "text-start", id: itemId });
        }
        item.streamedText += delta;
        emit({ type: "text-delta", id: itemId, delta });
        return;
      }

      case "item/reasoning/summaryPartAdded": {
        // A new summary paragraph. Codex numbers them; the harness has one
        // reasoning block per item, so paragraphs are joined with a blank line
        // rather than opening a second block.
        const itemId = String(params.itemId ?? "");
        if (!itemId) return;
        const item = state(itemId, "reasoning");
        if (item.reasoningId !== undefined && item.streamedReasoning) {
          item.streamedReasoning += "\n\n";
          emit({ type: "reasoning-delta", id: itemId, delta: "\n\n" });
        }
        return;
      }

      case "item/reasoning/summaryTextDelta": {
        const itemId = String(params.itemId ?? "");
        const delta = String(params.delta ?? "");
        if (!itemId || !delta) return;
        const item = state(itemId, "reasoning");
        if (item.reasoningId === undefined) {
          item.reasoningId = itemId;
          emit({ type: "reasoning-start", id: itemId });
        }
        item.streamedReasoning += delta;
        emit({ type: "reasoning-delta", id: itemId, delta });
        return;
      }

      case "item/started": {
        const item = params.item as ThreadItem | undefined;
        if (item?.id) onItemStarted(item);
        return;
      }

      case "item/completed": {
        const item = params.item as ThreadItem | undefined;
        if (item?.id) onItemCompleted(item);
        return;
      }

      case "item/fileChange/patchUpdated": {
        // The only place a per-path mutation is visible without waiting for the
        // item to complete. Emitted as `file-change` parts IN ADDITION to the
        // fileChange tool pair, because the two answer different questions:
        // the tool pair says "the agent applied a patch", these say which files
        // moved. Consumers that only want one already filter by part type.
        const changes = (params.changes ?? []) as FileChangeEntry[];
        for (const change of changes) {
          if (!change?.path) continue;
          const kind = change.kind?.type ?? "";
          const event =
            kind === "add" || kind === "create"
              ? "create"
              : kind === "delete" || kind === "remove"
              ? "delete"
              : "modify";
          emit({ type: "file-change", event, path: change.path });
        }
        return;
      }

      case "thread/tokenUsage/updated": {
        const usage = params.tokenUsage as ThreadTokenUsage | undefined;
        if (!usage) return;
        sawUsage = true;
        if (usage.total) {
          // The FIRST total seen in a turn is the baseline. On a resumed thread
          // it already includes previous turns, which is exactly why the turn's
          // usage is a delta rather than the total itself.
          if (usageAtTurnStart === undefined) {
            usageAtTurnStart = subtractLast(usage.total, usage.last);
          }
          latestTotal = usage.total;
          tokensBeforeCompaction = usage.total.totalTokens;
        }
        if (usage.last) {
          latestLast = usage.last;
          summedLast = addBreakdowns(summedLast, usage.last);
        }
        return;
      }

      case "thread/compacted":
        pendingCompaction = pendingCompaction ?? "auto";
        return;

      case "turn/completed": {
        const turn = params.turn as
          | { status?: TurnStatus; error?: { message?: string } | null }
          | undefined;
        finishTurn({
          status: turn?.status ?? "completed",
          ...(turn?.error?.message
            ? { error: { message: turn.error.message } }
            : {}),
        });
        return;
      }

      case "error": {
        const error = params.error as { message?: string } | undefined;
        const willRetry = params.willRetry === true;
        // A retryable error is not the turn's outcome — Codex is about to try
        // again — so it is a warning. Surfacing it as an error part would make
        // a recovered turn look failed in the trace.
        if (willRetry) {
          emitWarning({ message: error?.message ?? "codex retrying" });
        } else {
          emitError({ error: error?.message ?? "codex error" });
        }
        return;
      }

      case "warning":
      case "configWarning": {
        const message =
          (params.message as string | undefined) ??
          (params.summary as string | undefined);
        // Worth forwarding rather than dropping: this is where app-server says
        // "Model metadata for X not found. Defaulting to fallback metadata",
        // the loud signal `codex exec` never gave for an unknown model.
        if (message) emitWarning({ message });
        return;
      }

      case "mcpServer/startupStatus/updated": {
        const status = String(params.status ?? "");
        if (status === "failed" || status === "cancelled") {
          emitWarning({
            message:
              `MCP server '${String(params.name ?? "?")}' ${status}` +
              (params.error ? `: ${String(params.error)}` : ""),
          });
        }
        return;
      }

      default:
        return;
    }
  };

  const finishTurn: Translator["finishTurn"] = (outcome) => {
    if (finished) return;
    finished = true;
    closeAllBlocks();
    if (steps.closeStep()) emitStepFinish("stop");
    if (outcome.error) emitError({ error: outcome.error.message });
    emit({
      type: "finish",
      finishReason: {
        unified:
          outcome.status === "completed"
            ? "stop"
            : outcome.status === "failed"
            ? "error"
            : "other",
        raw: outcome.status,
      },
      totalUsage: turnUsage(),
    });
    resolveTurn?.(outcome);
  };

  return {
    handleNotification,
    ensureToolCall,
    finishTurn,
    waitForTurn: () => turnPromise,
  };

  /** The cumulative total BEFORE this update, i.e. the turn's baseline. */
  function subtractLast(
    total: TokenUsageBreakdown,
    last: TokenUsageBreakdown | undefined,
  ): TokenUsageBreakdown {
    if (!last) return total;
    const sub = (a?: number, b?: number) =>
      a === undefined ? undefined : Math.max(0, a - (b ?? 0));
    return {
      totalTokens: sub(total.totalTokens, last.totalTokens),
      inputTokens: sub(total.inputTokens, last.inputTokens),
      cachedInputTokens: sub(total.cachedInputTokens, last.cachedInputTokens),
      cacheWriteInputTokens: sub(
        total.cacheWriteInputTokens,
        last.cacheWriteInputTokens,
      ),
      outputTokens: sub(total.outputTokens, last.outputTokens),
      reasoningOutputTokens: sub(
        total.reasoningOutputTokens,
        last.reasoningOutputTokens,
      ),
    };
  }
}
