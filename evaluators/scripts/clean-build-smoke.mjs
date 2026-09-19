/** Build and consume a source-only copy: no worktree dist can mask missing prerequisites. */
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "evaluators-clean-"));
try {
  for (const file of ["src", "package.json", "tsconfig.json", "tsup.config.ts"])
    cpSync(join(root, file), join(temp, file), { recursive: true });
  symlinkSync(
    resolve(root, "../node_modules"),
    join(temp, "node_modules"),
    "dir",
  );
  if (existsSync(join(temp, "dist")))
    throw new Error("Clean build started with stale artifacts");
  execFileSync("npm", ["run", "build"], {
    cwd: temp,
    stdio: "pipe",
    env: process.env,
  });
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    const { evaluatePredicates } = await import('./dist/index.js');
    const results = evaluatePredicates({toolCalls:[],finalAssistantMessage:'hello'}, [{type:'responseContains',needle:'hello'}]);
    if (!results[0]?.passed) throw new Error('Clean package consumer failed');
  `,
    ],
    { cwd: temp, stdio: "inherit" },
  );
  console.log("Source-only evaluator build and consumer passed");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
