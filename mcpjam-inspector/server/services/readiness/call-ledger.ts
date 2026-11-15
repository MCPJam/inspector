/**
 * The worker's client for a run's test plan and call ledger.
 *
 * Three service-token routes, each guarded by the run's lease: the plan
 * revision the run started with, the calls the run already made, and one
 * call's record, written before the call is sent and again when its answer
 * comes back. A 409 `lease_lost`, or a run that no longer exists, throws
 * `ReadinessLeaseLostError`: this node may write nothing more for the run.
 */

import {
  DIRECTORY_TEST_CALL_OUTCOMES,
  DIRECTORY_TEST_CALL_PHASES,
  type DirectoryTestCallRecord,
  type DirectoryTestClient,
  type DirectoryToolEffect,
} from "@mcpjam/sdk";
import { getInternalBackendConfig } from "../internal-backend.js";
import { parseJsonObject, type ReadinessLease } from "./backend-client.js";
import { ReadinessLeaseLostError, asRecord } from "./runner.js";

const CALLS_PATH = "/internal/v1/claude-readiness/runs/calls";
const TEST_PLAN_PATH = "/internal/v1/claude-readiness/runs/test-plan";
const TIMEOUT_MS = 15_000;

/** A captured value as the ledger keeps it: fixture ids are free text, so a list. */
export interface LedgerCapturedValue {
  fixture: string;
  name: string;
  value: string | number;
}

/** What the worker says about one call; a cleanup step's key is `cleanup:<fixture>`. */
export type LedgerCallWrite = Pick<
  DirectoryTestCallRecord,
  "callKey" | "tool" | "phase" | "inputDigest" | "ranBy" | "endpoint"
> & {
  /** From the plan: it lets the ledger refuse to send a write twice. */
  effect: DirectoryToolEffect;
  /** The reviewer account the call is made as. */
  account?: string;
  outcome?: DirectoryTestCallRecord["outcome"];
  captured?: LedgerCapturedValue[];
  detail?: string;
};

/** A refusal comes with the call as the ledger holds it, when it holds one. */
export type LedgerAnswer =
  | { kind: "recorded"; call: DirectoryTestCallRecord }
  | { kind: "refused"; error: string; call?: DirectoryTestCallRecord };

async function ledgerRequest(
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const { convexUrl, serviceToken } = getInternalBackendConfig();
  let status: number;
  let text: string;
  try {
    const response = await fetch(`${convexUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "x-inspector-service-token": serviceToken,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      // Armed through the body read too.
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = response.status;
    text = await response.text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`the run's call ledger did not answer: ${detail}`, {
      cause: error,
    });
  }
  const parsed = parseJsonObject(text);
  const lost =
    (status === 409 && parsed?.error === "lease_lost") ||
    (status === 404 && parsed?.error === "not_found");
  if (lost) throw new ReadinessLeaseLostError();
  return { status, body: parsed };
}

const leaseQuery = (lease: ReadinessLease) =>
  new URLSearchParams({ runId: lease.runId, jobId: lease.jobId });

/** The plan revision the run executes, if any, and every call it recorded. */
export async function readRunCallLedger(lease: ReadinessLease): Promise<{
  testPlanRevision?: number;
  calls: DirectoryTestCallRecord[];
}> {
  const { status, body } = await ledgerRequest(
    `${CALLS_PATH}?${leaseQuery(lease)}`,
  );
  const revision = body?.testPlanRevision;
  const planRevision = typeof revision === "number" ? revision : undefined;
  const listed = Array.isArray(body?.calls) ? body.calls : undefined;
  const calls = listed?.map((call) => toCallRecord(call, planRevision));
  // A call this build cannot read could be a write that may have landed.
  if (status !== 200 || !calls || calls.some((call) => !call)) {
    throw new Error(`the run's call ledger could not be read (HTTP ${status})`);
  }
  return {
    ...(planRevision !== undefined ? { testPlanRevision: planRevision } : {}),
    calls: calls.filter((call) => call !== undefined),
  };
}

