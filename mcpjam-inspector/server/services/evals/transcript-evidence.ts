/**
 * Pull the evidence the Response and Tool-call checks need out of what the
 * runner already captured.
 *
 * THE PROBLEM. The runner has more than the predicate transcript carried.
 * Per-call `startMs`/`endMs` live on trace spans and were dropped;
 * `tool-result` message parts carry the model-visible output (and sometimes
 * the raw `CallToolResult`) and were reduced to `{kind, toolName}`; the tool
 * inventory lives on the run's snapshot and never reached a check at all. So
 * "was the payload too big", "did the call take too long" and "did the
 * arguments match the declared schema" were unanswerable over data we were
 * already holding.
 *
 * WHAT IS AND IS NOT MEASURED HERE. Bytes are measured on the SERIALIZED
 * OUTPUT PART, before the transcript's own text cap, so a budget grades what
 * the server returned rather than what we chose to keep. That is not "context
 * consumed" — what a model's context actually holds is a host fact — and the
 * basis rides with every number so nobody reads it as one.
 *
 * A NARRATED CALL PRODUCES NOTHING. A harness that reports it called a tool,
 * without a result or a timed span, yields no row here. A fabricated zero
 * would be worse than an absent measurement: checks fail closed on absence in
 * the honest direction (`status: "error"`), and they cannot do that if we
 * invent the row.
 *
 * `*Captured` answers a NARROWER question than "is this evidence complete":
 * it says only that we LOOKED at the channel. A trace can carry a `spans`
 * array with no tool span in it, or messages with no `tool-result` part, and
 * that is `true` with zero rows. Which of the observed calls a row exists for
 * is a question the CHECK answers, against `toolCalls` — an empty channel
 * with calls in it is unmeasured there, never "nothing ran". Do not widen
 * these flags into a completeness claim they cannot support.
 */

import type { EvalTraceSpan } from "@/shared/eval-trace";
import type {
  TranscriptToolCallTiming,
  TranscriptToolInventoryEntry,
  TranscriptToolResult,
} from "@mcpjam/sdk/predicates";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** UTF-8 byte length, without Buffer (this module is shared with the client). */
function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Byte length of a value's JSON, or `undefined` when it will not serialize. */
function jsonBytes(value: unknown): number | undefined {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? undefined : utf8Bytes(json);
  } catch {
    return undefined;
  }
}

/**
 * Flatten a `tool-result` part's `output` union to model-visible text.
 *
 * The union is `{type: "json" | "text" | "content", value}` — the shapes an
 * MCP result reaches the model as. Text is returned as-is; the other two are
 * serialized, because "contains" is a question about what the model could
 * read, and a model reads the serialized form.
 */
