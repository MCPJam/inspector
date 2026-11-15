/**
 * The hourly synthetic check of the hosted browser: reserve a desktop, boot
 * browserd, open a fixed page, count its WebMCP tools, and delete the desktop.
 * The backend cron calls it through `routes/internal/hosted-browser-synthetic.ts`
 * and pages when it fails.
 *
 * Orchestration only, in the injected-seam form `browser-debug-probe.ts` uses:
 * the live seams are the calls the WebMCP inspector's hosted start makes, so
 * every stage's failure, and the teardown after it, is testable without E2B.
 *
 * Teardown is the load-bearing part. The check runs every hour against a box
 * nobody watches, so one that leaked a desktop would bill an awake machine
 * until the idle sweep noticed. It runs in a `finally`, after every outcome,
 * including the run timing out.
 */
import { redactForLog } from "../../routes/v1/redact-log-message.js";
import { logger } from "../../utils/logger.js";

/** The step that failed, or `complete` when none did. */
export type SyntheticStage =
  "config" | "reserve" | "boot" | "open" | "tools" | "teardown" | "complete";

export interface SyntheticResult {
  ok: boolean;
  stage: SyntheticStage;
  /** Wall clock of the whole check, teardown included. */
  durationMs: number;
  toolCount: number;
  error?: string;
}

/** A page open in the hosted browser, narrowed to what the check reads. */
export interface SyntheticPage {
  /** Re-read the page's WebMCP tools. Throws when the read itself fails. */
  countTools(): Promise<number>;
  close(): Promise<void>;
}

export interface SyntheticBrowser {
  open(url: string): Promise<SyntheticPage>;
}

export interface SyntheticDeps {
  /** Reserve the desktop and wait until it is ready. */
  reserve(signal: AbortSignal): Promise<void>;
  /** Boot browserd on the reserved desktop. */
  boot(signal: AbortSignal): Promise<SyntheticBrowser>;
  /** Delete the desktop. Called once on every outcome. */
  teardown(): Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SyntheticOptions {
  url: string;
  /**
   * Budget for reserve through tools. A cold desktop provision plus a
   * browserd boot is the slow path, and it has to stay under the backend's
   * request timeout with the teardown budget added.
   */
  timeoutMs?: number;
  teardownTimeoutMs?: number;
  /**
   * How long an empty tool list is re-read before it counts as a failure. A
   * page registers its tools from script after load, so the first read can
   * race it.
   */
  toolWaitMs?: number;
  toolPollMs?: number;
}

export const SYNTHETIC_RUN_TIMEOUT_MS = 240_000;
export const SYNTHETIC_TEARDOWN_TIMEOUT_MS = 30_000;
const TOOL_WAIT_MS = 10_000;
const TOOL_POLL_MS = 1_000;

class SyntheticTimeoutError extends Error {
  constructor(ms: number) {
    super(`the check did not finish within ${Math.round(ms / 1000)}s`);
    this.name = "SyntheticTimeoutError";
  }
}

/**
 * Stop waiting on `work` when `signal` fires.
 *
 * The work itself may keep running: `createSession` takes no signal. That is
 * safe because the teardown deletes the desktop it would be running against.
 */
function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

async function waitForTools(
  page: SyntheticPage,
  signal: AbortSignal,
  options: { waitMs: number; pollMs: number },
  clock: { now: () => number; sleep: (ms: number) => Promise<void> },
): Promise<number> {
  const deadline = clock.now() + options.waitMs;
  for (;;) {
    const count = await page.countTools();
    if (count > 0 || clock.now() >= deadline) return count;
    await clock.sleep(options.pollMs);
    if (signal.aborted) throw signal.reason;
  }
}

/** Never throws: a teardown failure is reported, not raised. */
async function tearDown(
  deps: SyntheticDeps,
  page: SyntheticPage | undefined,
  timeoutMs: number,
): Promise<string | undefined> {
  // The delete goes first: it is what stops the billing, so nothing that only
  // tidies this process may delay or skip it.
  const signal = AbortSignal.timeout(timeoutMs);
  let failure: string | undefined;
  try {
    await bounded(deps.teardown(), signal);
  } catch (error) {
    failure = signal.aborted
      ? `teardown did not finish within ${Math.round(timeoutMs / 1000)}s`
      : redactForLog(error);
  }
  if (page) {
    try {
      await page.close();
    } catch (error) {
      // Closing only releases this process's handle on a page whose desktop
      // is already gone, so a failure here is logged and costs nothing.
      logger.warn("[hosted-browser-synthetic] closing the page failed", {
        error: redactForLog(error),
      });
    }
  }
  return failure;
}

export async function runHostedBrowserSynthetic(
  deps: SyntheticDeps,
  options: SyntheticOptions,
): Promise<SyntheticResult> {
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? SYNTHETIC_RUN_TIMEOUT_MS;
  const startedAt = now();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new SyntheticTimeoutError(timeoutMs)),
    timeoutMs,
  );

  let stage: SyntheticStage = "reserve";
  let page: SyntheticPage | undefined;
  let toolCount = 0;
  let failure: string | undefined;
  let teardownError: string | undefined;
  try {
    await bounded(deps.reserve(controller.signal), controller.signal);
    stage = "boot";
    const browser = await bounded(
      deps.boot(controller.signal),
      controller.signal,
    );
    stage = "open";
    page = await bounded(browser.open(options.url), controller.signal);
    stage = "tools";
    toolCount = await bounded(
      waitForTools(
        page,
        controller.signal,
        {
          waitMs: options.toolWaitMs ?? TOOL_WAIT_MS,
          pollMs: options.toolPollMs ?? TOOL_POLL_MS,
        },
        { now, sleep },
      ),
      controller.signal,
    );
    if (toolCount === 0) {
      failure = "the page loaded but registered no WebMCP tools";
    }
  } catch (error) {
    failure = redactForLog(error);
  } finally {
    clearTimeout(timer);
    teardownError = await tearDown(
      deps,
      page,
      options.teardownTimeoutMs ?? SYNTHETIC_TEARDOWN_TIMEOUT_MS,
    );
  }

  const durationMs = now() - startedAt;
  if (failure !== undefined) {
    return {
      ok: false,
      stage,
      durationMs,
      toolCount,
      error: teardownError
        ? `${failure}; teardown also failed: ${teardownError}`
        : failure,
    };
  }
  if (teardownError !== undefined) {
    return {
      ok: false,
      stage: "teardown",
      durationMs,
      toolCount,
      error: teardownError,
    };
  }
  return { ok: true, stage: "complete", durationMs, toolCount };
}
