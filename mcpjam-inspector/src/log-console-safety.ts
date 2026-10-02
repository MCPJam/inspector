/**
 * Stop a dead stdout/stderr pipe from taking the app down.
 *
 * INSPECTOR-ELECTRON-WE: packaged Windows builds died three seconds after
 * launch with `EPIPE: broken pipe, write`. A packaged GUI app's stdout is a
 * pipe, and when whatever launched it goes away the pipe has no reader.
 *
 * How the failure actually ARRIVES matters more than where it starts, and the
 * first version of this fix got it wrong. The Sentry stack runs through
 * `console.info` down to `Socket._write`, which reads like a synchronous throw
 * out of the log call — so it wrapped electron-log's `writeFn` in a
 * `try/catch`. That catch never runs. Node's console already swallows a
 * synchronous throw from `stream.write()` (`[kWriteToConsole]`), and the
 * EPIPE is delivered LATER, as an `'error'` event on the stream. With no
 * listener, an unhandled `'error'` event is an uncaught exception, and the
 * process dies. The stack shows where the error object was created, not where
 * it was delivered.
 *
 * Reproduced on Windows, Node 24, writing to a pipe whose reader was closed:
 *
 *   no listener    `console.info` throws 0 times; process exits on
 *                  `UNCAUGHT: EPIPE`
 *   'error' listener  `console.info` throws 0 times; process survives, and
 *                  the event fires on EVERY write
 *
 * So the guard is a listener on the streams themselves. And it retires the
 * console transport as well, because that second row is the other half: a
 * broken pipe does not heal, and without retiring it every later log line
 * pays for the same failure. `level = false` is how electron-log skips a
 * transport (`core/Logger.js`: `transFn.level === false`).
 *
 * The listener covers every writer to those streams, not only electron-log —
 * any stray `console.*` in the main process would have hit the same pipe.
 */

/** What this needs from `log.transports.console`. Structural rather than
 *  imported, so the tests need neither electron-log nor Electron. */
type RetirableTransport = { level: unknown };

/** What this needs from `process.stdout` / `process.stderr`. */
type ErrorEmittingStream = {
  on(event: "error", listener: (error: Error) => void): unknown;
};

/**
 * Keep an error on any of `streams` from being fatal, and retire the console
 * transport the first time one happens.
 *
 * Both streams, because electron-log's console transport sends `warn` and
 * `error` through `console.warn` / `console.error` — stderr — and the rest to
 * stdout. Guarding one would leave the app to die on the first warning.
 *
 * `onRetire` runs once, after the transport is already retired. That order is
 * the point: a line logged from it cannot reach the dead console, only the
 * file transport, which is the log a user attaches to a bug report. It is the
 * only record that console output stopped.
 */
export function retireConsoleOnStreamError(
  transport: RetirableTransport,
  streams: ErrorEmittingStream[],
  onRetire?: (error: Error) => void,
): void {
  let retired = false;
  for (const stream of streams) {
    stream.on("error", (error) => {
      transport.level = false;
      if (retired) return;
      retired = true;
      onRetire?.(error);
    });
  }
}
