/**
 * Arguments for the test plan's cases that have none, drafted by MCPJam's
 * broker for a person to review.
 *
 * PROPOSALS, NEVER CALLS. The drafts go into the run's report and nowhere
 * else: the run does not send them, and the worker never writes them into
 * the saved plan, because naming a plan revision at the start was the
 * consent for exactly the calls that revision holds. A person accepts drafts
 * into a new revision, and a later run sends them.
 *
 * Only the broker spends, once per run, and only for a run whose requester
 * opted into model observations: the worker hands a requester to that run
 * alone, so a run without one cannot spend.
 *
 * REDACTED AS THE REPORT IS, EXCEPT THE ARGUMENTS. The broker drops a draft
 * holding a credential's shape, or a filled value under a credential's
 * name, before it answers. The report's key-name redaction would also blank
 * every string under `code`, every value under `token` or `password` (an
 * empty one a negative case sends on purpose included) and drop a `headers`
 * object, so a person would accept arguments the model never proposed. The
 * arguments are kept as the broker checked them; the text beside them is
 * redacted.
 */

import {
  DIRECTORY_OBSERVATION_REASONS,
  DIRECTORY_OBSERVATION_STATUSES,
  redactConformanceReportForSharing,
  type DirectoryObservationReason,
  type DirectoryTestCase,
  type DirectoryTestPlan,
  type DirectoryToolEvidence,
  type DirectoryToolPlan,
} from "@mcpjam/sdk";
import { logger } from "../../utils/logger.js";
import { abortableSleep } from "../../utils/run-supervisor/backoff.js";
import { getInternalBackendConfig } from "../internal-backend.js";
import { parseJsonObject, type ReadinessLease } from "./backend-client.js";
import {
  ReadinessLeaseLostError,
  ReadinessRunCancelledError,
  asRecord,
  isStopSignal,
  type ObservationBrokerAnswer,
} from "./runner.js";

const TEST_ARGUMENTS_PATH = "/internal/v1/claude-readiness/test-arguments";

/** The broker refuses a request for more cases than one run may draft. */
const MAX_CASES_PER_RUN = 24;
/**
 * The broker's bounds on one case. A case past them is left unsent: sent,
 * it would refuse the whole request and cost every other case its draft.
 */
const MAX_NAME_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 2_000;
const MAX_FIXTURES = 10;
const MAX_FIXTURE_VALUES = 10;
const MAX_CASE_CHARS = 12_000;
/**
 * A full pass drafts 24 cases four at a time, each given 45 seconds: four
 * and a half minutes, plus the broker's claim and holds.
 */
const PASS_MS = 5 * 60_000;
/**
 * A pass an earlier attempt of this run started is waited for as long as a
 * pass takes; the retry then gets its stored drafts, paid for once.
 */
const RETRY_DELAY_MS = 30_000;
const RETRIES = PASS_MS / RETRY_DELAY_MS;
/** Refusals that mean drafting is off for the run, skipped quietly. */
const DRAFTING_OFF = ["drafting_disabled", "drafting_not_requested"];

const EFFECT_HINTS = [
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
] as const;
const EXPECTED_ERRORS = ["invalid-arguments", "tool-error"] as const;
const UNDECIDED_REASONS = [
  "needs_secret",
  "needs_fixture",
  "unclear",
  "schema_mismatch",
  "credential",
  "schema_invalid",
  "provider_error",
  "provider_timeout",
  "ai_unavailable",
] as const;
/** Closed, like the observation pass's: a surface branches on the value. */
const PASS_STATUSES = DIRECTORY_OBSERVATION_STATUSES.filter(
  (status): status is ObservationBrokerAnswer["status"] =>
    status !== "not-requested" && status !== "pending",
);

const NO_TIME =
  "This run had too little time left to draft test arguments. Start a new run to draft them.";
const TIMED_OUT = `Drafting test arguments took longer than ${PASS_MS / 60_000} minutes, so this run has none. Start a new run to try again.`;
const STILL_DRAFTING = `Test arguments for this run were still being drafted after ${PASS_MS / 60_000} minutes, so it has none. Start a new run to draft them.`;
const NOT_DRAFTED =
  "MCPJam could not draft test arguments for this run. Start a new run to try again.";