function outputText(output: unknown): string | undefined {
  if (!isRecord(output)) return undefined;
  const value = output.value;
  if (output.type === "text") {
    return typeof value === "string" ? value : undefined;
  }
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/** The JSON payload of a `{type: "json"}` output part. */
function outputJson(output: unknown): unknown {
  if (!isRecord(output)) return undefined;
  return output.type === "json" ? output.value : undefined;
}

export type ExtractedEvidence = {
  toolResults: TranscriptToolResult[];
  /** True when the trace carried readable messages — see `resultsCaptured`. */
  resultsCaptured: boolean;
  toolCallTimings: TranscriptToolCallTiming[];
  timingsCaptured: boolean;
};

/**
 * Extract results and timings from an iteration's trace.
 *
 * `*Captured` is the honest half of the answer: it says we LOOKED, which is
 * what licenses a check to read "no rows" as "nothing happened" rather than
 * as "we do not know". A trace with no messages sets it false, and every
 * result-shaped check over that iteration reports `status: "error"`.
 */
export function extractTranscriptEvidence(trace: unknown): ExtractedEvidence {
  const messages = isRecord(trace)
    ? trace.messages
    : Array.isArray(trace)
      ? trace
      : undefined;
  const spans: EvalTraceSpan[] = isRecord(trace) && Array.isArray(trace.spans)
    ? (trace.spans as EvalTraceSpan[])
    : [];

  const toolResults: TranscriptToolResult[] = [];
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!isRecord(message) || message.role !== "tool") continue;
      const content = message.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (!isRecord(part) || part.type !== "tool-result") continue;
        const toolName =
          typeof part.toolName === "string" ? part.toolName : undefined;
        if (!toolName) continue;

        const text = outputText(part.output);
        const json = outputJson(part.output);
        const raw = isRecord(part.result) ? part.result : undefined;
        const structuredContent = raw?.structuredContent;

        // MEASURED ON THE OUTPUT PART, BEFORE any cap the transcript applies.
        // `complete: false` when the part will not serialize — a size check
        // over it then reports an error rather than a small number.
        const bytes = jsonBytes(part.output);
        const rawBytes = raw === undefined ? undefined : jsonBytes(raw);

        toolResults.push({
          ...(typeof part.toolCallId === "string"
            ? { toolCallId: part.toolCallId }
            : {}),
          toolName,
          ...(text !== undefined ? { text } : {}),
          ...(structuredContent !== undefined ? { structuredContent } : {}),
          ...(json !== undefined ? { json } : {}),
          ...(raw !== undefined && typeof raw.isError === "boolean"
            ? { isError: raw.isError }
            : {}),
          size: {
            bytes: bytes ?? 0,
            basis: "model_visible_output",
            complete: bytes !== undefined,
          },
          ...(rawBytes !== undefined ? { rawBytes } : {}),
        });
      }
    }
  }

  // Only TOOL spans that actually ran. A narrated call has no span, and a span
  // with a non-finite envelope has no duration to report — both are absences,
  // and an absence is not a zero.
  const toolCallTimings: TranscriptToolCallTiming[] = [];
  for (const span of spans) {
    if (span.category !== "tool") continue;
    if (typeof span.toolName !== "string" || span.toolName.length === 0) {
      continue;
    }
    const durationMs = span.endMs - span.startMs;
    if (!Number.isFinite(durationMs) || durationMs < 0) continue;
    toolCallTimings.push({
      ...(typeof span.toolCallId === "string"
        ? { toolCallId: span.toolCallId }
        : {}),
      toolName: span.toolName,
      durationMs,
      provenance: "span",
    });
  }

  return {
    toolResults,
    resultsCaptured: Array.isArray(messages),
    toolCallTimings,
    // The span channel is the measurement. A trace that carries no span array
    // at all is a custom executor that reports nothing — the same distinction
    // `traceLacksSpanChannel` draws for the stage chain.
    timingsCaptured: isRecord(trace) && Array.isArray(trace.spans),
  };
}

/** One advertised tool, as a check needs to see it. */
export type SelectionToolLike = {
  description?: unknown;
  inputSchema?: unknown;
  annotations?: unknown;
};

/**
 * The JSON Schema BEHIND an AI SDK tool's `inputSchema`.
 *
 * `convertMCPToolsToVercelTools`' automatic path — the one every live eval
 * takes — stores `jsonSchema(normalized)`, the AI SDK `Schema` wrapper
 * `{ jsonSchema, validate, … }`, not the schema itself. Handing that wrapper
 * to `argumentsMatchToolSchema` validates every call against an object with
 * no constraints, so malformed arguments PASS and the check reports the
 * server's contract as met. Override-mode tools carry a bare schema and are
 * passed through. `selection-tool-catalog.ts` draws the same distinction for
 * the same reason.
 */
function unwrapInputSchema(inputSchema: unknown): unknown {
  if (isRecord(inputSchema) && isRecord(inputSchema.jsonSchema)) {
    return inputSchema.jsonSchema;
  }
  return inputSchema;
}

/** The subset of the client manager this module reads, structurally. */
export type ToolAnnotationSource = {
  listServers(): string[];
  hasCachedToolAnnotations(serverId: string): boolean;
  getAllToolAnnotations(
    serverId: string,
  ): Record<string, Record<string, unknown> | undefined>;
};

