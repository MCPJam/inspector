// Runs a Vitest command and reruns it ONCE when the only thing wrong was a
// crashed pool worker: every test file and every test passed, and every
// unhandled error Vitest counted is "[vitest-pool]: Worker ... emitted error"
// caused by "Worker exited unexpectedly". Anything else, a failed test, a file
// that failed to load, any other unhandled error, or no summary at all, is
// returned as is. A real failure is never retried.
//
//   node .github/scripts/retry-worker-crash.mjs npm run test -w @mcpjam/inspector -- --shard=3/6
//
// A crashed worker can take an unfinished file with it without Vitest counting
// that file as failed, so the rerun is of the whole command, not of the files
// Vitest reported.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// The summary and the unhandled-error report are at the end of the output.
const TAIL_CHARS = 1_000_000;

const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

/** Whether `output` shows a Vitest run whose only failure was a crashed worker. */
export function isWorkerCrashOnly(output) {
  const text = stripAnsi(output);
  const summaryAt = text.lastIndexOf(" Test Files ");
  if (summaryAt === -1) return false;
  const summary = text.slice(summaryAt);
  const line = (label) =>
    new RegExp(`^\\s*${label}\\s+(.*)$`, "m").exec(summary)?.[1] ?? null;
  const files = line("Test Files");
  const tests = line("Tests");
  const errors = line("Errors");
  if (files === null || tests === null || errors === null) return false;
  if (/\bfailed\b/.test(files) || /\bfailed\b/.test(tests)) return false;
  const errorCount = Number(/^(\d+) errors?\b/.exec(errors)?.[1] ?? NaN);
  const report = text.slice(0, summaryAt);
  const count = (pattern) => report.match(pattern)?.length ?? 0;
  const poolErrors = count(/\[vitest-pool\]: Worker \S+ emitted error\./g);
  const exits = count(/Caused by: Error: Worker exited unexpectedly/g);
  return errorCount > 0 && poolErrors === errorCount && exits === errorCount;
}

/** What the container's memory cgroup recorded, for telling an OOM kill apart. */
export function memoryReport(read = (path) => readFileSync(path, "utf8")) {
  const parts = [];
  try {
    const kills = /^oom_kill (\d+)$/m.exec(read("/sys/fs/cgroup/memory.events"))?.[1];
    if (kills !== undefined) parts.push(`oom_kill=${kills}`);
  } catch {
    parts.push("memory.events unreadable");
  }
  try {
    const peak = Number(read("/sys/fs/cgroup/memory.peak").trim());
    parts.push(`memory.peak=${Math.round(peak / 2 ** 20)} MiB`);
  } catch {
    parts.push("memory.peak unreadable");
  }
  return parts.join(", ");
}

function runOnce(command, args) {
  return new Promise((resolve) => {
    let tail = "";
    const child = spawn(command, args, { stdio: ["inherit", "pipe", "pipe"] });
    const capture = (sink) => (chunk) => {
      sink.write(chunk);
      tail = (tail + chunk.toString("utf8")).slice(-TAIL_CHARS);
    };
    child.stdout.on("data", capture(process.stdout));
    child.stderr.on("data", capture(process.stderr));
    child.on("error", (error) => {
      process.stderr.write(`Could not start ${command}: ${error.message}\n`);
      resolve({ code: 1, output: tail });
    });
    child.on("close", (code, signal) => {
      resolve({ code: code ?? (signal ? 1 : 0), output: tail });
    });
  });
}

export async function main(argv) {
  const [command, ...args] = argv;
  if (!command) {
    process.stderr.write("usage: retry-worker-crash.mjs <command> [args...]\n");
    return 2;
  }
  const first = await runOnce(command, args);
  console.log(`Memory after the run: ${memoryReport()}`);
  if (first.code === 0) return 0;
  if (!isWorkerCrashOnly(first.output)) return first.code;
  console.log(
    "::warning::A Vitest worker exited unexpectedly and nothing else failed. Rerunning once.",
  );
  const second = await runOnce(command, args);
  console.log(`Memory after the rerun: ${memoryReport()}`);
  return second.code;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
