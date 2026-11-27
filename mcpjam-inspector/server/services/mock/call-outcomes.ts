/**
 * Reports what each mock call came to, so the production signal exists and an
 * HTTP answer that streamed still has its provenance recorded. Both doors feed
 * this from the same observer.
 *
 * What leaves is the mock, version, tool, source, the saved case that answered
 * (its index and whether it is a catch-all), the real tool of a forward
 * and the refusal code. Never arguments, results or the real server's id.
 * Reports are best effort: they are batched (at most 50, sent on a short timer
 * and at shutdown), and a report that fails is logged and dropped. A report
 * never fails, delays or retries a call.
 *
 * The backend's `POST /web/mock/call-outcomes` (B3) reads `tool` and `realTool`
 * beside `mockId`, `version`, `source` and `refusal`, so both are sent and are
 * recorded when present.
 */
import type { MockCallMark } from "../../../shared/mock-answer-span.js";
import { buildConvexAuthHeaders, type ManagerCallerContext } from "../../routes/web/auth.js";
import { logger } from "../../utils/logger.js";

export const MAX_OUTCOMES_PER_BATCH = 50;
const FLUSH_AFTER_MS = 2_000;
const REPORT_TIMEOUT_MS = 5_000;
/** Outcomes waiting for a caller whose reports keep failing stop growing here. */
const MAX_WAITING_PER_CALLER = 500;

export interface OutcomeCaller {
  caller: ManagerCallerContext;
  /** Held in memory until the report is sent; never logged. */
  bearerToken: string;
}

/** The report's entry for one call: ids and closed words only. */
export interface OutcomeEntry {
  mockId: string;
  version: number;
  tool: string;
  source: MockCallMark["source"];
  realTool?: string;
  /** For a saved answer: the case that answered, counted from 0. */
  caseIndex?: number;
  /** The answering case has no `when`; the backend counts these apart from planned answers. */
  catchAll?: boolean;
  refusal?: string;
}

/** The backend wants a refusal as a short lowercase word; anything else is left out. */
const REFUSAL_WORD = /^[a-z][a-z0-9_]{0,47}$/;

export function outcomeOf(mark: MockCallMark): OutcomeEntry {
  return {
    mockId: mark.mockId,
    version: mark.version,
    tool: mark.tool,
    source: mark.source,
    ...(mark.realTool && { realTool: mark.realTool }),
    ...(mark.caseIndex !== undefined && { caseIndex: mark.caseIndex }),
    ...(mark.catchAll && { catchAll: true }),
    ...(mark.refusal && REFUSAL_WORD.test(mark.refusal) && { refusal: mark.refusal }),
  };
}

export interface OutcomeReporterOptions {
  fetch?: typeof fetch;
  flushAfterMs?: number;
}

export class MockOutcomeReporter {
  private readonly waiting = new Map<string, { who: OutcomeCaller; entries: OutcomeEntry[] }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = new Set<Promise<void>>();

  constructor(private readonly options: OutcomeReporterOptions = {}) {}

  /** `callerKey` groups one caller's outcomes: a batch is sent as that caller. */
  record(callerKey: string, who: OutcomeCaller, entry: OutcomeEntry): void {
    const group = this.waiting.get(callerKey) ?? { who, entries: [] };
    if (group.entries.length >= MAX_WAITING_PER_CALLER) return;
    group.entries.push(entry);
    this.waiting.set(callerKey, group);
    if (group.entries.length >= MAX_OUTCOMES_PER_BATCH) return void this.flush();
    this.timer ??= setTimeout(() => void this.flush(), this.options.flushAfterMs ?? FLUSH_AFTER_MS);
    this.timer.unref?.();
  }

  /** Sends everything waiting and resolves when the sends have settled. Never rejects. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const groups = [...this.waiting.values()];
    this.waiting.clear();
    for (const { who, entries } of groups) {
      for (let i = 0; i < entries.length; i += MAX_OUTCOMES_PER_BATCH) {
        const send = this.send(who, entries.slice(i, i + MAX_OUTCOMES_PER_BATCH));
        this.inFlight.add(send);
        void send.finally(() => this.inFlight.delete(send));
      }
    }
    await Promise.all([...this.inFlight]);
  }

  private async send(who: OutcomeCaller, entries: OutcomeEntry[]): Promise<void> {
    const convexUrl = process.env.CONVEX_HTTP_URL;
    if (!convexUrl) return; // nothing to report to; the call already answered
    try {
      const response = await (this.options.fetch ?? fetch)(`${convexUrl}/web/mock/call-outcomes`, {
        method: "POST",
        headers: buildConvexAuthHeaders(who.caller, who.bearerToken),
        body: JSON.stringify({
          outcomes: entries,
        }),
        signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
      });
      if (!response.ok) {
        logger.warn("[mock-route] call outcomes were not recorded", { status: response.status, count: entries.length });
      }
    } catch (error) {
      logger.warn("[mock-route] call outcomes could not be sent", {
        error: error instanceof Error ? error.name : typeof error,
        count: entries.length,
      });
    }
  }
}

/** The process's reporter; `flushMockOutcomes` is called once at shutdown. */
const reporter = new MockOutcomeReporter();

export function reportMockOutcome(callerKey: string, who: OutcomeCaller, mark: MockCallMark): void {
  reporter.record(callerKey, who, outcomeOf(mark));
}

export const flushMockOutcomes = () => reporter.flush();
