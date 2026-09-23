/**
 * Stop a failed console write from taking the app down.
 *
 * INSPECTOR-ELECTRON-WE: a packaged Windows build died three seconds after
 * launch with `EPIPE: broken pipe, write`, thrown out of `console.info` inside
 * electron-log's console transport:
 *
 *     Logger.logData -> Logger.processMessage -> transport -> writeFn
 *       -> console.info -> Writable.write -> Socket._write   // EPIPE
 *
 * On Windows a packaged GUI app's stdout is a pipe, and a pipe with nothing on
 * the other end throws on write. Neither electron-log nor the call site guards
 * that: `Logger.processMessage` invokes each transport bare, so the throw walks
 * straight out of the log call into whatever was running at the time. Sentry
 * recorded it `level: fatal`, `handled: no`.
 *
 * Whether it also ended the process is not something the report settles — the
 * mechanism is `generic`, not `onuncaughtexception`, so it did not come through
 * the forced-exit integration. What argues for it is the shape: two users, one
 * event each, three seconds after launch, and then silence. A dead pipe does
 * not heal, so a process that kept running would have thrown again on the next
 * line and the next; one event per user is what a process that stopped looks
 * like. Inference, not a finding.
 *
 * Either way the defect is the same and so is the fix. A log line must not be
 * able to end the statement that emitted it.
 *
 * The rule this restores is the one `process-vitals.ts` already states for its
 * sampler: telemetry must never be what takes the process down. Logging is not
 * load-bearing; the thing it was describing is.
 */

/**
 * What this needs from `log.transports.console`.
 *
 * Structural rather than imported: electron-log declares its types inside a
 * `declare namespace`, and stating the two members directly keeps the test
 * free of electron-log entirely. Method syntax to match the declaration
 * (`writeFn(options: { message: LogMessage }): void`) so the real transport
 * satisfies this without a cast at the call site.
 */
type FailSafeTransport = {
  writeFn(payload: { message: unknown }): void;
  level: unknown;
};

/**
 * Wrap the console transport so a write failure is survivable, and stop using
 * it once it fails.
 *
 * DISABLED rather than merely swallowed. A broken pipe does not heal: the
 * reader is gone for the life of the process, so every later line would pay
 * the same throw for the same nothing. Setting `level = false` is how
 * electron-log skips a transport (`core/Logger.js`: `transFn.level === false`).
 *
 * Silent on purpose. The obvious instinct is to log that logging broke, and
 * the only logger available is the one that just threw — either a recursive
 * write into the same dead pipe, or a line nobody will read. The file
 * transport is untouched and keeps every subsequent line, which is the channel
 * a user attaches to a bug report anyway. What is lost is console output that
 * was already going nowhere.
 */
export function makeConsoleTransportFailSafe(
  transport: FailSafeTransport
): void {
  const write = transport.writeFn;
  transport.writeFn = (payload: { message: unknown }) => {
    try {
      write(payload);
    } catch {
      transport.level = false;
    }
  };
}
