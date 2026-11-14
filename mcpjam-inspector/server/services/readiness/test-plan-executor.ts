/**
 * Running a directory test plan's calls, with the run's call ledger as the
 * record of what was sent.
 *
 * EVERY CALL IS RECORDED `started` BEFORE IT IS SENT, and again when its
 * answer comes back, so a worker that stops leaves behind which calls may
 * have reached the server. A resumed run reads that record first: a finished
 * call keeps its evidence, a read that never finished runs again, and a
 * write that never finished is marked ambiguous, never sent again.
 *
 * ORDER. Cases run in plan order. Reads run side by side up to the plan's
 * concurrency; a write, or a call that creates a fixture, waits for every
 * earlier call and runs alone, so a fixture exists before anything uses it
 * and destructive calls stay last.
 *
 * A LOST LEASE STOPS EVERYTHING: once one call meets it, nothing more is
 * sent and nothing more is written.
 */

import {
  classifyDirectoryTestCall,
  validateDirectoryTestPlan,
  directoryTestCaseDigest,
  resolveDirectoryTestArguments,
  resumeDirectoryTestCall,
  type DirectoryTestCallRecord,
  type DirectoryTestCase,
  type DirectoryTestPlan,
  type DirectoryTestPlanTool,
  type DirectoryToolCallEvidence,
  type DirectoryToolPlan,
  type SummarizeDirectoryToolTestsInput,
} from "@mcpjam/sdk";
import { logger } from "../../utils/logger.js";
import type {
  LedgerAnswer,
  LedgerCallWrite,
  LedgerCapturedValue,
} from "./call-ledger.js";
import { ReadinessRunCancelledError, isStopSignal } from "./runner.js";

/** The worker calling the server itself: never a run inside Claude or ChatGPT. */
const DIRECT_CALL = { kind: "direct-call" } as const;
const MAX_DETAIL_LENGTH = 500;
const LEDGER_DOWN =
  "MCPJam could not record a call in this run's ledger, so it stopped calling tools. Start a new run.";

export interface TestPlanCallRequest {
  tool: string;
  arguments: Record<string, unknown>;
  /** Dot paths to read from the result, for the fixtures the call creates. */
  capture: string[];
}

export interface ExecuteTestPlanInput {
  plan: DirectoryTestPlan;
  /** The tools the server lists now: each call's digest covers its schema. */
  tools: readonly DirectoryTestPlanTool[];
  /** The run's ledger as this execution found it. */
  ledger: readonly DirectoryTestCallRecord[];
  send(request: TestPlanCallRequest): Promise<DirectoryToolCallEvidence>;
  record(call: LedgerCallWrite): Promise<LedgerAnswer>;
  /** Aborted when the lease is lost or the run is cancelled. */
  signal?: AbortSignal;
  /** No case starts after this time, and no cleanup step after `cleanupBy`. */
  casesBy: number;
  cleanupBy: number;
  /** The server URL each call records. */
  endpoint?: string;
  /** The reviewer account each call records; none with no sign-in. */
  account?: string | null;
  /** Fixtures not in the reviewer's account: no case that uses one is sent. */
  missingFixtures?: readonly string[];
  now?: () => number;
}

export interface TestPlanExecution {
  /** The latest record of each case's call. */
  calls: DirectoryTestCallRecord[];
  /** The latest record of each cleanup call. */
  cleanup: DirectoryTestCallRecord[];
  stopped?: SummarizeDirectoryToolTestsInput["stopped"];
}

type Stop = NonNullable<TestPlanExecution["stopped"]>;
type FixtureValues = Map<string, Record<string, string | number>>;

/** One call the plan makes: a case, or a cleanup step dressed as one. */
interface PlannedCall {
  testCase: DirectoryTestCase;
  entry: DirectoryToolPlan;
}

