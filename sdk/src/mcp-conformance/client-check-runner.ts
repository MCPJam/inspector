import type {
  MCPCheckEra,
  MCPCheckId,
  MCPCheckResult,
  MCPClientCheckContext,
  MCPClientCheckDefinition,
} from "./types.js";
import { CHECK_ERAS } from "./types.js";
import {
  blockedByDetails,
  stoppedAnsweringMessage,
} from "../conformance-blocked.js";
import {
  blockedResult,
  couldNotRunResult,
  eraSkipMessage,
  errorMessage,
  failedResult,
  notApplicableResult,
  timedOutResult,
} from "./checks/helpers.js";
import {
  isRequestTimeoutError,
  isTimedOutCheck,
  withDeadline,
} from "../conformance-timeout.js";

/**
 * Era gate for a client-backed check. Returns a `skipped` result (never
 * filtered out — the check still appears in the report) when the check does
 * not apply to the run's era per {@link CHECK_ERAS}, else `undefined` so the
 * check runs normally. Skipped checks never fail a run (the verdict is
 * `checks.every(c => c.status !== "failed")`).
 */
export function eraGate(
  check: MCPClientCheckDefinition,
  era: MCPCheckEra,
  protocolVersion: string | undefined
): MCPCheckResult | undefined {
  if (CHECK_ERAS[check.id].includes(era)) {
    return undefined;
  }
  return notApplicableResult(check, eraSkipMessage(era, protocolVersion));
}

/** Timeouts in a row after which the remaining client checks are skipped. */
const MAX_TIMEOUTS_IN_A_ROW = 2;

/** These checks read connection data without asking the server for an answer. */
const CONNECTION_DATA_CHECK_IDS = new Set<MCPCheckId>([
  "server-initialize",
  "modern-client-handshake",
  "capabilities-consistent",
]);

export async function runSelectedClientChecks(
  selectedClientChecks: readonly MCPClientCheckDefinition[],
  ctx: MCPClientCheckContext
): Promise<MCPCheckResult[]> {
  const config = ctx.config;
  const results: MCPCheckResult[] = [];
  /** The check whose error broke the session; every later check names it. */
  let connectionLostBy: MCPClientCheckDefinition | undefined;
  // Checks in a row that ran out of time. A timeout leaves the session
  // usable, but at this many the server has stopped answering, and each
  // check after would wait out the full limit for the same silence.
  let timeoutStreak = 0;
  /** The checks in the current streak, named in the skips that follow. */
  let timedOut: MCPClientCheckDefinition[] = [];

  for (const check of selectedClientChecks) {
    config.signal?.throwIfAborted();
    // Era gate first: an era-inapplicable check is a deterministic skip
    // that never runs `check.run`, so it neither observes nor affects
    // the `connectionLost` sequencing below.
    const eraSkip = eraGate(check, config.era, config.protocolVersion);
    if (eraSkip) {
      results.push(eraSkip);
      continue;
    }

    if (connectionLostBy) {
      results.push(blockedResult(check, connectionLostBy));
      continue;
    }

    if (timeoutStreak >= MAX_TIMEOUTS_IN_A_ROW) {
      results.push(
        couldNotRunResult(
          check,
          stoppedAnsweringMessage(timedOut.map((entry) => entry.title)),
          timedOut.length > 0 ? blockedByDetails(timedOut[0]!.id) : undefined
        )
      );
      continue;
    }

    try {
      const result = await withDeadline(
        (signal) => check.run({ ...ctx, config: { ...config, signal } }),
        config.checkTimeout,
        () => timedOutResult(check, config.checkTimeout),
        config.signal
      );
      config.signal?.throwIfAborted();
      // Only an answer ends the streak; a skip asked the server nothing.
      if (isTimedOutCheck(result)) {
        timeoutStreak += 1;
        timedOut.push(check);
      } else if (
        result.status !== "skipped" &&
        !CONNECTION_DATA_CHECK_IDS.has(check.id)
      ) {
        timeoutStreak = 0;
        timedOut = [];
      }
      results.push(result);
    } catch (error) {
      config.signal?.throwIfAborted();
      if (isRequestTimeoutError(error)) {
        timeoutStreak += 1;
        timedOut.push(check);
        results.push(timedOutResult(check, config.checkTimeout));
        continue;
      }
      results.push(
        failedResult(check, 0, errorMessage(error), undefined, error)
      );
      connectionLostBy = check;
    }
  }
  return results;
}
