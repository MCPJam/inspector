import {
  creditRecoveryOfIterations,
  type CreditRecovery,
} from "./contract/credit-recovery.js";
import type { PlatformApiClient } from "./platform/client.js";
import type { PlatformEvalRun } from "./platform/types.js";

/** One page: the run record has no recovery field, so this read is the cost. */
const CREDIT_RECOVERY_PAGE_LIMIT = 200;

/**
 * The recovery a credit-stopped run recorded on the trial that hit the
 * refusal, or `undefined`.
 *
 * Only a `failed` run is read: a credit stop always finalizes `failed`, and
 * every other status would buy a page of iterations for nothing. The trial is
 * looked for on the first page only, which holds it for any run of up to 200
 * trials; past that it can be missed and the run's `notes` still carry the
 * step. A read failure is the same "not found": the step is advisory and must
 * not fail the status read it rides on.
 */
export async function readEvalRunCreditRecovery(
  client: Pick<PlatformApiClient, "listEvalRunIterations">,
  signal: AbortSignal | undefined,
  projectId: string,
  run: Pick<PlatformEvalRun, "id" | "status">
): Promise<CreditRecovery | undefined> {
  if (run.status !== "failed") return undefined;
  try {
    const page = await client.listEvalRunIterations(
      { projectId, runId: run.id, limit: CREDIT_RECOVERY_PAGE_LIMIT },
      { signal }
    );
    return creditRecoveryOfIterations(page.items);
  } catch {
    return undefined;
  }
}