export async function executeDirectoryTestPlan(
  input: ExecuteTestPlanInput,
): Promise<TestPlanExecution> {
  const { plan, signal } = input;
  if (validateDirectoryTestPlan(plan, input.tools).some((issue) => issue.code === "writeScope")) {
    return {
      calls: [...input.ledger],
      cleanup: [],
      stopped: { by: "setup", detail: "The plan uses a fixture outside its permitted writes. Correct the plan and authorize it again." },
    };
  }
  const now = input.now ?? Date.now;
  const records = new Map(input.ledger.map((call) => [call.callKey, call]));
  const entries = new Map(plan.tools.map((entry) => [entry.tool, entry]));
  const listed = new Map(input.tools.map((tool) => [tool.name, tool]));
  const values = fixtureValues(plan, input.ledger);
  // With no values, a case that uses one never resolves, so it is not sent.
  for (const fixture of input.missingFixtures ?? []) values.delete(fixture);
  const caseIds = new Set(plan.cases.map((testCase) => testCase.id));
  // The budget is the run's: calls an earlier execution made count too.
  let made = input.ledger.filter(
    (call) => caseIds.has(call.callKey) && call.phase !== "planned",
  ).length;
  let stopped: Stop | undefined;
  let halted: unknown;

  const checkpoint = () => {
    if (halted) throw halted;
    if (signal?.aborted) throw new ReadinessRunCancelledError();
  };

  /** Whether the ledger took it; a refusal keeps the ledger's record. */
  async function write(call: LedgerCallWrite): Promise<boolean> {
    // A stopped run writes nothing more, not even a call's answer.
    checkpoint();
    if (stopped?.detail === LEDGER_DOWN) return false;
    let answer: LedgerAnswer;
    try {
      answer = await input.record(call);
    } catch (error) {
      if (isStopSignal(error)) {
        // Set here, not where it is caught, so no call beside this starts.
        halted ??= error;
        throw error;
      }
      logger.warn("[readiness] a test plan call could not be recorded", {
        callKey: call.callKey,
        detail: error instanceof Error ? error.message : String(error),
      });
      // No call goes out unrecorded, so nothing more is sent.
      stopped ??= { by: "setup", detail: LEDGER_DOWN };
      return false;
    }
    if (answer.call) records.set(call.callKey, answer.call);
    if (answer.kind === "refused" && answer.error === "too_many_calls") {
      stopped ??= { by: "budget" };
    }
    return answer.kind === "recorded";
  }

  /** Per the ledger; an unfinished write is marked ambiguous, never resent. */
  async function shouldSend({ testCase, entry }: PlannedCall) {
    const stored = records.get(testCase.id);
    const next = resumeDirectoryTestCall(stored, entry.effect);
    if (next === "ambiguous" && stored?.phase === "started") {
      const { tool, inputDigest, ranBy } = stored;
      const effect = entry.effect;
      const callKey = testCase.id;
      await write({
        callKey,
        tool,
        effect,
        inputDigest,
        ranBy,
        phase: "ambiguous",
      });
    }
    return next === "run";
  }

  async function send(
    { testCase, entry }: PlannedCall,
    args: Record<string, unknown>,
  ) {
    const { tool } = testCase;
    const base = {
      callKey: testCase.id,
      tool,
      effect: entry.effect,
      inputDigest: directoryTestCaseDigest(plan, testCase, listed.get(tool)),
      ranBy: DIRECT_CALL,
      ...(input.account ? { account: input.account } : {}),
      ...(input.endpoint ? { endpoint: input.endpoint } : {}),
    };
    if (!(await write({ ...base, phase: "started" }))) return;
    // A call beside this one may have met a lost lease meanwhile.
    checkpoint();
    const specs = captureSpecs(plan, testCase.creates);
    const capture = [...new Set(specs.map((spec) => spec.path))];
    const evidence = await input.send({ tool, arguments: args, capture });
    const { phase, outcome } = classifyDirectoryTestCall(
      evidence,
      entry.effect,
    );
    const captured =
      phase === "succeeded" ? capturedValues(specs, evidence) : [];
    await write({
      ...base,
      phase,
      outcome,
      ...(captured.length > 0 ? { captured } : {}),
      ...(evidence.error
        ? { detail: evidence.error.slice(0, MAX_DETAIL_LENGTH) }
        : {}),
    });
    for (const { fixture, name, value } of captured) {
      values.set(fixture, { ...values.get(fixture), [name]: value });
    }
  }

  async function runCase(call: PlannedCall): Promise<void> {
    checkpoint();
    if (!(await shouldSend(call))) return;
    if (!stopped && now() > input.casesBy) stopped = { by: "deadline" };
    if (!stopped && made >= plan.budget.maxCalls) stopped = { by: "budget" };
    if (stopped) return;
    const resolved = resolve(call.testCase.arguments ?? {}, values);
    // A fixture value its creator never returned, or a fixture the reviewer's
    // account lacks: the summary names it.
    if ("missing" in resolved) return;
    made += 1;
    await send(call, resolved.arguments);
  }

  const guarded = async (call: PlannedCall) => {
    try {
      await runCase(call);
    } catch (error) {
      // The calls running beside this one stop at their next checkpoint.
      halted ??= error;
      throw error;
    }
  };

  let reads: PlannedCall[] = [];
  const flushReads = async () => {
    await inParallel(reads, plan.budget.concurrency, guarded);
    reads = [];
  };
  for (const testCase of plan.cases) {
    const entry = entries.get(testCase.tool);
    // Excluded tools' cases, and negative-only tools' valid ones, never run.
    if (!entry || entry.action === "excluded") continue;
    if (entry.action === "negative-only" && testCase.kind === "valid") continue;
    if (entry.effect === "read" && !testCase.creates?.length) {
      reads.push({ testCase, entry });
      continue;
    }
    await flushReads();
    await guarded({ testCase, entry });
  }
  await flushReads();

  // After an interrupted sweep too; not counted against the budget.
  for (const step of plan.cleanup) {
    const entry = entries.get(step.tool);
    // Never created by this run, so there is nothing of it to remove.
    if (!entry || !values.has(step.fixture)) continue;
    const testCase: DirectoryTestCase = {
      id: `cleanup:${step.fixture}`,
      tool: step.tool,
      kind: "valid",
      arguments: step.arguments,
    };
    checkpoint();
    if (!(await shouldSend({ testCase, entry })) || now() > input.cleanupBy)
      continue;
    const resolved = resolve(step.arguments, values);
    if (!("missing" in resolved))
      await send({ testCase, entry }, resolved.arguments);
  }

  const latest = [...records.values()];
  return {
    calls: latest.filter((call) => caseIds.has(call.callKey)),
    cleanup: latest.filter((call) => !caseIds.has(call.callKey)),
    ...(stopped ? { stopped } : {}),
  };
}

