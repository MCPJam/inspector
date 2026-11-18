/**
 * Which half of the server's work this process does. A hosted deployment can
 * run `web` replicas, which serve HTTP and run no claim loops, beside a
 * `worker` deployment that runs them: deploying the web tier then never stops
 * a claimed job mid-run, and the worker drains on its own schedule. `all`, the
 * default, does both, as a self-hosted inspector and an unsplit deployment do.
 *
 * A claimed job needs nothing held by the web process: its callbacks reach
 * routes any replica serves. Runs started over HTTP and the backend's doorbell
 * passes stay where they were accepted, on the web tier, which drains them.
 */

import { HOSTED_MODE } from "../../config.js";
import { resolveWebAuthorizedHarnessStrategy } from "../../utils/harness/harness-proxy-strategy.js";
import {
  hasServiceCredential,
  SERVICE_CREDENTIAL_ENV,
} from "../service-credential.js";

export const PROCESS_ROLE_ENV = "MCPJAM_PROCESS_ROLE";

const PROCESS_ROLES = ["all", "web", "worker"] as const;
export type ProcessRole = (typeof PROCESS_ROLES)[number];

/** A misspelled role fails the boot rather than quietly running both halves. */
export function resolveProcessRole(
  env: NodeJS.ProcessEnv = process.env,
): ProcessRole {
  const value = env[PROCESS_ROLE_ENV]?.trim().toLowerCase();
  if (!value) return "all";
  const role = PROCESS_ROLES.find((candidate) => candidate === value);
  if (!role) {
    throw new Error(
      `${PROCESS_ROLE_ENV} must be one of ${PROCESS_ROLES.join(", ")}; got "${env[PROCESS_ROLE_ENV]}".`,
    );
  }
  return role;
}

/**
 * A worker that could not run what it claims fails its boot instead of taking
 * jobs. Without the service credential it claims nothing. A hosted harness
 * eval reaches `/api/web/harness-mcp` at the public origin, because the hosted
 * planes have no relay to tunnel into a private worker; self-hosted, the relay
 * lands on the worker's own listener, which serves that route too.
 */
export function assertWorkerCanRunClaims(hosted: boolean = HOSTED_MODE): void {
  const missing: string[] = [];
  if (!process.env.CONVEX_HTTP_URL?.trim()) missing.push("CONVEX_HTTP_URL");
  if (!hasServiceCredential()) missing.push(SERVICE_CREDENTIAL_ENV);
  const strategy = resolveWebAuthorizedHarnessStrategy();
  const direct =
    strategy.plane === "web-authorized" && strategy.mode === "direct";
  if (hosted && !direct) {
    missing.push(
      "MCPJAM_INSPECTOR_PUBLIC_URL set to the web tier's public https origin",
    );
  }
  if (missing.length > 0) {
    throw new Error(`${PROCESS_ROLE_ENV}=worker needs ${missing.join(", ")}.`);
  }
}