/** One case as the broker takes it, with its tool as the server lists it now. */
export interface TestArgumentDraftItem {
  caseId: string;
  tool: string;
  kind: DirectoryTestCase["kind"];
  inputSchema: Record<string, unknown>;
  description?: string;
  annotations?: Record<string, string | boolean>;
  /** What the case may refer to as `{"$fixture": id, "value": name}`: names, never values. */
  fixtures?: { id: string; description?: string; values: string[] }[];
}

/** Arguments the broker proposes for one case. */
export interface TestArgumentDraft {
  caseId: string;
  /** Fixture references left unresolved, as a plan holds them. */
  arguments: Record<string, unknown>;
  /** A negative case's expected refusal; absent means any refusal. */
  expectedError?: (typeof EXPECTED_ERRORS)[number];
  rationale: string;
}

/** A case the broker answered without arguments, and why. */
export interface TestArgumentUndecided {
  caseId: string;
  reason: (typeof UNDECIDED_REASONS)[number];
  detail?: string;
}

/** What one drafting pass answered. */
export interface TestArgumentPass {
  /** The broker's outcome, or `provider-failed` when it gave none. */
  status: ObservationBrokerAnswer["status"];
  reason?: DirectoryObservationReason;
  detail?: string;
  drafts: TestArgumentDraft[];
  undecided: TestArgumentUndecided[];
  /** Drafts the broker checked and dropped; each is also in `undecided`. */
  dropped: { schema: number; credential: number };
  modelId?: string;
  promptVersion?: string;
}

/** The report's account of drafting: proposals only, none sent by the run. */
export interface TestArgumentDrafting extends TestArgumentPass {
  /**
   * Cases without arguments the run did not send: past the per-run cap, or
   * with no tool listed in a form the broker takes.
   */
  unsent: number;
}

/** How a run asks for drafts. Absent, the run cannot spend on them. */
export type TestArgumentRequester = (request: {
  items: TestArgumentDraftItem[];
  /** The run's signal: a cancelled run stops waiting for the pass. */
  signal: AbortSignal;
  /** When the pass must have answered for the run to still finalize. */
  endBy: number;
}) => Promise<TestArgumentPass | undefined>;

const notDrafted = (
  reason: "provider_error" | "provider_timeout",
  detail: string,
): TestArgumentPass => ({
  status: "provider-failed",
  reason,
  detail,
  drafts: [],
  undecided: [],
  dropped: { schema: 0, credential: 0 },
});

/**
 * Drafts for the plan's cases that have no arguments, or `undefined` when the
 * run has no requester, nothing to send, or drafting is off. A stop signal
 * passes; any other failure is reported, never failing the run.
 */
export async function draftMissingArguments(input: {
  plan: DirectoryTestPlan;
  tools: readonly DirectoryToolEvidence[];
  request?: TestArgumentRequester;
  signal: AbortSignal;
  endBy: number;
}): Promise<TestArgumentDrafting | undefined> {
  const { request, signal, endBy } = input;
  if (!request) return undefined;
  const { items, unsent } = draftItems(input.plan, input.tools);
  if (items.length === 0) return undefined;
  let pass: TestArgumentPass | undefined;
  try {
    pass = await request({ items, signal, endBy });
  } catch (error) {
    if (isStopSignal(error)) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    logger.warn("[readiness] test argument drafting failed", { detail });
    pass = notDrafted("provider_error", NOT_DRAFTED);
  }
  return pass && { ...pass, unsent };
}

/** The cases without arguments that would run, as the broker takes them, in plan order. */
function draftItems(
  plan: DirectoryTestPlan,
  tools: readonly DirectoryToolEvidence[],
): { items: TestArgumentDraftItem[]; unsent: number } {
  const listed = new Map(tools.map((tool) => [tool.name, tool]));
  const entries = new Map(plan.tools.map((entry) => [entry.tool, entry]));
  const items: TestArgumentDraftItem[] = [];
  const sent = new Set<string>();
  const created = new Set<string>();
  let wanting = 0;
  for (const testCase of plan.cases) {
    const entry = entries.get(testCase.tool);
    // As the sweep does: excluded tools' cases, and negative-only tools'
    // valid ones, never run, so drafting them buys nothing.
    const runs =
      entry?.action === "run" ||
      (entry?.action === "negative-only" && testCase.kind === "negative");
    if (!testCase.arguments && entry && runs) {
      wanting += 1;
      const tool = listed.get(testCase.tool);
      const room = items.length < MAX_CASES_PER_RUN && !sent.has(testCase.id);
      const item =
        room && tool && draftItem(plan, testCase, entry, tool, created);
      if (item) {
        items.push(item);
        sent.add(item.caseId);
      }
    }
    // Only a case after this one may use what it creates.
    for (const fixture of testCase.creates ?? []) created.add(fixture);
  }
  return { items, unsent: wanting - items.length };
}

