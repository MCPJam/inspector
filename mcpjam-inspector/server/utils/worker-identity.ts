/**
 * Stable per-process identity for the durable synthesis runner (plan v4 §I).
 *
 * Generated once at module load. Used in two places:
 *
 * - `workerScope` derivation for jobs created under `/api/mcp/*`:
 *   `local:${workerInstanceId}`. The local pump claim filter only
 *   matches its own scope so a local-only run can't be picked up by a
 *   hosted worker (and vice versa).
 * - `leaseOwner` on every claim/heartbeat/complete/fail call. The
 *   backend CAS lease guards on owner equality so out-of-process
 *   recoveries can't accidentally write through a former owner.
 */
import { randomUUID } from "node:crypto";

export const workerInstanceId: string = randomUUID();
