/**
 * Boot-time bootstrap of the computers data-plane credentials from Convex.
 *
 * A deployed inspector holds ONE computers-related credential — the
 * environment-root `INSPECTOR_SERVICE_TOKEN` — and derives the rest here:
 * `GET /internal/v1/computers/runtime-config` (service-token gated,
 * mcpjam-backend `convex/http.ts`) returns the vendor key + terminal-token
 * secret, which this module writes into `process.env` so every downstream
 * consumer (the E2B SDK reads `process.env.E2B_API_KEY` ambiently; the token
 * helpers read their env keys) works unchanged and the cheap synchronous
 * `isComputersDataPlaneConfigured()` gate stays synchronous.
 *
 * Invariants:
 *   - Env always wins: a key is only written when currently unset, so a
 *     hand-set value is never overwritten (the fetch still runs, but applies
 *     nothing it can't overwrite).
 *   - Atomic apply: the whole response must validate (zod) before ANY env key
 *     is written; a malformed payload writes nothing, so the process can
 *     never run on mixed old/new credentials.
 *   - Fail closed, quietly: a 401/404 (old backend) or `enabled: false`
 *     resolves as "nothing to bootstrap" — indistinguishable from today's
 *     unconfigured state. Only network-ish failures are retried (3 attempts
 *     in-flight, then a 60s cooldown before a later caller may re-init).
 *   - The response body is never logged; failures log status codes only.
 *
 * The init/memoized-promise/sync-getter shape deliberately mirrors
 * `remote-data-plane.ts` — see `initComputersStartup` there for ordering
 * (bootstrap MUST resolve before discovery decides whether to delegate).
 */
import { z } from "zod";
import { logger } from "../logger.js";
import {
  getConvexHttpUrl,
  isComputersDataPlaneConfigured,
  markServiceTokenRejected,
} from "./control-plane-client.js";

export const INSPECTOR_SERVICE_TOKEN_HEADER = "x-inspector-service-token";

const FETCH_TIMEOUT_MS = 5_000;
const RETRY_DELAYS_MS = [1_000, 3_000];
const FAILURE_COOLDOWN_MS = 60_000;

const runtimeConfigSchema = z.union([
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true),
    e2bApiKey: z.string().min(1),
    e2bApiUrl: z.string().nullable(),
    e2bDomain: z.string().nullable(),
    e2bTemplateId: z.string().nullable(),
    terminalTokenSecret: z.string().nullable(),
  }),
]);

export function getInspectorServiceToken(): string | null {
  return process.env.INSPECTOR_SERVICE_TOKEN?.trim() || null;
}

/** The env keys bootstrap may fill. No data-plane secret here: the data plane
 *  authenticates to Convex with the service token (control-plane-client
 *  `authHeaders`). */
function applyRuntimeConfigToEnv(config: {
  e2bApiKey: string;
  e2bApiUrl: string | null;
  e2bDomain: string | null;
  e2bTemplateId: string | null;
  terminalTokenSecret: string | null;
}): void {
  const entries: Array<[string, string | null]> = [
    ["E2B_API_KEY", config.e2bApiKey],
    ["E2B_API_URL", config.e2bApiUrl],
    ["E2B_DOMAIN", config.e2bDomain],
    ["E2B_TEMPLATE_ID", config.e2bTemplateId],
    ["COMPUTERS_TERMINAL_TOKEN_SECRET", config.terminalTokenSecret],
  ];
  for (const [key, value] of entries) {
    if (value && !process.env[key]?.trim()) {
      process.env[key] = value;
    }
  }
}

type BootstrapOutcome =
  | "applied"
  | "skipped" // no service token / convex url
  | "unavailable" // backend said enabled:false, or 401/404 (old backend)
  | "failed"; // network-ish; eligible for cooldown re-init

let bootstrapPromise: Promise<BootstrapOutcome> | null = null;
let lastFailureAtMs: number | null = null;

export function resetComputersRuntimeConfigBootstrapForTests(): void {
  bootstrapPromise = null;
  lastFailureAtMs = null;
}

