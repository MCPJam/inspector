import type { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { MCPClientManager } from "@mcpjam/sdk";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";
import { managerAccountsAtRun } from "../../utils/mcp-connections.js";
import type { ConnectionIdSets } from "../../utils/oauth-account-sets.js";

const getMySuiteAccountChoices = makeFunctionReference<
  "query",
  { suiteId: string },
  Array<{ serverId: string; connectionIds: string[] }>
>("testSuiteAccountSelections:getMySuiteAccountChoices");
const getTestCase = makeFunctionReference<
  "query",
  { testCaseId: string },
  { testSuiteId?: string } | null
>("testSuites:getTestCase");

export type EvalAccountSelection = { serverId: string; connectionId: string };
export type EvalAccountPlan = Array<EvalAccountSelection & {
  testCaseId: string;
  source: "case" | "run" | "suite" | "default";
}>;

type AccountPlanInput = {
  suiteId: string;
  caseIds?: string[];
  serverIds: string[];
  runAccounts?: EvalAccountSelection[];
};

const getEvalRunAccountPlan = makeFunctionReference<
  "query",
  AccountPlanInput,
  EvalAccountPlan | null
>("testSuiteAccountSelections:getEvalRunAccountPlan");

export async function loadEvalRunAccountPlan(
  convex: Pick<ConvexHttpClient, "query">,
  input: AccountPlanInput,
): Promise<EvalAccountPlan | null> {
  try {
    const plan = await convex.query(getEvalRunAccountPlan, input);
    if (plan !== null || !input.runAccounts?.length) return plan;
    throw new WebRouteError(
      409,
      ErrorCode.VALIDATION_ERROR,
      "The backend did not resolve the requested run accounts. Check the accounts and try again.",
    );
  } catch (error) {
    if (/Could not find public function.*getEvalRunAccountPlan/i.test(String(error))) {
      if (!input.runAccounts?.length) return null;
      throw new WebRouteError(
        409,
        ErrorCode.VALIDATION_ERROR,
        "This backend cannot use the accounts selected for this run. Update the backend before retrying.",
      );
    }
    throw error;
  }
}

export async function openEvalAccountGroups(
  plan: EvalAccountPlan,
  open: (connectionIdSets: ConnectionIdSets) => Promise<MCPClientManager>,
) {
  const caseSets = new Map<string, Map<string, string>>();
  for (const { testCaseId, serverId, connectionId } of plan) {
    const servers = caseSets.get(testCaseId) ?? new Map();
    servers.set(serverId, connectionId);
    caseSets.set(testCaseId, servers);
  }
  const groups = new Map<string, MCPClientManager>();
  const caseManagers = new Map<string, MCPClientManager>();
  const close = async () => {
    await Promise.all([...groups.values()].map((manager) => manager.disconnectAllServers()));
  };
  try {
    for (const [caseId, servers] of caseSets) {
      const key = JSON.stringify([...servers].sort());
      let manager = groups.get(key);
      if (!manager) {
        if (groups.size >= 8) {
          throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, "Choose at most eight account combinations per run.");
        }
        manager = await open(Object.fromEntries(
          [...servers].map(([serverId, accountId]) => [serverId, [accountId]]),
        ));
        groups.set(key, manager);
        const connected = new Map(managerAccountsAtRun(manager).map(
          (entry) => [entry.serverId, entry.connectionIds],
        ));
        for (const [serverId, accountId] of servers) {
          const ids = connected.get(serverId);
          if (ids?.length !== 1 || ids[0] !== accountId) {
            throw new WebRouteError(409, ErrorCode.VALIDATION_ERROR, "A selected account could not be connected. Reconnect the account and try again.");
          }
        }
      }
      caseManagers.set(caseId, manager);
    }
    const first = groups.values().next().value;
    if (!first) throw new Error("The eval account plan contains no cases.");
    return {
      first,
      forCase(caseId: string | undefined) {
        const manager = caseId ? caseManagers.get(caseId) : undefined;
        if (!manager) {
          throw new Error("The eval case is missing from the authorized account plan.");
        }
        return manager;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * The acting person's saved account choice for a suite, in the shape the
 * authorize request takes. Read with the launcher's own bearer, so it is the
 * choice of whoever starts the run: the person clicking Run, the schedule's
 * owner, or the API key's owner.
 *
 * A failed read refuses the run. Treating it as "no choice" would run on the
 * default account, which may be exactly the one the person chose to avoid. A
 * backend without the function has never stored a choice, so it has none.
 */
export async function loadSuiteConnectionIdSets(
  convex: Pick<ConvexHttpClient, "query">,
  target: { suiteId?: unknown; testCaseId?: unknown; serverIds?: unknown },
): Promise<ConnectionIdSets | undefined> {
  const named = (value: unknown) =>
    typeof value === "string" && value ? value : undefined;
  const testCaseId = named(target.testCaseId);
  let rows: Array<{ serverId: string; connectionIds: string[] }>;
  try {
    // A quick run names only its case; the case's suite holds the choice.
    const suiteId =
      named(target.suiteId) ??
      (testCaseId
        ? named((await convex.query(getTestCase, { testCaseId }))?.testSuiteId)
        : undefined);
    if (!suiteId) return undefined;
    if (testCaseId && Array.isArray(target.serverIds)) {
      const plan = await loadEvalRunAccountPlan(convex, {
        suiteId,
        caseIds: [testCaseId],
        serverIds: target.serverIds.filter((id): id is string => typeof id === "string"),
      });
      if (plan) return Object.fromEntries(plan.map(
        ({ serverId, connectionId }) => [serverId, [connectionId]],
      ));
    }
    rows = await convex.query(getMySuiteAccountChoices, { suiteId });
  } catch (error) {
    if (/Could not find public function/i.test(String(error))) return undefined;
    throw new WebRouteError(
      503,
      ErrorCode.INTERNAL_ERROR,
      "MCPJam couldn't load the accounts chosen for this suite, so the run didn't start. Try again in a few minutes.",
    );
  }
  const sets = Object.fromEntries(
    (Array.isArray(rows) ? rows : []).map((row) => [
      row.serverId,
      row.connectionIds,
    ]),
  );
  return Object.keys(sets).length ? sets : undefined;
}