const fits = (text: unknown): text is string =>
  typeof text === "string" && /\S/.test(text) && text.length <= MAX_NAME_CHARS;

function draftItem(
  plan: DirectoryTestPlan,
  testCase: DirectoryTestCase,
  entry: DirectoryToolPlan,
  tool: DirectoryToolEvidence,
  created: ReadonlySet<string>,
): TestArgumentDraftItem | undefined {
  const inputSchema = asRecord(tool.inputSchema);
  const { id: caseId, kind } = testCase;
  if (!inputSchema || !fits(caseId) || !fits(tool.name)) return undefined;
  if (kind !== "valid" && kind !== "negative") return undefined;
  const { description } = tool;
  const annotations = draftAnnotations(tool.annotations);
  const fixtures = offeredFixtures(plan, entry.writes, created);
  const item: TestArgumentDraftItem = {
    caseId,
    tool: tool.name,
    kind,
    inputSchema,
    ...(typeof description === "string"
      ? { description: description.slice(0, MAX_DESCRIPTION_CHARS) }
      : {}),
    ...(annotations ? { annotations } : {}),
    ...(fixtures.length > 0 ? { fixtures } : {}),
  };
  return JSON.stringify(item).length <= MAX_CASE_CHARS ? item : undefined;
}

/** The hints and title the broker takes; other annotations stay home. */
function draftAnnotations(
  value: unknown,
): TestArgumentDraftItem["annotations"] {
  const hints = asRecord(value);
  const picked: Record<string, string | boolean> = {};
  for (const hint of EFFECT_HINTS) {
    const flag = hints?.[hint];
    if (typeof flag === "boolean") picked[hint] = flag;
  }
  const title = hints?.title;
  if (typeof title === "string") picked.title = title.slice(0, MAX_NAME_CHARS);
  return Object.keys(picked).length > 0 ? picked : undefined;
}

/**
 * The fixtures a case may refer to: existing ones, and created ones a case
 * before it creates, the tool's permitted writes first. Value names travel;
 * an existing fixture's values never reach the model.
 */
function offeredFixtures(
  plan: DirectoryTestPlan,
  writes: readonly string[],
  created: ReadonlySet<string>,
): NonNullable<TestArgumentDraftItem["fixtures"]> {
  const offered = plan.fixtures.flatMap((fixture) => {
    const usable = fixture.origin === "existing" || created.has(fixture.id);
    const named =
      fixture.origin === "created" ? fixture.capture : fixture.values;
    const values = Object.keys(asRecord(named) ?? {})
      .filter(fits)
      .slice(0, MAX_FIXTURE_VALUES);
    if (!usable || !fits(fixture.id) || values.length === 0) return [];
    const { description } = fixture;
    return [
      {
        id: fixture.id,
        ...(typeof description === "string" && description
          ? { description: description.slice(0, MAX_DESCRIPTION_CHARS) }
          : {}),
        values,
      },
    ];
  });
  const rank = (id: string) => (writes.includes(id) ? 0 : 1);
  return offered.sort((a, b) => rank(a.id) - rank(b.id)).slice(0, MAX_FIXTURES);
}

/**
 * Ask the broker to draft `items` on the run's lease.
 *
 * As for observations, every failure but a stop signal becomes an answer: a
 * refusal, a timeout or an unreadable body is reported with what to do, and
 * logged with the run's id. A 403 that turns drafting off is `undefined`. A
 * pass this run already started is waited for, then given up the same way.
 * Any other 409 is a lost lease.
 */