/** Existing fixtures' values, and what creating calls already captured. */
function fixtureValues(
  plan: DirectoryTestPlan,
  ledger: readonly DirectoryTestCallRecord[],
): FixtureValues {
  const values: FixtureValues = new Map();
  for (const fixture of plan.fixtures) {
    if (fixture.origin === "existing" && fixture.values) {
      values.set(fixture.id, { ...fixture.values });
    }
  }
  for (const call of ledger) {
    if (call.phase !== "succeeded") continue;
    for (const [fixture, named] of Object.entries(call.captured ?? {})) {
      values.set(fixture, { ...values.get(fixture), ...named });
    }
  }
  return values;
}

const resolve = (args: Record<string, unknown>, values: FixtureValues) =>
  resolveDirectoryTestArguments(args, Object.fromEntries(values));

/** Each value the call's created fixtures capture, with its path in the result. */
function captureSpecs(plan: DirectoryTestPlan, creates: string[] = []) {
  return plan.fixtures
    .filter((fixture) => creates.includes(fixture.id))
    .flatMap(({ id, capture }) =>
      Object.entries(capture ?? {}).map(([name, path]) => ({ id, name, path })),
    );
}

function capturedValues(
  specs: ReturnType<typeof captureSpecs>,
  { captured = {} }: DirectoryToolCallEvidence,
): LedgerCapturedValue[] {
  return specs.flatMap(({ id, name, path }) => {
    const value = Object.hasOwn(captured, path) ? captured[path] : undefined;
    return value === undefined ? [] : [{ fixture: id, name, value }];
  });
}

/** `work` over `items`, at most `limit` at a time. */
async function inParallel<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await work(items[next++]!);
  };
  const lanes = Math.min(Math.max(limit, 1), items.length);
  await Promise.all(Array.from({ length: lanes }, lane));
}
