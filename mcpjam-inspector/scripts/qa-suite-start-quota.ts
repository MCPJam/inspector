/** Run only against the personal dev fixture in the companion backend worktree. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { retrySuiteStartOnConflict } from "../server/services/evals/suite-start-retry.js";

const exec = promisify(execFile);
const backend = resolve(process.argv[2]);
const deployment = "exuberant-albatross-496";
const cli = resolve(backend, "node_modules/convex/bin/main.js");
async function command(args: string[]) {
  return await exec(
    process.execPath,
    [cli, ...args, "--deployment", deployment],
    {
      cwd: backend,
      maxBuffer: 1024 * 1024,
    },
  );
}
async function run(name: string, args: object) {
  const { stdout } = await command([
    "run",
    `qaSuiteStartQuota:${name}`,
    JSON.stringify(args),
  ]);
  return JSON.parse(stdout);
}

// Refuse to change an existing setting; this test restores the original absence.
const original = await command(["env", "get", "EVAL_ITERATION_LIMIT_ENFORCED"]);
assert.match(original.stderr, /not found/);
const billing = await command(["env", "get", "BILLING_GATING_ENABLED"]);
assert.equal(billing.stdout.trim(), "1");
await command(["env", "set", "EVAL_ITERATION_LIMIT_ENFORCED", "1"]);
try {
  for (const iterations of [100, 115, 200]) {
    const suiteId = await run("seed", {});
    let report: unknown;
    try {
      const requests = Array.from({ length: 5 }, (_, i) => ({
        suiteId,
        key: `client-${i}`,
        iterations,
      }));
      const results = await Promise.allSettled(
        requests.map((args) =>
          retrySuiteStartOnConflict(() => run("reserve", args)),
        ),
      );
      const accepted = results.filter((r) => r.status === "fulfilled");
      assert.equal(accepted.length, iterations <= 115 ? 5 : 2);
      for (const result of results) {
        if (result.status === "rejected")
          assert.match(
            String(result.reason),
            /billing_limit_reached|Eval iteration limit reached/,
          );
      }
      // Replay successful keys concurrently: they must neither reserve twice nor create new receipts.
      await Promise.all(
        results.map(async (result, i) => {
          if (result.status === "fulfilled")
            assert.equal(
              await retrySuiteStartOnConflict(() =>
                run("reserve", requests[i]),
              ),
              result.value,
            );
        }),
      );
    } finally {
      report = await retrySuiteStartOnConflict(() =>
        run("finish", { suiteId }),
      );
    }
    assert.deepEqual(report, {
      runs: iterations <= 115 ? 5 : 2,
      reserved: iterations <= 115 ? iterations * 5 : 400,
      starterUsed: iterations <= 115 ? 500 : 400,
      windowUsed: iterations === 115 ? 75 : 0,
    });
    process.stdout.write(
      JSON.stringify({
        clients: 5,
        iterationsPerClient: iterations,
        ...(report as object),
      }) + "\n",
    );
  }
} finally {
  await command(["env", "remove", "EVAL_ITERATION_LIMIT_ENFORCED"]);
}
