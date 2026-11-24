/**
 * The id the grouped launch gives a run group from its idempotency key: the
 * first 32 hex digits of `sha256("eval-run-group:" + suiteId + ":" + key)`.
 * The same bytes as `deriveRunGroupId` in `routes/v1/evals.ts` (a test pins
 * the two together) and as the backend's registry, which writes each climb
 * group's id before any run starts and refuses a run whose group it did not
 * register.
 */
import { createHash } from "node:crypto";

export function runGroupIdFor(suiteId: string, idempotencyKey: string): string {
  return createHash("sha256").update(`eval-run-group:${suiteId}:${idempotencyKey}`).digest("hex").slice(0, 32);
}
