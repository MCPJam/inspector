/**
 * Which climb key an iteration belongs to. A climb names its cases by the
 * platform's case key, but an iteration carries the stored row's id, and the
 * declared id only when the case declared one. A case authored over REST has a
 * generated key and no declared id, so the key is read from the suite's cases.
 */
import type { PlatformApiClient } from "@mcpjam/sdk/platform";

type IterationIds = { testCaseId?: string | null; caseId?: string };

export type CaseKeys = (iteration: IterationIds) => string | undefined;

export async function readCaseKeys(
  client: Pick<PlatformApiClient, "listEvalCases">,
  scope: { projectId: string; suiteId: string },
): Promise<CaseKeys> {
  const { items } = await client.listEvalCases(scope);
  const keyOf = new Map<string, string>();
  for (const entry of items) {
    const key = entry.key ?? entry.id;
    keyOf.set(entry.id, key);
    if (entry.declaredId) keyOf.set(entry.declaredId, key);
  }
  return (iteration) => [iteration.testCaseId, iteration.caseId].map((id) => (id ? keyOf.get(id) : undefined)).find((key) => key !== undefined);
}
