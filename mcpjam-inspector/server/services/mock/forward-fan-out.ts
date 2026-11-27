import { HOSTED_MODE } from "../../config.js";
import { createFixedWindowMap } from "../../middleware/passthrough-rate-limit.js";

/**
 * How fast one caller's mock forwards may fan out to real servers through the
 * in-process door. A mock is dialed once per eval case or chat turn, so the
 * door's own HTTP limits never see these calls; without this, one caller could
 * drive unbounded real traffic through mocks.
 *
 * A fixed window per caller, from the same window map as the web limiters, and
 * per replica like them. Local mode is exempt: it is one person's own Inspector
 * reaching their own servers.
 */
const FORWARDS_PER_MINUTE = 120;
const WINDOW_MS = 60_000;

const windows = createFixedWindowMap(FORWARDS_PER_MINUTE, WINDOW_MS);

export const MOCK_FORWARDS_PER_MINUTE = FORWARDS_PER_MINUTE;

/** Takes one forward from this caller's allowance, or says how long to wait. */
export function takeMockForward(callerKey: string): { retryAfterSeconds: number } | null {
  if (!HOSTED_MODE) return null;
  const waitMs = windows.charge(`forward:${callerKey}`);
  return waitMs === null ? null : { retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
}

export function forwardFanOutMessage(retryAfterSeconds: number): string {
  return `This account is sending mock calls to real servers too fast. Wait ${retryAfterSeconds} seconds, then try again.`;
}

export function resetMockForwardFanOutForTests(): void {
  windows.clear();
}
