/**
 * The trace's mark for a call a mock answered itself. The route reports it on
 * a response header (`x-mcpjam-mock-answered`) and never in the result a model
 * reads, so the mark travels beside the call: the connection's fetch reads the
 * header and hands the marks to whichever tool call is running in the same
 * async chain. Both doors pass through that fetch, the in-process one and a
 * mock dialed at its address.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { MockAnswerSource } from "@mcpjam/sdk/mocks";
import type { EvalTraceSpan } from "../../../shared/eval-trace.js";
import { MOCK_ANSWER_SPAN_PREFIX } from "../../../shared/mock-answer-span.js";

/** Same string as `MOCK_ANSWERED_HEADER` in `route.ts`, which this module must not import (the route imports the dialers). */
const HEADER = "x-mcpjam-mock-answered";

export interface MockAnswerMark {
  tool: string;
  source: MockAnswerSource;
}

type Sink = (marks: readonly MockAnswerMark[]) => void;

const sinkScope = new AsyncLocalStorage<Sink>();

/** Marks read from a response's header while `run` is in flight go to `sink`. */
export function withMockAnswerSink<T>(sink: Sink, run: () => T): T {
  return sinkScope.run(sink, run);
}

/** `tool=source,tool=source` with tool names URL-encoded; a pair that does not parse is left out. */
export function parseMockAnswered(header: string | null): MockAnswerMark[] {
  if (!header) return [];
  return header.split(",").flatMap((pair) => {
    const at = pair.lastIndexOf("=");
    if (at <= 0) return [];
    const source = pair.slice(at + 1).trim();
    if (source !== "saved" && source !== "model") return [];
    try {
      return [{ tool: decodeURIComponent(pair.slice(0, at).trim()), source }];
    } catch {
      return [];
    }
  });
}

/** The same fetch, reporting a mock's marks to the running tool call. The body is never read. */
export function observeMockAnswered(baseFetch: typeof fetch): typeof fetch {
  return async (...args: Parameters<typeof fetch>) => {
    const response = await baseFetch(...args);
    const sink = sinkScope.getStore();
    if (sink) {
      const marks = parseMockAnswered(response.headers.get(HEADER));
      if (marks.length > 0) sink(marks);
    }
    return response;
  };
}

const SOURCE_WORDS: Record<MockAnswerSource, string> = {
  saved: "its saved answer",
  model: "a model's answer",
};

/**
 * The span that shows who answered, under the tool call. Like a question's
 * record it has no tool identity, so nothing that counts tool calls counts it.
 */
export function mockAnswerSpan(
  marks: readonly MockAnswerMark[],
  place: {
    id: string;
    parentId: string;
    promptIndex?: number;
    stepIndex?: number;
    serverId?: string;
    startMs: number;
    endMs: number;
  },
): EvalTraceSpan {
  const sources = [...new Set(marks.map((m) => m.source))];
  return {
    id: place.id,
    parentId: place.parentId,
    name: `${MOCK_ANSWER_SPAN_PREFIX}${sources.map((s) => SOURCE_WORDS[s]).join(", ")}`,
    category: "step",
    ...(place.promptIndex !== undefined ? { promptIndex: place.promptIndex } : {}),
    ...(place.stepIndex !== undefined ? { stepIndex: place.stepIndex } : {}),
    ...(place.serverId ? { serverId: place.serverId } : {}),
    status: "ok",
    startMs: place.startMs,
    endMs: place.endMs,
  };
}
