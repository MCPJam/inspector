/**
 * The trace's mark for a call a mock handled. The mark travels beside the
 * call, never in the result a model reads: the route reports it on a response
 * header, the connection's fetch reads the header and hands the marks to
 * whichever tool call is running in the same async chain. The in-process door
 * also gets each mark through its `onCall` callback, which covers an answer
 * that streams (its headers are sent before the call settles).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { EvalTraceSpan } from "../../../shared/eval-trace.js";
import {
  MOCK_ANSWER_SPAN_PREFIX,
  describeMockCall,
  type MockCallMark,
  type MockCallSource,
} from "../../../shared/mock-answer-span.js";

export const MOCK_CALLS_HEADER = "x-mcpjam-mock-calls";
const MAX_MARKS_PER_RESPONSE = 20;
const SOURCES: ReadonlySet<string> = new Set<MockCallSource>(["saved", "state", "forwarded", "blocked", "unmatched"]);

type Sink = (marks: readonly MockCallMark[]) => void;
const sinkScope = new AsyncLocalStorage<Sink>();

/** Marks read from a response's header while `run` is in flight go to `sink`. */
export function withMockAnswerSink<T>(sink: Sink, run: () => T): T {
  return sinkScope.run(sink, run);
}

/** The running call's sink, for a door that reports marks without a response header. */
export function currentMockAnswerSink(): Sink | undefined {
  return sinkScope.getStore();
}

/** One entry per call: a URL-encoded query string, entries joined by commas (a comma is encoded inside one). */
export function formatMockCalls(marks: readonly MockCallMark[]): string {
  return marks
    .slice(0, MAX_MARKS_PER_RESPONSE)
    .map((m) => {
      const q = new URLSearchParams({ m: m.mockId, v: String(m.version), t: m.tool, s: m.source });
      if (m.realServerId) q.set("b", m.realServerId);
      if (m.realTool) q.set("r", m.realTool);
      if (m.caseIndex !== undefined) q.set("c", String(m.caseIndex));
      if (m.catchAll) q.set("a", "1");
      if (m.refusal) q.set("x", m.refusal);
      return q.toString().replaceAll(",", "%2C");
    })
    .join(",");
}

/** The marks in a header; an entry that does not parse is left out. */
export function parseMockCalls(header: string | null): MockCallMark[] {
  if (!header) return [];
  return header.split(",").flatMap((entry) => {
    const q = new URLSearchParams(entry);
    const mockId = q.get("m");
    const tool = q.get("t");
    const source = q.get("s");
    const version = Number(q.get("v"));
    const caseText = q.get("c");
    const caseIndex = caseText === null ? Number.NaN : Number(caseText);
    if (!mockId || tool === null || !source || !SOURCES.has(source) || !Number.isInteger(version)) {
      return [];
    }
    return [
      {
        mockId,
        version,
        tool,
        source: source as MockCallSource,
        ...(q.get("b") ? { realServerId: q.get("b") as string } : {}),
        ...(q.get("r") ? { realTool: q.get("r") as string } : {}),
        ...(Number.isInteger(caseIndex) && caseIndex >= 0 ? { caseIndex } : {}),
        ...(q.get("a") === "1" ? { catchAll: true } : {}),
        ...(q.get("x") ? { refusal: q.get("x") as string } : {}),
      },
    ];
  });
}

/** The same fetch, reporting a mock's marks to the running tool call. The body is never read. */
export function observeMockAnswered(baseFetch: typeof fetch): typeof fetch {
  return async (...args: Parameters<typeof fetch>) => {
    const response = await baseFetch(...args);
    const sink = sinkScope.getStore();
    if (sink) {
      const marks = parseMockCalls(response.headers.get(MOCK_CALLS_HEADER));
      if (marks.length > 0) sink(marks);
    }
    return response;
  };
}

/**
 * The span that shows what the mock did, under the tool call. It has no tool
 * identity, so nothing that counts tool calls counts it.
 */
export function mockAnswerSpan(
  marks: readonly MockCallMark[],
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
  return {
    id: place.id,
    parentId: place.parentId,
    name: `${MOCK_ANSWER_SPAN_PREFIX}${marks.map(describeMockCall).join("; ")}`,
    category: "step",
    ...(place.promptIndex !== undefined ? { promptIndex: place.promptIndex } : {}),
    ...(place.stepIndex !== undefined ? { stepIndex: place.stepIndex } : {}),
    ...(place.serverId ? { serverId: place.serverId } : {}),
    status: "ok",
    startMs: place.startMs,
    endMs: place.endMs,
  };
}