/** The run's frozen plan, or `undefined` when its revision is no longer kept. */
export async function readRunTestPlan(
  lease: ReadinessLease,
): Promise<{ revision: number; plan: unknown } | undefined> {
  const { status, body } = await ledgerRequest(
    `${TEST_PLAN_PATH}?${leaseQuery(lease)}`,
  );
  if (status === 404 && body?.error === "no_test_plan") return undefined;
  if (status !== 200 || typeof body?.revision !== "number") {
    throw new Error(`the run's test plan could not be read (HTTP ${status})`);
  }
  return { revision: body.revision, plan: body.plan };
}

export async function recordRunCall(
  lease: ReadinessLease,
  call: LedgerCallWrite,
  planRevision?: number,
): Promise<LedgerAnswer> {
  const { status, body } = await ledgerRequest(CALLS_PATH, { ...lease, call });
  const stored = toCallRecord(body?.call, planRevision);
  if (status === 200 && stored) return { kind: "recorded", call: stored };
  // 409: the ledger disagrees with this write; 400: it cannot take it.
  if ((status === 409 || status === 400) && typeof body?.error === "string") {
    return {
      kind: "refused",
      error: body.error,
      ...(stored ? { call: stored } : {}),
    };
  }
  throw new Error(
    `the run's call ledger did not record ${call.callKey} (HTTP ${status})`,
  );
}

function toClient(value: unknown): DirectoryTestClient | undefined {
  const ranBy = asRecord(value);
  if (ranBy?.kind === "direct-call") return { kind: "direct-call" };
  if (ranBy?.kind === "eval-run" && typeof ranBy.client === "string") {
    return { kind: "eval-run", client: ranBy.client };
  }
  const directory = ranBy?.directory;
  if (
    ranBy?.kind === "directory" &&
    (directory === "claude" || directory === "openai")
  ) {
    return { kind: "directory", directory };
  }
  return undefined;
}

/** The ledger's `[{fixture, name, value}]` as the SDK's values by fixture. */
function capturedByFixture(list: unknown[]) {
  // A map, so a fixture named `__proto__` stays an own key.
  const byFixture = new Map<string, Record<string, string | number>>();
  for (const item of list.map(asRecord)) {
    const { fixture, name, value } = item ?? {};
    if (typeof fixture !== "string" || typeof name !== "string") continue;
    if (typeof value !== "string" && typeof value !== "number") continue;
    byFixture.set(fixture, { ...byFixture.get(fixture), [name]: value });
  }
  return Object.fromEntries(byFixture);
}

/** A ledger row as the SDK's record, or `undefined` when it is not one. */
export function toCallRecord(
  value: unknown,
  planRevision?: number,
): DirectoryTestCallRecord | undefined {
  const call = asRecord(value);
  const phase = DIRECTORY_TEST_CALL_PHASES.find(
    (known) => known === call?.phase,
  );
  const ranBy = toClient(call?.ranBy);
  const { callKey, tool, inputDigest } = call ?? {};
  if (!call || !phase || !ranBy) return undefined;
  if (typeof callKey !== "string" || typeof tool !== "string") return undefined;
  if (typeof inputDigest !== "string") return undefined;
  const outcome = DIRECTORY_TEST_CALL_OUTCOMES.find(
    (known) => known === call.outcome,
  );
  const { account, endpoint, catalogRevision, startedAt, finishedAt, detail } =
    call;
  return {
    callKey,
    tool,
    phase,
    inputDigest,
    ranBy,
    ...(typeof account === "string" ? { account } : {}),
    ...(typeof endpoint === "string" ? { endpoint } : {}),
    ...(typeof catalogRevision === "number" ? { catalogRevision } : {}),
    ...(planRevision !== undefined ? { planRevision } : {}),
    ...(typeof startedAt === "number" ? { startedAt } : {}),
    ...(typeof finishedAt === "number" ? { finishedAt } : {}),
    ...(outcome ? { outcome } : {}),
    ...(Array.isArray(call.captured)
      ? { captured: capturedByFixture(call.captured) }
      : {}),
    ...(typeof detail === "string" ? { detail } : {}),
  };
}
