import type { EvalTraceSpan } from "./eval-trace";

/**
 * One question a server asked during an eval, and what the run answered. It is
 * a trace record, not a tool call: it carries no `toolCallId`, `toolName` or
 * `toolOrigin`, so every reader that counts tool calls from spans skips it, and
 * it hangs under the call that asked.
 */
export interface InputExchange {
  /** A question to the person, or a request to the run's model (I19). */
  kind: "question" | "model_request";
  /** The server's name as the suite names it. */
  server?: string;
  /** The tool whose call asked, when the run can tell. */
  tool?: string;
  message: string;
  /** Form or URL question; absent for a model request. */
  mode?: "form" | "url";
  /** What came back: a reply's action, or `answered` for a model request. */
  action: "accept" | "decline" | "cancel" | "answered";
  content?: Record<string, unknown>;
  /** Position of the reply in the case's `inputAnswers`; absent when none fit. */
  replyIndex?: number;
  /** Why the exchange was declined without a reply, in words. */
  note?: string;
}

const MESSAGE_PREVIEW_CHARS = 120;

/** The span that shows the exchange, as a child of the call that asked. */
export function exchangeSpan(
  exchange: InputExchange,
  place: {
    id: string;
    parentId?: string;
    promptIndex?: number;
    stepIndex?: number;
    startMs: number;
    endMs: number;
    serverId?: string;
  },
): EvalTraceSpan {
  const message =
    exchange.message.length > MESSAGE_PREVIEW_CHARS
      ? `${exchange.message.slice(0, MESSAGE_PREVIEW_CHARS)}…`
      : exchange.message;
  const asked =
    exchange.kind === "question" ? "Question" : "Request to the model";
  const reply =
    exchange.note ??
    (exchange.action === "answered" ? "answered" : exchange.action);
  return {
    id: place.id,
    ...(place.parentId ? { parentId: place.parentId } : {}),
    name: `${asked}: "${message}" -> ${reply}`,
    category: "step",
    ...(place.promptIndex !== undefined
      ? { promptIndex: place.promptIndex }
      : {}),
    ...(place.stepIndex !== undefined ? { stepIndex: place.stepIndex } : {}),
    ...(place.serverId ? { serverId: place.serverId } : {}),
    status: "ok",
    startMs: place.startMs,
    endMs: place.endMs,
  };
}
