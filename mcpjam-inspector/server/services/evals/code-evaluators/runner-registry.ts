/**
 * One code-evaluator runner per run, created on first use and closed after
 * the run goes quiet, so trials share a sandbox without the runner having to
 * find the run's end.
 *
 * E2B when `E2B_API_KEY` is set. The local runner, which is NOT a sandbox,
 * only when `MCPJAM_CODE_EVALUATOR_RUNNER=local` outside production. With
 * neither, code evaluators report an error row instead of running.
 */
import { createE2bCodeEvaluatorRunner } from "./e2b-runner.js";
import { createLocalCodeEvaluatorRunner } from "./local-runner.js";
import type { CodeEvaluatorRunner } from "./types.js";

const IDLE_CLOSE_MS = 2 * 60_000;

type Entry = { runner: CodeEvaluatorRunner; timer: ReturnType<typeof setTimeout> | null };
const byRun = new Map<string, Entry>();

export function createCodeEvaluatorRunner(
  env: NodeJS.ProcessEnv = process.env,
): CodeEvaluatorRunner | null {
  if (env.E2B_API_KEY) return createE2bCodeEvaluatorRunner(env.E2B_API_KEY);
  if (env.MCPJAM_CODE_EVALUATOR_RUNNER === "local" && env.NODE_ENV !== "production") {
    return createLocalCodeEvaluatorRunner();
  }
  return null;
}

/** The run's runner, or null where this server has none. */
export function codeEvaluatorRunnerFor(runKey: string): CodeEvaluatorRunner | null {
  let entry = byRun.get(runKey);
  if (!entry) {
    const runner = createCodeEvaluatorRunner();
    if (!runner) return null;
    entry = { runner, timer: null };
    byRun.set(runKey, entry);
  }
  if (entry.timer) clearTimeout(entry.timer);
  const current = entry;
  current.timer = setTimeout(() => {
    byRun.delete(runKey);
    void current.runner.close();
  }, IDLE_CLOSE_MS);
  current.timer.unref?.();
  return current.runner;
}
