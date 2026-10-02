/**
 * Child process for `log-console-safety.test.ts`: writes to a stdout pipe the
 * parent has already closed, and records how the failure arrived.
 *
 * Deliberately a real process on a real pipe. The first version of the guard
 * was tested by throwing from a fake `writeFn`, which is not how EPIPE is
 * delivered, so the tests passed against a fix that could not work.
 *
 * `guarded` installs the real `retireConsoleOnStreamError`; `unguarded` does
 * not, and is the control that shows this child really does hit the failure.
 */
import { appendFileSync } from "node:fs";

import { retireConsoleOnStreamError } from "../log-console-safety";

const [, , report, mode] = process.argv;
const note = (line: string) => appendFileSync(report!, `${line}\n`);

process.on("uncaughtException", (error) => {
  note(`uncaught ${(error as NodeJS.ErrnoException).code ?? error.message}`);
  process.exit(3);
});

// Stands in for `log.transports.console`: electron-log skips a transport whose
// level is `false`, and so does the loop below.
const transport: { level: unknown } = { level: "debug" };

if (mode === "guarded") {
  retireConsoleOnStreamError(
    transport,
    [process.stdout, process.stderr],
    (error) => note(`retired ${(error as NodeJS.ErrnoException).code}`),
  );
}

let lines = 0;
const writeNext = () => {
  if (transport.level !== false) {
    console.info(`line ${lines} ${"x".repeat(2000)}`);
  }
  if (++lines < 100) {
    setTimeout(writeNext, 2);
  } else {
    note(`finished level=${String(transport.level)}`);
    process.exit(0);
  }
};

// Let the parent close its end of the pipe before the first write.
setTimeout(writeNext, 300);