/**
 * MCP `annotations` by tool name, from the servers whose `tools/list` we
 * actually read.
 *
 * The AI SDK `ToolSet` is lossy: `dynamicTool` carries description, schema
 * and hooks, and drops the server's `ToolAnnotations` entirely — so
 * `destructiveHint` never reaches a check through `allTools`, and
 * `noDestructiveToolCalled` reports an evidence error on every trial of every
 * run. The declaration does exist; it just lives in the manager's own cache.
 *
 * Servers with a COLD cache contribute nothing rather than an empty map: "the
 * server declared no annotations" and "we never asked" are different facts,
 * and only the first licenses reading a missing `destructiveHint` as a tool
 * that is not destructive.
 */
export function collectToolAnnotations(
  manager: Partial<ToolAnnotationSource> | undefined,
  /**
   * The servers this run actually selected. Annotations are keyed by BARE tool
   * name — the same key `allTools` uses — so a server the run never selected
   * could otherwise supply a `destructiveHint` for a name it happens to share
   * with a selected tool. Omitted means every registered server, which is only
   * right when the caller has no narrower answer.
   */
  serverIds?: readonly string[],
): Record<string, Record<string, unknown>> | undefined {
  // Reading evidence must never be able to fail a run. A manager that does
  // not implement this surface (an older path, a test double) contributes
  // nothing, exactly as a cold cache does.
  if (
    typeof manager?.listServers !== "function" ||
    typeof manager.hasCachedToolAnnotations !== "function" ||
    typeof manager.getAllToolAnnotations !== "function"
  ) {
    return undefined;
  }
  const merged: Record<string, Record<string, unknown>> = {};
  let read = false;
  try {
    const scope = new Set(serverIds ?? []);
    for (const serverId of manager.listServers()) {
      if (scope.size > 0 && !scope.has(serverId)) continue;
      if (!manager.hasCachedToolAnnotations(serverId)) continue;
      read = true;
      for (const [name, annotations] of Object.entries(
        manager.getAllToolAnnotations(serverId) ?? {},
      )) {
        if (isRecord(annotations)) merged[name] = annotations;
      }
    }
  } catch {
    // Silent on purpose, and it is a trade: a logger would be this module's
    // only runtime import — it holds two type imports and nothing else, which
    // is what lets an evidence extractor be read as a pure function of the
    // trace. The failure is not invisible: `noDestructiveToolCalled` reports
    // an evidence error naming the missing declarations on every trial it
    // touches, which is the surface an operator actually looks at.
    return undefined;
  }
  return read ? merged : undefined;
}

/**
 * Map the runner's live tool registry onto the transcript's inventory.
 *
 * Names only from the keys; everything else is the server's own declaration,
 * unwrapped from the two lossy shapes the AI SDK stores it in.
 * `annotations` matter as much as the schema here: `destructiveHint` is a
 * DECLARATION, and a check about a declaration is unevaluatable without it —
 * so they come from {@link collectToolAnnotations} when the ToolSet entry has
 * dropped them, which for a live run is always.
 */
export function toTranscriptToolInventory(
  tools: Record<string, SelectionToolLike> | undefined,
  annotationsByTool?: Record<string, Record<string, unknown>> | undefined,
): TranscriptToolInventoryEntry[] | undefined {
  if (!tools) return undefined;
  return Object.entries(tools).map(([name, tool]) => {
    const inputSchema = unwrapInputSchema(tool?.inputSchema);
    const annotations = isRecord(tool?.annotations)
      ? tool.annotations
      : annotationsByTool?.[name];
    return {
      name,
      ...(typeof tool?.description === "string"
        ? { description: tool.description }
        : {}),
      ...(inputSchema !== undefined ? { inputSchema } : {}),
      ...(isRecord(annotations)
        ? {
            annotations:
              annotations as TranscriptToolInventoryEntry["annotations"],
          }
        : {}),
    };
  });
}
