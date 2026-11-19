/**
 * A TEST-ONLY runner: plain Node in a temporary directory on this machine.
 *
 * It is NOT a sandbox. The code can read files, use the network and see
 * whatever the child process can, so it exists only to exercise the whole
 * code-evaluator flow on a developer machine without an E2B key. It refuses
 * to start in production; see `runner-registry.ts`.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODE_EVALUATOR_LOG_CHARS,
  CODE_EVALUATOR_TIMEOUT_MS,
  HARNESS_SCRIPT,
  parseHarnessOutput,
} from "./harness.js";
import type { CodeEvaluatorRunner } from "./types.js";

export function createLocalCodeEvaluatorRunner(): CodeEvaluatorRunner {
  return {
    kind: "local",
    async run({ module, runJson }) {
      const dir = await mkdtemp(join(tmpdir(), "mcpjam-code-eval-"));
      try {
        await writeFile(join(dir, "evaluator.mjs"), module);
        await writeFile(join(dir, "run.json"), runJson);
        await writeFile(join(dir, "harness.mjs"), HARNESS_SCRIPT);
        return await new Promise((resolve) => {
          // An empty environment: no inherited secrets reach the child.
          const child = spawn(process.execPath, ["harness.mjs"], {
            cwd: dir,
            env: {},
          });
          let stdout = "";
          child.stdout.on("data", (chunk) => {
            if (stdout.length < CODE_EVALUATOR_LOG_CHARS * 2) stdout += chunk;
          });
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve({
              status: "error",
              reason: `Stopped after ${CODE_EVALUATOR_TIMEOUT_MS / 1000} seconds.`,
            });
          }, CODE_EVALUATOR_TIMEOUT_MS);
          child.on("close", () => {
            clearTimeout(timer);
            resolve(parseHarnessOutput(stdout));
          });
          child.on("error", (error) => {
            clearTimeout(timer);
            resolve({ status: "error", reason: `The runner failed: ${error.message}` });
          });
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    async close() {},
  };
}