async function fetchRuntimeConfigOnce(
  base: string,
  token: string
): Promise<BootstrapOutcome> {
  let response: Response;
  try {
    response = await fetch(
      new URL("/internal/v1/computers/runtime-config", base).toString(),
      {
        headers: { [INSPECTOR_SERVICE_TOKEN_HEADER]: token },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }
    );
  } catch (error) {
    logger.error(
      "[computers] runtime-config bootstrap network error",
      error instanceof Error ? error.message : String(error)
    );
    return "failed";
  }
  if (response.status === 401 || response.status === 404) {
    // Old backend (no route) or a token this deployment doesn't recognize:
    // nothing to bootstrap — same end state as today's unconfigured server.
    if (response.status === 401) {
      // The token is present but rejected. Mark it so a stray E2B key +
      // terminal secret in env can't make isComputersDataPlaneConfigured()
      // report a working local data plane that every /computers/* call
      // (same auth gate) would then hard-401.
      markServiceTokenRejected();
      logger.warn(
        "[computers] runtime-config bootstrap unavailable (status 401) — " +
          "INSPECTOR_SERVICE_TOKEN does not match this Convex deployment"
      );
    } else {
      logger.warn(
        "[computers] runtime-config bootstrap unavailable (status 404) — " +
          "backend predates the runtime-config route"
      );
    }
    return "unavailable";
  }
  if (!response.ok) {
    logger.error(
      `[computers] runtime-config bootstrap failed (status ${response.status})`
    );
    return "failed";
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    logger.error("[computers] runtime-config bootstrap returned non-JSON");
    return "failed";
  }
  const parsed = runtimeConfigSchema.safeParse(payload);
  if (!parsed.success) {
    // Shape mismatch (never the body itself) — atomic apply means we write
    // nothing rather than a partial credential set.
    logger.error("[computers] runtime-config bootstrap payload failed validation");
    return "failed";
  }
  if (!parsed.data.enabled) {
    return "unavailable";
  }
  applyRuntimeConfigToEnv(parsed.data);
  logger.info("[computers] data-plane credentials bootstrapped from Convex");
  return "applied";
}

async function runBootstrap(sleep: (ms: number) => Promise<void>): Promise<BootstrapOutcome> {
  const token = getInspectorServiceToken();
  if (!token) return "skipped";
  const base = getConvexHttpUrl();
  if (!base) return "skipped";

  for (let attempt = 0; ; attempt += 1) {
    const outcome = await fetchRuntimeConfigOnce(base, token);
    if (outcome !== "failed") return outcome;
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay === undefined) {
      lastFailureAtMs = Date.now();
      return "failed";
    }
    await sleep(delay);
  }
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Kicks off (or joins) the bootstrap. Memoized like
 * `initComputersRemoteDataPlaneDiscovery`; a run that ended in a NETWORK
 * failure becomes eligible to re-init after a 60s cooldown — outcomes that
 * are answers ("skipped", "unavailable", "applied") never re-run.
 */
export function initComputersRuntimeConfigBootstrap(
  deps: { sleep?: (ms: number) => Promise<void> } = {}
): Promise<BootstrapOutcome> {
  if (bootstrapPromise) {
    const promise = bootstrapPromise;
    return promise.then((outcome) => {
      if (
        outcome === "failed" &&
        lastFailureAtMs !== null &&
        Date.now() - lastFailureAtMs >= FAILURE_COOLDOWN_MS &&
        bootstrapPromise === promise
      ) {
        bootstrapPromise = runBootstrap(deps.sleep ?? defaultSleep);
        return bootstrapPromise;
      }
      return outcome;
    });
  }
  bootstrapPromise = runBootstrap(deps.sleep ?? defaultSleep);
  return bootstrapPromise;
}

/**
 * Awaits any in-flight/completed bootstrap (kicking it off if nothing has
 * yet) then answers the sync predicate. Use at call sites whose FIRST answer
 * gets cached (the `/api/web/computers/config` route — the client keeps that
 * response for the whole SPA session) or that can otherwise run before
 * `initComputersStartup` has resolved.
 */
export async function resolveComputersLocalConfigured(): Promise<boolean> {
  await initComputersRuntimeConfigBootstrap();
  return isComputersDataPlaneConfigured();
}
