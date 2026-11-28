/**
 * Credit blocks on a fan-out: every target MCPJam credits refused or stopped
 * gets its own resume command, the one step is printed once, and the exit code
 * is 6 unless something else failed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { CreditRecovery } from "@mcpjam/sdk/contract";
import type { PlatformEvalRun, RunEvalSuiteResult } from "@mcpjam/sdk/platform";
import {
  creditBlocksJsonFields,
  launchCreditExitCode,
  readRunCreditStops,
  refusedLaunchCreditBlock,
  refusedTargetCreditBlocks,
  stoppedRunCreditBlock,
  writeCreditBlocks,
  type CreditBlock,
} from "../src/lib/eval-credit-blocks.js";

const RECOVERY: CreditRecovery = {
  version: 1,
  reason: "allowance_exhausted",
  action: "upgrade_plan",
  actor: "caller",
  url: "https://app.mcpjam.com/billing",
  plan: "pro",
};

function receipt(
  targets: RunEvalSuiteResult["targets"],
  extra: Partial<RunEvalSuiteResult> = {},
): RunEvalSuiteResult {
  const failedCount = targets.filter((t) => t.status === "failed").length;
  return {
    project: { id: "p1", name: "Acme", organizationId: "o1" },
    suite: { id: "s1", name: "Smoke" },
    outcome: failedCount === targets.length ? "failed" : "partial",
    startedCount: targets.length - failedCount,
    failedCount,
    targets,
    ...extra,
  };
}

function stoppedRun(id: string, envId: string): PlatformEvalRun {
  const run: Partial<PlatformEvalRun> = {
    id,
    suiteId: "s1",
    status: "failed",
    result: null,
    environment: { id: envId, name: "Prod", revision: 2 },
  };
  return run as PlatformEvalRun;
}

function capture(): { text: () => string; write: (chunk: string) => boolean } {
  let out = "";
  return {
    text: () => out,
    write: (chunk: string) => {
      out += chunk;
      return true;
    },
  };
}

test("refused targets share one replay of the receipt's targets under its group key", () => {
  const blocks = refusedTargetCreditBlocks(
    receipt(
      [
        {
          status: "started",
          runId: "run_1",
          runStatus: "running",
          environment: { id: "env_stg", name: "Staging", revision: 1 },
        },
        {
          status: "failed",
          environment: { id: "env_prod", name: "Prod", revision: null },
          error: { code: "FORBIDDEN", message: "Out", recovery: RECOVERY },
        },
      ],
      { idempotencyKey: "k1" },
    ),
    { file: "suite.json", allTargets: true, iterations: 2, wait: true },
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.target, "Prod (env_prod)");
  assert.equal(
    blocks[0]!.resumeCommand,
    "mcpjam cloud eval run --file suite.json --project p1 --environment env_stg --environment env_prod --iterations 2 --wait --idempotency-key k1 --resume",
  );
});

test("a --file - fan-out replays on its suite with the receipt's targets", () => {
  const blocks = refusedTargetCreditBlocks(
    receipt(
      [
        {
          status: "started",
          runId: "run_1",
          runStatus: "running",
          host: { id: "h1", name: "Claude" },
        },
        {
          status: "failed",
          host: { id: "h2", name: "GPT" },
          error: { code: "FORBIDDEN", message: "Out", recovery: RECOVERY },
        },
        {
          status: "failed",
          host: { id: "h3", name: "Gemini" },
          error: { code: "FORBIDDEN", message: "Out", recovery: RECOVERY },
        },
      ],
      { idempotencyKey: "minted" },
    ),
    { file: "-" },
  );
  assert.equal(blocks.length, 2);
  const command =
    "mcpjam cloud eval run --suite s1 --project p1 --client h1 --client h2 --client h3 --idempotency-key minted --resume";
  assert.deepEqual(
    blocks.map((block) => block.resumeCommand),
    [command, command],
  );
  const out = capture();
  writeCreditBlocks("human", blocks, false, out);
  assert.equal(
    out.text(),
    [
      "Recovery: Upgrade to Pro to keep going: https://app.mcpjam.com/billing",
      `Resume: ${command}`,
      "",
    ].join("\n"),
  );
});

test("a refused solo --file - launch names its suite, or says to pipe again", () => {
  const known = refusedLaunchCreditBlock(
    { idempotencyKey: "k1", suiteId: "suite_7" },
    RECOVERY,
    { file: "-" },
  );
  assert.equal(
    known.resumeCommand,
    "mcpjam cloud eval run --suite suite_7 --idempotency-key k1 --resume",
  );
  assert.equal(known.pipeAgain, undefined);
  const unknown = refusedLaunchCreditBlock({}, RECOVERY, { file: "-" });
  assert.equal(unknown.pipeAgain, true);
  const out = capture();
  writeCreditBlocks("human", [unknown], false, out);
  assert.match(out.text(), /Pipe the same suite file to it again/);
});

test("a suite launched by name replays on the project and suite it resolved", () => {
  const blocks = refusedTargetCreditBlocks(
    receipt(
      [
        {
          status: "started",
          runId: "run_1",
          runStatus: "running",
          host: { id: "h1", name: "Claude" },
        },
        {
          status: "failed",
          host: { id: "h2", name: "GPT" },
          error: { code: "FORBIDDEN", message: "Out", recovery: RECOVERY },
        },
      ],
      { idempotencyKey: "k1" },
    ),
    { suite: "Smoke", client: ["Claude", "GPT"] },
  );
  assert.equal(
    blocks[0]!.resumeCommand,
    "mcpjam cloud eval run --suite s1 --project p1 --client Claude --client GPT --idempotency-key k1 --resume",
  );
});

test("an approved --file - fan-out replays from the file, piped again", () => {
  const blocks = refusedTargetCreditBlocks(
    receipt(
      [
        {
          status: "started",
          runId: "run_1",
          runStatus: "running",
          host: { id: "h1", name: "Claude" },
        },
        {
          status: "failed",
          host: { id: "h2", name: "GPT" },
          error: { code: "FORBIDDEN", message: "Out", recovery: RECOVERY },
        },
      ],
      { idempotencyKey: "k1" },
    ),
    {
      file: "-",
      allowApproximated: ["refund"],
      approvalReason: "Known gap",
    },
  );
  assert.equal(
    blocks[0]!.resumeCommand,
    "mcpjam cloud eval run --file - --project p1 --client h1 --client h2 --allow-approximated refund --approval-reason 'Known gap' --idempotency-key k1 --resume",
  );
  assert.equal(blocks[0]!.pipeAgain, true);
});

test("a refused solo launch replays on the project and suite in its details", () => {
  const block = refusedLaunchCreditBlock(
    {
      idempotencyKey: "k1",
      resume: {
        tool: "run_eval_suite",
        arguments: { project: "proj_1", suite: "suite_1" },
      },
    },
    RECOVERY,
    { suite: "Smoke", project: "Acme" },
  );
  assert.equal(
    block.resumeCommand,
    "mcpjam cloud eval run --suite suite_1 --project proj_1 --idempotency-key k1 --resume",
  );
});

test("a refused target with a wait, or another failure, is not a block", () => {
  const blocks = refusedTargetCreditBlocks(
    receipt([
      {
        status: "failed",
        host: { id: "h1", name: "Claude" },
        error: {
          code: "FORBIDDEN",
          message: "Out",
          recovery: { ...RECOVERY, action: "wait" },
        },
      },
      {
        status: "failed",
        host: { id: "h2", name: "GPT" },
        error: { code: "VALIDATION_ERROR", message: "no servers" },
      },
    ]),
    { suite: "s1", allTargets: true },
  );
  assert.deepEqual(blocks, []);
});

test("one step printed once, then a labelled resume per blocked target", () => {
  const refused: CreditBlock = {
    target: "Staging (env_stg)",
    recovery: RECOVERY,
    resumeCommand:
      "mcpjam cloud eval run --suite s1 --environment env_stg --resume",
  };
  const stopped = stoppedRunCreditBlock(
    {
      run: stoppedRun("run_2", "env_prod"),
      recovery: RECOVERY,
      incompleteCases: {
        cases: [
          { testCaseId: "c1", title: "Refund flow" },
          { testCaseId: "c2", title: "Login" },
        ],
        truncated: false,
      },
    },
    { suite: "Smoke", allTargets: true },
  );
  const out = capture();
  writeCreditBlocks("human", [refused, stopped], false, out);
  assert.equal(
    out.text(),
    [
      "Recovery: Upgrade to Pro to keep going: https://app.mcpjam.com/billing",
      "Resume Staging (env_stg): mcpjam cloud eval run --suite s1 --environment env_stg --resume",
      "Resume Prod (run run_2): mcpjam cloud eval run --suite s1 --resume --resume-from run_2",
      'Incomplete (the resume reruns these): "Refund flow", "Login"',
      "",
    ].join("\n"),
  );
});

test("under --resume it says still blocked and prints no command", () => {
  const out = capture();
  writeCreditBlocks(
    "human",
    [{ target: "", recovery: RECOVERY, resumeCommand: "x" }],
    true,
    out,
  );
  assert.equal(
    out.text(),
    "Still blocked: Upgrade to Pro to keep going: https://app.mcpjam.com/billing\n",
  );
});

test("JSON: a solo block stays top-level, a fan-out lists every target", () => {
  const block: CreditBlock = {
    target: "Prod (env_prod)",
    recovery: RECOVERY,
    resumeCommand: "cmd",
  };
  assert.deepEqual(creditBlocksJsonFields([block], false, true), {
    resumeCommand: "cmd",
  });
  assert.deepEqual(creditBlocksJsonFields([block], true, false), {
    creditBlocks: [
      {
        target: "Prod (env_prod)",
        creditRecovery: RECOVERY,
        stillBlocked: true,
      },
    ],
  });
  assert.deepEqual(creditBlocksJsonFields([], false, false), {});
});

test("a launch that did not wait: a block outranks a setup failure beside it", () => {
  const block: CreditBlock = {
    target: "t",
    recovery: RECOVERY,
    resumeCommand: "c",
  };
  assert.equal(launchCreditExitCode({ failedCount: 1 }, [block]), 6);
  // The other target failed to launch: a setup failure (4), not a verdict.
  assert.equal(launchCreditExitCode({ failedCount: 2 }, [block]), 6);
  assert.equal(launchCreditExitCode({ failedCount: 1 }, []), 1);
  assert.equal(launchCreditExitCode({ failedCount: 0 }, []), 0);
});

test("reads each run's stop from its record and lists its unfinished cases", async () => {
  const blocked = { ...stoppedRun("run_1", "env_a"), creditRecovery: RECOVERY };
  const clean: PlatformEvalRun = {
    ...stoppedRun("run_2", "env_b"),
    status: "completed",
  };
  const reads: string[] = [];
  const stops = await readRunCreditStops(
    {
      listEvalRunIterations: async ({ runId }) => {
        reads.push(runId);
        return { items: [] };
      },
    },
    undefined,
    "p1",
    [blocked, clean],
    new Map([
      [
        "run_1",
        {
          iterations: [
            { testCaseId: "c0", title: "Search", status: "completed" },
            { testCaseId: "c1", title: "Refund flow", status: "skipped" },
          ],
          complete: true,
        },
      ],
    ]),
  );
  assert.equal(stops.length, 1);
  assert.equal(stops[0]!.run.id, "run_1");
  assert.deepEqual(stops[0]!.incompleteCases, {
    cases: [{ testCaseId: "c1", title: "Refund flow" }],
    truncated: false,
  });
  assert.deepEqual(reads, []);
});
