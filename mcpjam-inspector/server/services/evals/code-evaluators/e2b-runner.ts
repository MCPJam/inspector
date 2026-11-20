/**
 * Runs code evaluators in one E2B sandbox per run, with internet access off.
 * Each trial gets its own working directory and a hard timeout; the sandbox
 * dies with its TTL if this process does.
 */
import { Sandbox, TimeoutError } from "e2b";
import { logger } from "../../../utils/logger.js";
import {
  CODE_EVALUATOR_TIMEOUT_MS,
  HARNESS_SCRIPT,
  parseHarnessOutput,
} from "./harness.js";
import type { CodeEvaluatorRunner } from "./types.js";

/** Long enough for a run's trials; E2B reaps the box after this. */
const SANDBOX_TTL_MS = 30 * 60_000;

export function createE2bCodeEvaluatorRunner(apiKey: string): CodeEvaluatorRunner {
  let sandbox: Promise<Sandbox> | null = null;
  let trial = 0;
  const box = () => {
    sandbox ??= Sandbox.create({
      apiKey,
      timeoutMs: SANDBOX_TTL_MS,
      allowInternetAccess: false,
    });
    return sandbox;
  };
  return {
    kind: "e2b",
    async run({ module, runJson }) {
      let instance: Sandbox;
      try {
        instance = await box();
      } catch (error) {
        sandbox = null;
        return {
          status: "error",
          reason: `The sandbox could not start: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const dir = `/tmp/code-eval-${(trial += 1)}`;
      try {
        await instance.files.write([
          { path: `${dir}/evaluator.mjs`, data: module },
          { path: `${dir}/run.json`, data: runJson },
          { path: `${dir}/harness.mjs`, data: HARNESS_SCRIPT },
        ]);
        const result = await instance.commands.run("node harness.mjs", {
          cwd: dir,
          timeoutMs: CODE_EVALUATOR_TIMEOUT_MS,
        });
        return parseHarnessOutput(result.stdout ?? "");
      } catch (error) {
        if (error instanceof TimeoutError) {
          return {
            status: "error",
            reason: `Stopped after ${CODE_EVALUATOR_TIMEOUT_MS / 1000} seconds.`,
          };
        }
        const stdout = (error as { stdout?: unknown }).stdout;
        if (typeof stdout === "string" && stdout) return parseHarnessOutput(stdout);
        return {
          status: "error",
          reason: `The sandbox failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
    async close() {
      const pending = sandbox;
      sandbox = null;
      if (!pending) return;
      try {
        await (await pending).kill();
      } catch (error) {
        logger.warn("[code-evaluators] sandbox kill failed (E2B TTL will reap it)", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
