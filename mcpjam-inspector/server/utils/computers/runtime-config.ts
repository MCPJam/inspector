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
import { HOSTED_MODE } from "../../config.js";
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

/** The backend's verdict on whether the hosted browser may be offered. Absent
 *  on a backend that predates the gate — which is NOT the same as a refusal;
 *  see `isHostedBrowserExposable`. */
const hostedBrowserSchema = z
  .object({
    exposable: z.boolean(),
    reason: z.string().optional(),
    /**
     * Would a desktop actually BOOT (template + rate), independent of the tool
     * catalog? Optional so an older backend that never sends it is stripped
     * rather than rejected — `undefined` reads as "did not say", exactly like
     * an absent `hostedBrowser`.
     */
    desktopProvisionable: z.boolean().optional(),
  })
  .optional();

const runtimeConfigSchema = z.union([
  z.object({ enabled: z.literal(false), hostedBrowser: hostedBrowserSchema }),
  z.object({
    enabled: z.literal(true),
    e2bApiKey: z.string().min(1),
    e2bApiUrl: z.string().nullable(),
    e2bDomain: z.string().nullable(),
    e2bTemplateId: z.string().nullable(),
    terminalTokenSecret: z.string().nullable(),
    hostedBrowser: hostedBrowserSchema,
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
/** null = the backend did not say (old backend, or bootstrap never ran). */
let hostedBrowserExposable: boolean | null = null;
/** null = the backend did not say (old backend, or bootstrap never ran). */
let hostedDesktopProvisionable: boolean | null = null;

export function resetComputersRuntimeConfigBootstrapForTests(): void {
  bootstrapPromise = null;
  lastFailureAtMs = null;
  hostedBrowserExposable = null;
  hostedDesktopProvisionable = null;
}

/**
 * Has the backend said the hosted browser may be offered?
 *
 * Three states, and the difference between two of them matters:
 *
 *   true  — the backend's gate is satisfied (catalog entry, desktop template
 *           and desktop credit rate are all configured).
 *   false — the backend explicitly REFUSED. Honor it: the most likely reason
 *           is that the desktop rate is unset, which would meter every hosted
 *           browser hour at the terminal rate.
 *   null  — the backend did not answer (it predates the gate, or bootstrap has
 *           not run). NOT a refusal, and not a yes: the caller falls back to
 *           its own env flag, which is dark by default anyway. Treating
 *           silence as refusal would break the staging path the flag exists
 *           for; treating it as approval would defeat the gate.
 */
export function isHostedBrowserExposable(): boolean | null {
  return hostedBrowserExposable;
}

/**
 * Would a desktop computer actually boot on this backend?
 *
 * The NARROWER question `isHostedBrowserExposable` cannot answer. That verdict
 * folds in the tool catalog and reports one first-failure reason, so a
 * deployment with the `browser` catalog entry off reads as a flat refusal even
 * when the template and rate are both configured — which is the normal state
 * for an inspector-only rollout, where the model tools stay dark on purpose.
 *
 * Same three states, same rule: `false` is an explicit refusal to honor (the
 * desktop would fail to boot, or would meter at the terminal rate), `null` is
 * silence from a backend that predates the field and is not a refusal.
 */
export function isHostedDesktopProvisionable(): boolean | null {
  return hostedDesktopProvisionable;
}

/**
 * Should this process refuse to offer the hosted browser?
 *
 * The one place that decides what SILENCE means, because the two callers that
 * consult a verdict — the built-in tool registry, and the WebMCP Inspector
 * route — were reading silence differently. They ask different questions and
 * read different verdicts, which is right; what they may not do is disagree
 * about what an ANSWERLESS backend means. See `isHostedDesktopUnavailable`.
 *
 * `false` is always a refusal. `null` divides on deployment mode, and the
 * split is not a hedge:
 *
 *   LOCAL — permission. A local inspector may be pointed at any backend,
 *     including an older one or none at all, and its bootstrap may simply not
 *     have run. Refusing on silence would break the staging path the env flag
 *     exists to serve, and the env flag is already dark by default, so silence
 *     costs nothing there.
 *
 *   HOSTED — refusal. A hosted replica has exactly one backend, which it
 *     bootstraps at boot; silence means that bootstrap failed or the backend
 *     predates the gate. Reading that as permission is how a deployment ends
 *     up billing desktops at the terminal rate because a fetch timed out —
 *     the failure the gate was added to prevent, arriving through the one path
 *     the gate does not cover.
 */
export function isHostedBrowserRefused(): boolean {
  return refusesOnVerdict(isHostedBrowserExposable());
}

/**
 * The same question for the WebMCP Inspector, whose gate is the narrower one.
 *
 * A separate function because the VERDICTS are different questions —
 * "may we advertise `browser_*`?" folds in the tool catalog, "would a desktop
 * boot?" does not — but the rule for SILENCE has to be one rule. It was not:
 * the registry refused on hosted silence while the inspector route read
 * `isHostedDesktopProvisionable() === false` and took silence as permission.
 * So a replica whose bootstrap fetch timed out suppressed the model tools and
 * reserved a desktop for the inspector in the same breath — metering it at the
 * terminal rate, which is the exact failure the gate was added to prevent,
 * arriving through the one caller the gate did not cover.
 */
export function isHostedDesktopUnavailable(): boolean {
  return refusesOnVerdict(isHostedDesktopProvisionable());
}

/** What a three-state verdict means to a caller, per the rule above. */
function refusesOnVerdict(verdict: boolean | null): boolean {
  if (verdict === false) return true;
  return verdict === null && HOSTED_MODE;
}

async function fetchRuntimeConfigOnce(
  base: string,
  token: string,
): Promise<BootstrapOutcome> {
  let response: Response;
  try {
    response = await fetch(
      new URL("/internal/v1/computers/runtime-config", base).toString(),
      {
        headers: { [INSPECTOR_SERVICE_TOKEN_HEADER]: token },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );
  } catch (error) {
    logger.error(
      "[computers] runtime-config bootstrap network error",
      error instanceof Error ? error.message : String(error),
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
          "INSPECTOR_SERVICE_TOKEN does not match this Convex deployment",
      );
    } else {
      logger.warn(
        "[computers] runtime-config bootstrap unavailable (status 404) — " +
          "backend predates the runtime-config route",
      );
    }
    return "unavailable";
  }
  if (!response.ok) {
    logger.error(
      `[computers] runtime-config bootstrap failed (status ${response.status})`,
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
    logger.error(
      "[computers] runtime-config bootstrap payload failed validation",
    );
    return "failed";
  }
  // Record the verdict regardless of `enabled`: a deployment with no vendor
  // key still answers the question, and answering it early keeps the
  // registry's check synchronous.
  if (parsed.data.hostedBrowser) {
    hostedBrowserExposable = parsed.data.hostedBrowser.exposable;
    hostedDesktopProvisionable =
      parsed.data.hostedBrowser.desktopProvisionable ?? null;
    if (!parsed.data.hostedBrowser.exposable) {
      logger.info(
        "[computers] hosted browser is not exposable" +
          (parsed.data.hostedBrowser.reason
            ? `: ${parsed.data.hostedBrowser.reason}`
            : ""),
      );
    }
  }
  if (!parsed.data.enabled) {
    return "unavailable";
  }
  applyRuntimeConfigToEnv(parsed.data);
  logger.info("[computers] data-plane credentials bootstrapped from Convex");
  return "applied";
}

async function runBootstrap(
  sleep: (ms: number) => Promise<void>,
): Promise<BootstrapOutcome> {
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
  deps: { sleep?: (ms: number) => Promise<void> } = {},
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
