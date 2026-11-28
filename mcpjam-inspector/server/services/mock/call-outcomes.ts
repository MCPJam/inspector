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
 * never fails, delays or retries a call, and a caller's outcomes beyond what
 * it may hold unsent are dropped.
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
/**
 * One caller's outcomes waiting or in a send that has not settled: a caller
 * whose reports hang holds at most this many, and later ones are dropped.
 */
const MAX_PENDING_PER_CALLER = 500;
/** Sends one caller may have unsettled at once; its other outcomes wait for one to settle. */
const MAX_SENDS_PER_CALLER = 10;

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
  private readonly pending = new Map<string, number>();
  private readonly sending = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = new Set<Promise<void>>();

  constructor(private readonly options: OutcomeReporterOptions = {}) {}

  /** `callerKey` groups one caller's outcomes: a batch is sent as that caller. */
  record(callerKey: string, who: OutcomeCaller, entry: OutcomeEntry): void {
    const pending = this.pending.get(callerKey) ?? 0;
    if (pending >= MAX_PENDING_PER_CALLER) return;
    this.pending.set(callerKey, pending + 1);
    const group = this.waiting.get(callerKey) ?? { who, entries: [] };
    group.entries.push(entry);
    this.waiting.set(callerKey, group);
    // A full batch goes now, and only this caller's; a partial one waits for the short timer.
    if (group.entries.length >= MAX_OUTCOMES_PER_BATCH) return this.sendWaiting(callerKey);
    this.timer ??= setTimeout(() => this.sendAllWaiting(), this.options.flushAfterMs ?? FLUSH_AFTER_MS);
    this.timer.unref?.();
  }

  /** Sends everything waiting and resolves once no send is left unsettled. Never rejects. */
  async flush(): Promise<void> {
    this.sendAllWaiting();
    // A send that settles frees a place for outcomes still waiting, which go then.
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  private sendAllWaiting(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const callerKey of [...this.waiting.keys()]) this.sendWaiting(callerKey);
  }

  /** Sends a caller's waiting outcomes in batches while it has a send to spare; the rest wait. */
  private sendWaiting(callerKey: string): void {
    const group = this.waiting.get(callerKey);
    while (group && group.entries.length > 0 && (this.sending.get(callerKey) ?? 0) < MAX_SENDS_PER_CALLER) {
      const batch = group.entries.splice(0, MAX_OUTCOMES_PER_BATCH);
      adjust(this.sending, callerKey, 1);
      const send = this.send(group.who, batch).finally(() => this.settle(callerKey, batch.length));
      this.inFlight.add(send);
      void send.finally(() => this.inFlight.delete(send));
    }
    if (group?.entries.length === 0) this.waiting.delete(callerKey);
  }

  private settle(callerKey: string, count: number): void {
    adjust(this.pending, callerKey, -count);
    adjust(this.sending, callerKey, -1);
    this.sendWaiting(callerKey);
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
      // Nothing reads the answer; unread, its body would hold the connection.
      await response.body?.cancel();
    } catch (error) {
      logger.warn("[mock-route] call outcomes could not be sent", {
        error: error instanceof Error ? error.name : typeof error,
        count: entries.length,
      });
    }
  }
}

/** Adds to a count, dropping it at zero. */
function adjust(counts: Map<string, number>, key: string, by: number): void {
  const next = (counts.get(key) ?? 0) + by;
  if (next > 0) counts.set(key, next);
  else counts.delete(key);
}

/** The process's reporter; `flushMockOutcomes` is called once at shutdown. */
const reporter = new MockOutcomeReporter();

export function reportMockOutcome(callerKey: string, who: OutcomeCaller, mark: MockCallMark): void {
  reporter.record(callerKey, who, outcomeOf(mark));
}

export const flushMockOutcomes = () => reporter.flush();
