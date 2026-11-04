/**
 * Keeps the copy of the history a model step receives inside the model's
 * context window (PLB-300). The persisted history, the UI and the trace keep
 * the full tool results; only what is sent to the model is bounded.
 *
 * Two rules, both pure functions of the history and the window:
 *
 *   1. CAP. Every tool result is cut to the smaller of 25,000 estimated tokens
 *      and a quarter of the window, keeping its start and end around a marker.
 *      The cut depends only on the result, so a result reads the same on every
 *      step and every turn.
 *   2. CLEAR. When the earlier turns (everything before the last user message)
 *      pass 60% of the window, their oldest results are replaced by a
 *      placeholder, in batches of 20% of the window, until they are under 40%.
 *      The current turn is never touched and the decision reads only earlier
 *      turns, so the cleared set is the same on every step of a turn. That
 *      keeps replayed thinking blocks valid (Claude Fable 5.1 and Opus 5.5
 *      reject a history edited under them) and the prompt cache warm.
 */
import type { ModelMessage } from "ai";
import { isSkillToolName } from "./eval-matching";

export const CONTEXT_COMPACTION_PART = "data-context-compaction";

export const MAX_TOOL_RESULT_TOKENS = 25_000;
export const TOOL_RESULT_CONTEXT_SHARE = 0.25;
export const CLEAR_TRIGGER_SHARE = 0.6;
export const CLEAR_TARGET_SHARE = 0.4;
export const CLEAR_BATCH_SHARE = 0.2;
export const MIN_CLEARABLE_TOKENS = 1_000;
/** What one image or file part costs, whatever its byte size. */
export const FILE_PART_TOKENS = 1_600;

export const CLEARED_TOOL_RESULT_TEXT =
  "[Cleared by MCPJam to fit the model's context window. Call the tool again if you need this result.]";

export type ContextCompactionReport = {
  shortened: Array<{
    toolCallId: string;
    toolName: string;
    originalTokens: number;
    keptTokens: number;
  }>;
  cleared: Array<{ toolCallId: string; toolName: string; tokens: number }>;
};

export type FitMessagesOptions = {
  /** The model's context window; unknown means cap only, never clear. */
  contextTokens?: number;
  /** Tokens the step spends outside `messages`: system prompt and tools. */
  fixedTokens?: number;
};

const DENSE_RUN = /[A-Za-z0-9+/=_-]{64,}/g;
const PROSE_CHARS_PER_TOKEN = 3;

/**
 * ponytail: a character-class heuristic, not a tokenizer. Base64 measured at
 * 1.15 characters per Claude token, so long runs count one token per
 * character, as does non-ASCII text; the rest counts three characters per
 * token, the backend's own JSON rate. Upgrade path: calibrate with the
 * provider's reported input tokens.
 */
export function estimateModelTokens(text: string): number {
  if (!text) return 0;
  let dense = 0;
  for (const run of text.matchAll(DENSE_RUN)) dense += run[0].length;
  let nonAscii = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7f) nonAscii++;
  }
  const rest = Math.max(0, text.length - dense - nonAscii);
  return dense + nonAscii + Math.ceil(rest / PROSE_CHARS_PER_TOKEN);
}

type Part = Record<string, unknown>;
type Output = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function serialize(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
}

function outputTokens(output: unknown): number {
  if (!isRecord(output)) return 0;
  switch (output.type) {
    case "text":
    case "error-text":
      return estimateModelTokens(serialize(output.value));
    case "json":
    case "error-json":
      return estimateModelTokens(serialize(output.value));
    case "content":
      return Array.isArray(output.value)
        ? output.value.reduce(
            (sum: number, part: unknown) =>
              sum +
              (isRecord(part) && part.type === "text"
                ? estimateModelTokens(serialize(part.text))
                : FILE_PART_TOKENS),
            0,
          )
        : 0;
    case "execution-denied":
      return estimateModelTokens(serialize(output.reason));
    default:
      return 0;
  }
}

function partTokens(part: unknown): number {
  if (typeof part === "string") return estimateModelTokens(part);
  if (!isRecord(part)) return 0;
  switch (part.type) {
    case "text":
    case "reasoning":
      return estimateModelTokens(serialize(part.text));
    case "tool-call":
      return (
        estimateModelTokens(serialize(part.toolName)) +
        estimateModelTokens(serialize(part.input))
      );
    case "tool-result":
      return outputTokens(part.output);
    case "file":
    case "image":
      return FILE_PART_TOKENS;
    default:
      return 0;
  }
}

/**
 * The model-visible size of a message list: text, reasoning text, tool-call
 * input and tool output. Images and files count a fixed amount; provider
 * options and metadata are not counted.
 */
export function estimateMessagesTokens(
  messages: readonly ModelMessage[],
): number {
  let total = 0;
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    total += Array.isArray(content)
      ? content.reduce((sum: number, part) => sum + partTokens(part), 0)
      : partTokens(content);
  }
  return total;
}

function cutMarker(cut: number, original: number): string {
  const n = (value: number) => value.toLocaleString("en-US");
  return `\n\n[MCPJam cut ${n(cut)} of ${n(original)} estimated tokens from the middle of this tool result to fit the model's context window. The full result is in the chat.]\n\n`;
}