export async function requestTestArgumentDrafts(
  lease: ReadinessLease,
  { items, signal, endBy }: Parameters<TestArgumentRequester>[0],
): Promise<TestArgumentPass | undefined> {
  const failed = (detail: string, logged: string, timedOut = false) => {
    logger.warn("[readiness] test arguments were not drafted", {
      runId: lease.runId,
      detail: logged,
    });
    return notDrafted(timedOut ? "provider_timeout" : "provider_error", detail);
  };
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    if (attempt > 0) await abortableSleep(RETRY_DELAY_MS, signal);
    if (signal.aborted) throw new ReadinessRunCancelledError();
    // A pass the run cannot wait out would be paid for and never read.
    if (endBy - Date.now() < PASS_MS) {
      return attempt === 0
        ? failed(NO_TIME, "too little time left in the run", true)
        : failed(STILL_DRAFTING, "an earlier pass was still running", true);
    }
    let reply: Awaited<ReturnType<typeof postTestArguments>>;
    try {
      reply = await postTestArguments(lease, items, signal);
    } catch (error) {
      if (signal.aborted) throw new ReadinessRunCancelledError();
      const message = error instanceof Error ? error.message : String(error);
      return error instanceof Error && error.name === "AbortError"
        ? failed(
            TIMED_OUT,
            `no answer within ${PASS_MS / 60_000} minutes`,
            true,
          )
        : failed(NOT_DRAFTED, `the broker could not be reached: ${message}`);
    }
    const { status, body } = reply;
    const code = typeof body?.error === "string" ? body.error : undefined;
    if (status === 409 && code === "drafting_in_progress") continue;
    if (status === 409) throw new ReadinessLeaseLostError();
    if (status === 403 && code !== undefined && DRAFTING_OFF.includes(code)) {
      return undefined;
    }
    const pass = status === 200 ? readPass(body) : undefined;
    const why = status === 200 ? "an unreadable answer" : `HTTP ${status}`;
    return pass ?? failed(NOT_DRAFTED, code ? `${why} ${code}` : why);
  }
  return failed(STILL_DRAFTING, "an earlier pass was still running", true);
}

/** One request to the route: its status and body, or a throw. */
async function postTestArguments(
  lease: ReadinessLease,
  items: readonly TestArgumentDraftItem[],
  signal: AbortSignal,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const { convexUrl, serviceToken } = getInternalBackendConfig();
  const deadline = new AbortController();
  // Armed through the body read, so an answer that stalls midway still ends.
  const timer = setTimeout(() => deadline.abort(), PASS_MS);
  try {
    const response = await fetch(`${convexUrl}${TEST_ARGUMENTS_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-inspector-service-token": serviceToken,
      },
      body: JSON.stringify({ ...lease, items }),
      signal: AbortSignal.any([deadline.signal, signal]),
    });
    const text = await response.text();
    return { status: response.status, body: parseJsonObject(text) };
  } finally {
    clearTimeout(timer);
  }
}

const redact = (text: string) => redactConformanceReportForSharing(text);
const list = (value: unknown) => (Array.isArray(value) ? value : []);
const count = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;

/** The pass, picked to the fields the report keeps, or `undefined` when unreadable. */
function readPass(
  body: Record<string, unknown> | null,
): TestArgumentPass | undefined {
  const status = PASS_STATUSES.find((known) => known === body?.status);
  if (!body || !status) return undefined;
  const reason = DIRECTORY_OBSERVATION_REASONS.find(
    (known) => known === body.reason,
  );
  const { detail, modelId, promptVersion } = body;
  const dropped = asRecord(body.dropped);
  return {
    status,
    ...(reason ? { reason } : {}),
    ...(typeof detail === "string" ? { detail: redact(detail) } : {}),
    drafts: list(body.drafts).flatMap(readDraft),
    undecided: list(body.undecided).flatMap(readUndecided),
    dropped: {
      schema: count(dropped?.schema),
      credential: count(dropped?.credential),
    },
    ...(typeof modelId === "string" ? { modelId } : {}),
    ...(typeof promptVersion === "string" ? { promptVersion } : {}),
  };
}

function readDraft(entry: unknown): TestArgumentDraft[] {
  const draft = asRecord(entry);
  const args = asRecord(draft?.arguments);
  const { caseId, rationale } = draft ?? {};
  if (typeof caseId !== "string" || typeof rationale !== "string" || !args) {
    return [];
  }
  const expectedError = EXPECTED_ERRORS.find(
    (known) => known === draft?.expectedError,
  );
  return [
    {
      caseId,
      arguments: args,
      ...(expectedError ? { expectedError } : {}),
      rationale: redact(rationale),
    },
  ];
}

function readUndecided(entry: unknown): TestArgumentUndecided[] {
  const undecided = asRecord(entry);
  const reason = UNDECIDED_REASONS.find((known) => known === undecided?.reason);
  const { caseId, detail } = undecided ?? {};
  if (typeof caseId !== "string" || !reason) return [];
  return [
    {
      caseId,
      reason,
      ...(typeof detail === "string" ? { detail: redact(detail) } : {}),
    },
  ];
}
