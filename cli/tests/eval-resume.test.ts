/**
 * The resume-command reconstruction and credit-block classification behind
 * `mcpjam cloud eval run`'s exit 6. KES-941's product rules bind here: a block
 * gives ONE action (the recovery sentence the SDK renders) and ONE resume
 * command, never "wait" and never BYOK, and the command never carries a secret.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { CreditRecovery } from "@mcpjam/sdk/contract";
import {
  buildResumeCommand,
  creditRecoveryOfCliError,
  idempotencyKeyOfErrorDetails,
  resumeReadsStdin,
  shellQuoteArg,
  suiteIdOfErrorDetails,
} from "../src/lib/eval-resume.js";

function recovery(overrides: Partial<CreditRecovery> = {}): CreditRecovery {
  return {
    version: 1,
    reason: "out of MCPJam credits",
    action: "upgrade_plan",
    actor: "caller",
    url: "https://app.mcpjam.com/billing",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// shellQuoteArg
// ---------------------------------------------------------------------------

test("shellQuoteArg: a plain token is emitted bare", () => {
  assert.equal(shellQuoteArg("suite_123"), "suite_123");
  assert.equal(shellQuoteArg("--resume"), "--resume");
});

test("shellQuoteArg: spaces and JSON are single-quoted, quotes escaped", () => {
  assert.equal(shellQuoteArg("my suite"), "'my suite'");
  assert.equal(
    shellQuoteArg('{"toolCallOrder":"exact"}'),
    `'{"toolCallOrder":"exact"}'`,
  );
  assert.equal(shellQuoteArg("it's $HOME"), "'it'\\''s $HOME'");
});

test("shellQuoteArg: an apostrophe, a comma and an @ parse in PowerShell too", () => {
  // PowerShell rejects the POSIX '\'' escape, and reads a bare `a,b` as an
  // array and a leading `@` as splatting.
  assert.equal(shellQuoteArg("Sam's report"), `"Sam's report"`);
  assert.equal(shellQuoteArg("a,b"), "'a,b'");
  assert.equal(shellQuoteArg("@team"), "'@team'");
});

// ---------------------------------------------------------------------------
// buildResumeCommand
// ---------------------------------------------------------------------------

test("buildResumeCommand: refused launch reuses the key and adds --resume", () => {
  const command = buildResumeCommand({
    suite: "s1",
    project: "p1",
    idempotencyKey: "key-123",
  });
  assert.equal(
    command,
    "mcpjam cloud eval run --suite s1 --project p1 --idempotency-key key-123 --resume",
  );
});

test("buildResumeCommand: a passed idempotency key override wins", () => {
  const command = buildResumeCommand(
    { suite: "s1", project: "p1" },
    { idempotencyKey: "minted-9" },
  );
  assert.ok(command.includes("--idempotency-key minted-9"));
  assert.ok(command.endsWith("--resume"));
});

test("buildResumeCommand: stopped run uses --resume-from and drops the key", () => {
  const command = buildResumeCommand(
    { suite: "s1", project: "p1", idempotencyKey: "key-123" },
    { sourceRunId: "run_9" },
  );
  assert.equal(
    command,
    "mcpjam cloud eval run --suite s1 --project p1 --resume --resume-from run_9",
  );
  assert.ok(!command.includes("--idempotency-key"));
});

test("buildResumeCommand: a refused resume replays as that resume", () => {
  const command = buildResumeCommand(
    {
      suite: "suite-1",
      project: "p1",
      server: ["srv"],
      case: ["enabled-case"],
      resumeFrom: "run-original",
    },
    { idempotencyKey: "launch-1" },
  );
  assert.equal(
    command,
    "mcpjam cloud eval run --suite suite-1 --project p1 --idempotency-key launch-1 --resume --resume-from run-original",
  );
});

test("buildResumeCommand: a refused --file - resume names no stdin cases", () => {
  const command = buildResumeCommand(
    {
      file: "-",
      project: "Alpha",
      case: ["row_c_refund"],
      resumeFrom: "run-original",
    },
    { idempotencyKey: "launch-1", suiteId: "suite-file-1" },
  );
  assert.equal(
    command,
    "mcpjam cloud eval run --suite suite-file-1 --project Alpha --idempotency-key launch-1 --resume --resume-from run-original",
  );
});

test("buildResumeCommand: stopped run names no target, case or fan-out", () => {
  // The server picks a resume's cases (it refuses caseIds beside a resume)
  // and runs it on the source run's own target, so no selector is re-emitted.
  const command = buildResumeCommand(
    {
      suite: "s1",
      project: "p1",
      case: ["checkout", "refund"],
      environment: ["env_1"],
      client: ["host_1"],
      server: ["srv_1"],
      allTargets: true,
      iterations: 3,
      wait: true,
    },
    { sourceRunId: "run_9", suiteId: "s1" },
  );
  assert.equal(
    command,
    "mcpjam cloud eval run --suite s1 --project p1 --iterations 3 --wait --resume --resume-from run_9",
  );
});

test("buildResumeCommand: stopped composed run resumes on its suite by id", () => {
  // A composed environment is not attached, so naming it would be refused;
  // the resume names only the suite and the backend inherits the target.
  const command = buildResumeCommand(
    {
      file: "-",
      project: "p1",
      composeClient: "claude",
      composeModel: ["gpt-5"],
    },
    { sourceRunId: "run_9", suiteId: "suite_7" },
  );
  assert.equal(
    command,
    "mcpjam cloud eval run --suite suite_7 --project p1 --resume --resume-from run_9",
  );
});

test("buildResumeCommand: a refused --file - launch names its suite by id", () => {
  const command = buildResumeCommand(
    { file: "-", project: "p1", case: ["c1"] },
    { idempotencyKey: "k1", suiteId: "suite_7" },
  );
  assert.equal(
    command,
    "mcpjam cloud eval run --suite suite_7 --project p1 --case c1 --idempotency-key k1 --resume",
  );
  assert.equal(resumeReadsStdin({ file: "-" }, "suite_7"), false);
  assert.equal(resumeReadsStdin({ file: "-" }, undefined), true);
  assert.equal(resumeReadsStdin({ file: "a.yaml" }, undefined), false);
  // Approvals name the file's authored cases, so only the file replays them.
  assert.equal(
    resumeReadsStdin({ file: "-", allowApproximated: ["c1"] }, "suite_7"),
    true,
  );
});

test("buildResumeCommand: an approved --file - launch replays from the file", () => {
  const command = buildResumeCommand(
    {
      file: "-",
      allowApproximated: ["refund"],
      approvalReason: "Known gap",
    },
    { idempotencyKey: "k1", suiteId: "suite_7", projectId: "proj_1" },
  );
  assert.equal(
    command,
    "mcpjam cloud eval run --file - --project proj_1 --allow-approximated refund --approval-reason 'Known gap' --idempotency-key k1 --resume",
  );
});

test("buildResumeCommand: --host folds into --client, repetitions into --iterations", () => {
  const command = buildResumeCommand({
    suite: "s1",
    host: ["claude"],
    client: ["gpt"],
    repetitions: 3,
  });
  assert.ok(command.includes("--client gpt"));
  assert.ok(command.includes("--client claude"));
  assert.ok(command.includes("--iterations 3"));
  assert.ok(!command.includes("--host"));
  assert.ok(!command.includes("--repetitions"));
});

test("buildResumeCommand: arguments with spaces and JSON are quoted", () => {
  const command = buildResumeCommand({
    file: "suites/my suite.yaml",
    notes: "ran after top up",
    matchOptions: '{"toolCallOrder":"exact"}',
  });
  assert.ok(command.includes("--file 'suites/my suite.yaml'"));
  assert.ok(command.includes("--notes 'ran after top up'"));
  assert.ok(command.includes(`--match-options '{"toolCallOrder":"exact"}'`));
});

test("buildResumeCommand: never emits a credential flag", () => {
  const command = buildResumeCommand({
    suite: "s1",
    // Fields outside the reconstructed set are ignored, so a secret cannot leak.
    ...({ apiKey: "sk_secret" } as Record<string, unknown>),
  });
  assert.ok(!command.includes("sk_secret"));
  assert.ok(!command.includes("--api-key"));
});

// ---------------------------------------------------------------------------
// creditRecoveryOfCliError / idempotencyKeyOfErrorDetails
// ---------------------------------------------------------------------------

test("creditRecoveryOfCliError: reads the recovery from error details", () => {
  const error = {
    details: { reason: "PLATFORM_FEE_REQUIRED", recovery: recovery() },
  };
  const parsed = creditRecoveryOfCliError(error);
  assert.equal(parsed?.action, "upgrade_plan");
});

test("creditRecoveryOfCliError: undefined for an ordinary error", () => {
  assert.equal(
    creditRecoveryOfCliError({ details: { reason: "NOT_FOUND" } }),
    undefined,
  );
  assert.equal(creditRecoveryOfCliError(new Error("boom")), undefined);
});

test("suiteIdOfErrorDetails: extracts the written suite, else undefined", () => {
  assert.equal(suiteIdOfErrorDetails({ suiteId: "suite_7" }), "suite_7");
  assert.equal(suiteIdOfErrorDetails({}), undefined);
});

test("idempotencyKeyOfErrorDetails: extracts a string key, else undefined", () => {
  assert.equal(
    idempotencyKeyOfErrorDetails({ idempotencyKey: "key-1" }),
    "key-1",
  );
  assert.equal(idempotencyKeyOfErrorDetails({ idempotencyKey: 7 }), undefined);
  assert.equal(idempotencyKeyOfErrorDetails(undefined), undefined);
});