/** The start and end of `text` around a marker, strictly under `cap`. */
function cutText(
  text: string,
  cap: number,
): { text: string; originalTokens: number; keptTokens: number } {
  const originalTokens = estimateModelTokens(text);
  const markerTokens = estimateModelTokens(
    cutMarker(originalTokens, originalTokens),
  );
  const budget = Math.max(0, cap - markerTokens - 1);
  let keepChars = Math.floor((budget * text.length) / originalTokens);
  for (;;) {
    const head = text.slice(0, Math.ceil(keepChars / 2));
    const tail = text.slice(text.length - Math.floor(keepChars / 2));
    const keptTokens = estimateModelTokens(head) + estimateModelTokens(tail);
    const result = `${head}${cutMarker(originalTokens - keptTokens, originalTokens)}${tail}`;
    if (estimateModelTokens(result) < cap || keepChars === 0) {
      return { text: result, originalTokens, keptTokens };
    }
    keepChars = Math.floor(keepChars * 0.9);
  }
}

function capOutput(
  output: Output,
  cap: number,
): { output: Output; originalTokens: number; keptTokens: number } | undefined {
  const tokens = outputTokens(output);
  if (tokens < cap) return undefined;
  switch (output.type) {
    case "text":
    case "json":
    case "error-text":
    case "error-json": {
      const cut = cutText(serialize(output.value), cap);
      const type = output.type.startsWith("error") ? "error-text" : "text";
      return { output: { type, value: cut.text }, ...cut };
    }
    case "content": {
      const parts = output.value as unknown[];
      const textTokens = parts.reduce(
        (sum: number, part) =>
          sum + (isRecord(part) && part.type === "text" ? partTokens(part) : 0),
        0,
      );
      const textCap = cap - (tokens - textTokens);
      if (textTokens === 0 || textCap <= 0) return undefined;
      let kept = 0;
      const value = parts.map((part) => {
        if (!isRecord(part) || part.type !== "text") return part;
        const own = partTokens(part);
        const share = Math.floor((textCap * own) / textTokens);
        if (own < share) {
          kept += own;
          return part;
        }
        const cut = cutText(serialize(part.text), share);
        kept += cut.keptTokens;
        return { ...part, text: cut.text };
      });
      return {
        output: { ...output, value },
        originalTokens: tokens,
        keptTokens: kept,
      };
    }
    default:
      return undefined;
  }
}

function resultCap(contextTokens: number | undefined): number {
  return contextTokens
    ? Math.min(
        MAX_TOOL_RESULT_TOKENS,
        Math.floor(contextTokens * TOOL_RESULT_CONTEXT_SHARE),
      )
    : MAX_TOOL_RESULT_TOKENS;
}

function isClearable(part: Part): boolean {
  const output = part.output;
  return (
    !isSkillToolName(String(part.toolName)) &&
    isRecord(output) &&
    output.type !== "execution-denied" &&
    outputTokens(output) >= MIN_CLEARABLE_TOKENS
  );
}

/**
 * Bound the messages a model step receives. Returns the input unchanged (and
 * no report) when nothing needed shortening or clearing; never mutates it.
 */
export function fitMessagesToModelContext(
  messages: readonly ModelMessage[],
  options: FitMessagesOptions,
): { messages: ModelMessage[]; report?: ContextCompactionReport } {
  const contextTokens =
    typeof options.contextTokens === "number" &&
    Number.isFinite(options.contextTokens) &&
    options.contextTokens > 0
      ? options.contextTokens
      : undefined;
  const cap = resultCap(contextTokens);
  let turnStart = 0;
  messages.forEach((message, index) => {
    if (message.role === "user") turnStart = index;
  });

  const report: ContextCompactionReport = { shortened: [], cleared: [] };
  let changed = false;
  const fitted = messages.map((message, index) => {
    if (message.role !== "tool" || !Array.isArray(message.content))
      return message;
    let messageChanged = false;
    const content = (message.content as Part[]).map((part) => {
      if (part.type !== "tool-result" || !isRecord(part.output)) return part;
      const capped = capOutput(part.output, cap);
      if (!capped) return part;
      messageChanged = true;
      if (index > turnStart) {
        report.shortened.push({
          toolCallId: String(part.toolCallId),
          toolName: String(part.toolName),
          originalTokens: capped.originalTokens,
          keptTokens: capped.keptTokens,
        });
      }
      return { ...part, output: capped.output };
    });
    if (!messageChanged) return message;
    changed = true;
    return { ...message, content } as ModelMessage;
  });

  if (contextTokens) {
    const earlier =
      estimateMessagesTokens(fitted.slice(0, turnStart)) +
      (options.fixedTokens ?? 0);
    if (earlier > contextTokens * CLEAR_TRIGGER_SHARE) {
      const batch = contextTokens * CLEAR_BATCH_SHARE;
      const needed =
        Math.ceil((earlier - contextTokens * CLEAR_TARGET_SHARE) / batch) *
        batch;
      let cleared = 0;
      for (let index = 0; index < turnStart && cleared < needed; index++) {
        const message = fitted[index];
        if (message.role !== "tool" || !Array.isArray(message.content))
          continue;
        const content = (message.content as Part[]).map((part) => {
          if (
            cleared >= needed ||
            part.type !== "tool-result" ||
            !isClearable(part)
          ) {
            return part;
          }
          const tokens = outputTokens(part.output);
          cleared += tokens;
          report.cleared.push({
            toolCallId: String(part.toolCallId),
            toolName: String(part.toolName),
            tokens,
          });
          return {
            ...part,
            output: { type: "text", value: CLEARED_TOOL_RESULT_TEXT },
          };
        });
        fitted[index] = { ...message, content } as ModelMessage;
      }
      changed ||= report.cleared.length > 0;
    }
  }

  if (!changed) return { messages: messages as ModelMessage[] };
  const hasReport = report.shortened.length > 0 || report.cleared.length > 0;
  return { messages: fitted, ...(hasReport ? { report } : {}) };
}
