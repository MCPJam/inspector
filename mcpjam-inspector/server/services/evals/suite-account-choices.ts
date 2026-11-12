import type { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";
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
  target: { suiteId?: unknown; testCaseId?: unknown },
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
