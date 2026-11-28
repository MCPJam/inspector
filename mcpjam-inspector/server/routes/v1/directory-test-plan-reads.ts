/**
 * The reads behind a directory submission's test plan: its saved revisions,
 * the stored tool list a plan is drafted from and checked against, and a
 * run's call ledger as the SDK's call records.
 *
 * The tool list is the latest catalog revision MCPJam stored for the saved
 * server. It keeps each tool's name and annotation hints, which drafting and
 * checking read. It is not the listing a run called: storage keeps only the
 * hint booleans and drops `$` keys from schemas. So a run checks its plan
 * against a live listing before it calls anything and grades its own calls in
 * its report; the ledger's calls are graded here only while a run goes on.
 */
import type { Context } from "hono";
import type { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type {
  DirectoryTestCallRecord,
  DirectoryTestPlan,
  DirectoryTestPlanTool,
  DirectoryToolEffect,
} from "@mcpjam/sdk";
import {
  directoryTestPlanSchema,
  type PlatformDirectoryTestPlanCatalog,
  type PlatformDirectoryTestPlanRevision,
  type PlatformServerRevision,
  type PlatformServerRevisionSummary,
} from "@mcpjam/sdk/platform";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { fetchConvexV1Read } from "./convex-v1-proxy.js";
import { readRefusal } from "./directory-submission-views.js";

const query = (name: string) => makeFunctionReference<"query">(name);
const fn = {
  plan: query("directoryTestPlans:getDirectoryTestPlan"),
  calls: query("directoryReadinessCallLedger:getReadinessRunCalls"),
};

/** A saved revision as the backend returns it: the plan as JSON text. */
export type StoredTestPlan = PlatformDirectoryTestPlanRevision & {
  plan: string;
};

/** A ledger row as the backend returns it. */
type LedgerCall = Omit<DirectoryTestCallRecord, "captured" | "planRevision"> & {
  effect: DirectoryToolEffect;
  attempts?: number;
  captured?: Array<{ fixture: string; name: string; value: string | number }>;
};

export type RunCall = {
  record: DirectoryTestCallRecord;
  effect: DirectoryToolEffect;
};

export interface ServerTools {
  catalog: PlatformDirectoryTestPlanCatalog;
  tools: DirectoryTestPlanTool[];
}

/** The current plan, or the revision named; null when there is none. */
export async function readStoredTestPlan(
  convex: ConvexHttpClient,
  submissionId: string,
  revision?: number,
): Promise<StoredTestPlan | null> {
  try {
    return await convex.query(fn.plan, {
      submissionId,
      ...(revision !== undefined ? { revision } : {}),
    });
  } catch (error) {
    throw readRefusal(error, "Directory submission");
  }
}

/** The stored plan, read in the shape the SDK checks; a plan that is not one is refused. */
export function toTestPlan(stored: StoredTestPlan): DirectoryTestPlan {
  let value: unknown;
  try {
    value = JSON.parse(stored.plan);
  } catch {
    // Not JSON: refused below, like any plan the schema does not match.
    value = undefined;
  }
  const parsed = directoryTestPlanSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new WebRouteError(
    409,
    ErrorCode.CONFLICT,
    `Test plan revision ${stored.revision} is not in a form MCPJam can read. Draft a new plan, then save it.`,
  );
}

function catalogUnreadable(): WebRouteError {
  return new WebRouteError(
    502,
    ErrorCode.SERVER_UNREACHABLE,
    "MCPJam could not read this server's stored tool list. Try again in a minute.",
  );
}

/** The latest tool list MCPJam stored for the server, or why there is none to use. */
export async function readServerTools(c: Context, projectId: string, serverId: string): Promise<ServerTools | string> {
  const scoped = (more: (target: URL) => void) => (target: URL) => {
    target.searchParams.set("projectId", projectId);
    target.searchParams.set("serverId", serverId);
    more(target);
  };
  const page = await fetchConvexV1Read(
    c,
    "/v1/project-server-revisions",
    scoped((target) => target.searchParams.set("limit", "1")),
  );
  const none = "MCPJam has no stored tool list for this server yet. Connect the server in MCPJam, then try again.";
  // Not found: a server deleted since, which has no tool list to read.
  if (page.status === 404) return none;
  if (page.status !== 200) throw catalogUnreadable();
  const newest = (page.body as { items?: PlatformServerRevisionSummary[] }).items?.[0];
  if (!newest) return none;
  const read = await fetchConvexV1Read(
    c,
    "/v1/project-server-revision",
    scoped((target) => target.searchParams.set("revisionNumber", String(newest.revisionNumber))),
  );
  if (read.status !== 200) throw catalogUnreadable();
  const revision = read.body as PlatformServerRevision;
  if (revision.captureError) {
    return `MCPJam could not list this server's tools the last time it connected (${revision.captureError}). Reconnect the server in MCPJam, then try again.`;
  }
  return {
    catalog: {
      revisionNumber: revision.revisionNumber,
      capturedAt: revision.capturedAt,
    },
    tools: revision.tools.map(({ name, annotations, inputSchema }) => ({
      name,
      ...(annotations ? { annotations } : {}),
      ...(inputSchema !== undefined ? { inputSchema } : {}),
    })),
  };
}

/** The ledger's `[{fixture, name, value}]` as the SDK's values by fixture. */
function byFixture(captured: NonNullable<LedgerCall["captured"]>) {
  const fixtures = new Map<string, Array<[string, string | number]>>();
  for (const { fixture, name, value } of captured) {
    fixtures.set(fixture, [...(fixtures.get(fixture) ?? []), [name, value]]);
  }
  // Built from entries, so a fixture named `__proto__` stays an own key.
  return Object.fromEntries([...fixtures].map(([fixture, values]) => [fixture, Object.fromEntries(values)]));
}

/** A run's calls as the SDK's records, each with the effect the ledger stored. */
export async function readRunCalls(convex: ConvexHttpClient, runId: string, planRevision: number): Promise<RunCall[]> {
  let ledger: { calls: LedgerCall[] };
  try {
    ledger = await convex.query(fn.calls, { runId });
  } catch (error) {
    throw readRefusal(error, "Readiness run");
  }
  return ledger.calls.map(({ effect, attempts: _attempts, captured, ...call }) => ({
    effect,
    record: {
      ...call,
      planRevision,
      ...(captured ? { captured: byFixture(captured) } : {}),
    },
  }));
}
