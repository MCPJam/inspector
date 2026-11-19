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
  isCreditBlock,
  resumeSourceOfRun,
  shellQuoteArg,
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
// isCreditBlock
// ---------------------------------------------------------------------------

test("isCreditBlock: a person-must-act action is a block", () => {
  for (const action of [
    "upgrade_plan",
    "buy_credits",
    "ask_admin",
    "raise_budget",
    "contact_support",
  ] as const) {
    assert.equal(isCreditBlock(recovery({ action })), true);
  }
});

test("isCreditBlock: wait is NOT a block (never steer toward waiting)", () => {
  assert.equal(isCreditBlock(recovery({ action: "wait" })), false);
});

test("isCreditBlock: no recovery is not a block", () => {
  assert.equal(isCreditBlock(undefined), false);
});

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
  assert.equal(shellQuoteArg("it's"), "'it'\\''s'");
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

test("buildResumeCommand: stopped run drops --case and --all-targets", () => {
  // The server picks a resume's cases (it refuses caseIds beside a resume),
  // and a resume reruns one run, so neither selector may be re-emitted.
  const command = buildResumeCommand(
    {
      suite: "s1",
      project: "p1",
      case: ["checkout", "refund"],
      environment: ["env_1"],
      allTargets: true,
      iterations: 3,
    },
    { sourceRunId: "run_9" },
  );
  assert.equal(
    command,
    "mcpjam cloud eval run --suite s1 --project p1 --environment env_1 --iterations 3 --resume --resume-from run_9",
  );
  for (const flag of ["--case", "--all-targets"]) {
    assert.ok(!command.includes(flag), `${flag} must be dropped`);
  }
});

test("buildResumeCommand: stopped run resumes on the source run's suite and environment", () => {
  // A suite with several environments refuses a launch that names none, so
  // the resume names the one the stopped run actually ran on.
  const command = buildResumeCommand(
    {
      file: "-",
      project: "p1",
      environment: ["staging"],
      composeModel: ["gpt-5"],
    },
    {
      sourceRunId: "run_9",
      source: { suiteId: "suite_7", environmentId: "env_42" },
    },
  );
  assert.equal(
    command,
    "mcpjam cloud eval run --suite suite_7 --project p1 --environment env_42 --resume --resume-from run_9",
  );
});

test("buildResumeCommand: stopped run on an attached host resumes on that host", () => {
  const command = buildResumeCommand(
    { suite: "s1", project: "p1" },
    { sourceRunId: "run_9", source: { suiteId: "s1", hostId: "host_3" } },
  );
  assert.ok(command.includes("--client host_3"));
  assert.ok(!command.includes("--environment"));
});

test("resumeSourceOfRun: reads the suite and the run's own target", () => {
  assert.deepEqual(
    resumeSourceOfRun({
      suiteId: "s1",
      environment: { id: "env_1" },
      client: { id: "host_1", source: "environment" },
    }),
    { suiteId: "s1", environmentId: "env_1" },
  );
  assert.deepEqual(
    resumeSourceOfRun({
      suiteId: "s1",
      environment: null,
      client: { id: "host_1", source: "attached_host" },
    }),
    { suiteId: "s1", hostId: "host_1" },
  );
  // A suite-default client is not a selectable target; omit it.
  assert.deepEqual(
    resumeSourceOfRun({
      suiteId: "s1",
      client: { id: "host_1", source: "suite_default" },
    }),
    { suiteId: "s1" },
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

test("idempotencyKeyOfErrorDetails: extracts a string key, else undefined", () => {
  assert.equal(
    idempotencyKeyOfErrorDetails({ idempotencyKey: "key-1" }),
    "key-1",
  );
  assert.equal(idempotencyKeyOfErrorDetails({ idempotencyKey: 7 }), undefined);
  assert.equal(idempotencyKeyOfErrorDetails(undefined), undefined);
});
