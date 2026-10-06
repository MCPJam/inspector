/**
 * The ONE place this server learns whether it holds MCPJam's service
 * credential (`INSPECTOR_SERVICE_TOKEN`).
 *
 * WHY ONE MODULE. The credential used to be read raw at ~45 call sites. Each
 * one decided for itself whether to trim, what to call a missing value, and
 * what "missing" should do: some threw, some sent `x-inspector-service-token:
 * ""` and let the backend answer 401, some swallowed the throw and quietly
 * dropped a feature (org model policy was the worst of these). A self-hosted
 * build, which can never hold this secret, therefore looked healthy and then
 * failed differently per feature. Every reader now goes through here, and
 * `scripts/check-service-credential-reads.mjs` fails CI on a new raw read.
 *
 * WHAT IT DOES NOT DO. It never caches. Every function reads `env` at CALL
 * time (default `process.env`), the same pattern as `server/config.ts`'s
 * functions, because the test suites `vi.stubEnv` this variable per test and a
 * module-level constant would freeze whatever the first import saw.
 *
 * The value itself never leaves this module except as the outbound header a
 * caller asked for. Nothing here logs it, and the capability report below
 * names features, never values.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/** The variable this module owns. Exported for messages, never for reading. */
export const SERVICE_CREDENTIAL_ENV = "INSPECTOR_SERVICE_TOKEN";

/**
 * The header the credential travels in, both directions. Same name as the
 * backend's `convex/lib/serviceToken.ts`. Header names are case-insensitive on
 * the wire, so the lowercase spelling here is the only one the server uses.
 */
export const INSPECTOR_SERVICE_TOKEN_HEADER = "x-inspector-service-token";

/**
 * The shortest credential worth deriving keys from. Below this a derived HMAC
 * key would be brute-forceable, so the crypto consumers
 * (`tool-approval-token.ts`, `history-provenance.ts`) treat a shorter value as
 * absent, and hosted startup (`assessHostedServiceCredential`) reports it.
 */
export const MIN_SERVICE_TOKEN_LENGTH = 16;

type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;

/**
 * The configured credential, trimmed, or `null` when unset or
 * whitespace-only.
 *
 * The trim matters: a secret pasted into a dashboard routinely picks up a
 * trailing newline, and an untrimmed value then mismatches every correctly
 * presented token. Whitespace-only counts as unset because it cannot be the
 * value anyone meant to configure.
 */
export function getServiceCredential(env: Env = process.env): string | null {
  const value = env[SERVICE_CREDENTIAL_ENV]?.trim();
  return value ? value : null;
}

/** True when this process holds a (non-blank) service credential. */
export function hasServiceCredential(env: Env = process.env): boolean {
  return getServiceCredential(env) !== null;
}

/**
 * Human name of the `sk_…` API-key bearer path, shared by every site that
 * needs the credential to act for a key (validation, delegated-token mint,
 * acting-as calls) so the hosted-only answer reads the same everywhere.
 */
export const WORKOS_API_KEY_FEATURE = "Using an MCPJam API key (sk_…)";

/**
 * Thrown by {@link requireServiceCredential}: this process cannot do `feature`
 * because it holds no service credential — the normal state of every
 * self-hosted build (npx, Docker, desktop), never a bug in the request.
 *
 * Routes do not catch this themselves. `mapRuntimeError` turns it into the
 * shared `FEATURE_NOT_SUPPORTED` / `reason: "FEATURE_REQUIRES_HOSTED"` answer
 * (see `hostedOnlyRouteError` in `routes/web/errors.ts`), so the client can
 * say "available in the hosted app" with one piece of copy everywhere.
 */
export class ServiceCredentialUnavailableError extends Error {
  readonly code = "FEATURE_REQUIRES_HOSTED" as const;
  readonly feature: string;

  constructor(feature: string) {
    super(
      `${feature} is only available in the hosted MCPJam app; this Inspector ` +
        "is not connected to MCPJam's hosted services.",
    );
    this.name = "ServiceCredentialUnavailableError";
    this.feature = feature;
  }
}

export function isServiceCredentialUnavailableError(
  error: unknown,
): error is ServiceCredentialUnavailableError {
  return error instanceof ServiceCredentialUnavailableError;
}

/**
 * The credential, or a {@link ServiceCredentialUnavailableError} naming the
 * feature that needed it. `feature` is human copy ("Saving browser profiles"),
 * because it reaches the user verbatim.
 */
export function requireServiceCredential(
  feature: string,
  env: Env = process.env,
): string {
  const credential = getServiceCredential(env);
  if (!credential) throw new ServiceCredentialUnavailableError(feature);
  return credential;
}

/**
 * The outbound header for the credential, or `{}` when there is none.
 *
 * Never `{ "x-inspector-service-token": "" }`. An empty header is a config gap
 * dressed up as a credential; omitting it lets a route that also accepts the
 * user's bearer (eval authoring, org model config) serve the caller on that
 * instead, and lets a route that needs the credential refuse honestly.
 */
export function serviceCredentialHeaders(
  env: Env = process.env,
): Record<string, string> {
  const credential = getServiceCredential(env);
  return credential ? { [INSPECTOR_SERVICE_TOKEN_HEADER]: credential } : {};
}

/**
 * Constant-time equality over SHA-256 digests of both sides.
 *
 * Digesting first is not belt-and-braces: `timingSafeEqual` throws on a length
 * mismatch, so a raw comparison must branch on length first — and that branch
 * leaks the secret's length. Two digests are always 32 bytes.
 */
export function constantTimeTokenEquals(
  presented: string,
  expected: string,
): boolean {
  const left = createHash("sha256").update(presented, "utf8").digest();
  const right = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(left, right);
}

/**
 * True only when this process holds a credential AND `presented` matches it.
 * Fails closed on either side missing: "unconfigured" never means "unguarded".
 */
export function presentedServiceCredentialMatches(
  presented: string | null | undefined,
  env: Env = process.env,
): boolean {
  const configured = getServiceCredential(env);
  const candidate = presented?.trim();
  if (!configured || !candidate) return false;
  return constantTimeTokenEquals(candidate, configured);
}

// ---------------------------------------------------------------------------
// Capabilities: what this process can and cannot do without the credential.
// ---------------------------------------------------------------------------

/**
 * How a credential-backed feature behaves when the credential is absent.
 *
 * - `bearer`: works anyway, on the signed-in user's own bearer (the backend
 *   has a bearer-only twin of the route).
 * - `relay`: works anyway, by handing the request to the hosted app.
 * - `hosted-only`: refuses with the shared hosted-only answer.
 */
export type ServiceCredentialFallback = "bearer" | "relay" | "hosted-only";

export interface ServiceCredentialCapability {
  /** Stable id, shared with the client (`/api/web/capabilities`). */
  id: string;
  /** Human name, used in the boot report. */
  label: string;
  fallback: ServiceCredentialFallback;
  /** Other env this capability needs beyond the credential (names only). */
  alsoRequires?: readonly string[];
}

/**
 * Every feature that consults the credential, and what it does without it.
 * The list is the contract between the boot report, the client capability
 * endpoint, and the code: a feature that grows a credential dependency belongs
 * here so a self-hoster can see what they are not getting.
 */
export const SERVICE_CREDENTIAL_CAPABILITIES: readonly ServiceCredentialCapability[] =
  [
    {
      id: "org-model-config",
      label: "Organization model providers (BYOK)",
      fallback: "bearer",
    },
    { id: "eval-authoring", label: "Eval case authoring", fallback: "bearer" },
    {
      id: "hosted-tasks",
      label: "MCP Tasks recovery index",
      fallback: "bearer",
    },
    {
      id: "api-keys",
      label: "API key management",
      fallback: "relay",
      alsoRequires: ["WORKOS_API_KEY"],
    },
    {
      id: "workos-api-keys",
      label: "MCPJam API keys (sk_…) as bearer",
      fallback: "hosted-only",
      alsoRequires: ["WORKOS_API_KEY"],
    },
    {
      id: "tool-approvals",
      label: "Tool approvals",
      fallback: "hosted-only",
    },
    {
      id: "history-provenance",
      label: "Chat history provenance",
      fallback: "hosted-only",
    },
    {
      id: "browser-profiles",
      label: "Saving browser profiles",
      fallback: "hosted-only",
    },
    {
      id: "replay-video",
      label: "Replay video upload",
      fallback: "hosted-only",
    },
    {
      id: "public-site-relays",
      label: "score / bench / caniuse relays",
      fallback: "hosted-only",
    },
    {
      id: "surface-links",
      label: "Slack and Discord account linking",
      fallback: "hosted-only",
    },
    {
      id: "server-connections",
      label: "Server connection handoff",
      fallback: "hosted-only",
    },
    {
      id: "hosted-elicitation",
      label: "Hosted elicitation",
      fallback: "hosted-only",
    },
    {
      id: "xaa-dcr",
      label: "XAA client registration",
      fallback: "hosted-only",
    },
    { id: "agent", label: "Agent endpoint", fallback: "hosted-only" },
    {
      id: "cloud-computers",
      label: "Cloud computers, harness and sandbox evals",
      fallback: "hosted-only",
    },
    {
      id: "eval-trace-audit",
      label: "Eval trace-read audit",
      fallback: "hosted-only",
    },
    {
      id: "workers",
      label: "Background workers (scheduled evals, checks, bench)",
      fallback: "hosted-only",
    },
  ];

export interface ServiceCredentialReport {
  credential: "present" | "absent";
  /** Capabilities that run with full (credentialed) behaviour. */
  on: string[];
  /** Capabilities that keep working without the credential, and how. */
  degraded: {
    id: string;
    via: Exclude<ServiceCredentialFallback, "hosted-only">;
  }[];
  /** Capabilities that refuse with the hosted-only answer. */
  off: string[];
}

function envPresent(env: Env, name: string): boolean {
  return Boolean(env[name]?.trim());
}

/** Is `capability` fully available in this process? */
export function isCapabilityFullyAvailable(
  capability: ServiceCredentialCapability,
  env: Env = process.env,
): boolean {
  return (
    hasServiceCredential(env) &&
    (capability.alsoRequires ?? []).every((name) => envPresent(env, name))
  );
}

export function describeServiceCredentialCapabilities(
  env: Env = process.env,
): ServiceCredentialReport {
  const report: ServiceCredentialReport = {
    credential: hasServiceCredential(env) ? "present" : "absent",
    on: [],
    degraded: [],
    off: [],
  };
  for (const capability of SERVICE_CREDENTIAL_CAPABILITIES) {
    if (isCapabilityFullyAvailable(capability, env)) {
      report.on.push(capability.id);
    } else if (capability.fallback === "hosted-only") {
      report.off.push(capability.id);
    } else {
      report.degraded.push({ id: capability.id, via: capability.fallback });
    }
  }
  return report;
}

/**
 * One line for the boot log: which credential-backed capabilities are on for
 * this process. Names only — never a value, never a length.
 */
export function formatServiceCredentialReport(
  report: ServiceCredentialReport,
): string {
  const parts = [`[service-credential] credential=${report.credential}`];
  if (report.on.length) parts.push(`ON: ${report.on.join(", ")}`);
  if (report.degraded.length) {
    parts.push(
      `WITHOUT CREDENTIAL: ${report.degraded
        .map(({ id, via }) => `${id} (via ${via})`)
        .join(", ")}`,
    );
  }
  if (report.off.length)
    parts.push(`OFF (hosted-only): ${report.off.join(", ")}`);
  return parts.join("; ");
}

// ---------------------------------------------------------------------------
// Hosted deployments must not boot half-configured.
// ---------------------------------------------------------------------------

export type HostedServiceCredentialProblem = "missing" | "too-short";

/**
 * What is wrong with a HOSTED deployment's credential, or `null` when nothing
 * is. A hosted replica without it silently loses tool approvals and hides all
 * prior assistant content from the model (history provenance), so this is a
 * deploy-time failure, not a per-request one.
 */
export function assessHostedServiceCredential(
  env: Env = process.env,
): HostedServiceCredentialProblem | null {
  const credential = getServiceCredential(env);
  if (!credential) return "missing";
  if (credential.length < MIN_SERVICE_TOKEN_LENGTH) return "too-short";
  return null;
}

/**
 * Opt-in strict mode for {@link enforceHostedServiceCredential}. One release
 * logs loudly; flipping `MCPJAM_REQUIRE_SERVICE_CREDENTIAL=true` (and, a
 * release later, the default) makes the same condition fail startup.
 */
export function isServiceCredentialStrict(env: Env = process.env): boolean {
  return env.MCPJAM_REQUIRE_SERVICE_CREDENTIAL?.trim() === "true";
}

export class HostedServiceCredentialError extends Error {
  readonly problem: HostedServiceCredentialProblem;
  constructor(problem: HostedServiceCredentialProblem) {
    super(
      problem === "missing"
        ? `Hosted mode requires ${SERVICE_CREDENTIAL_ENV}; refusing to start half-configured.`
        : `Hosted mode requires ${SERVICE_CREDENTIAL_ENV} of at least ${MIN_SERVICE_TOKEN_LENGTH} characters; refusing to start.`,
    );
    this.name = "HostedServiceCredentialError";
    this.problem = problem;
  }
}

/**
 * Startup check for hosted mode. Returns the problem it found (after calling
 * `onProblem` with a loud message), throws {@link HostedServiceCredentialError}
 * instead when strict mode is on, and does nothing outside hosted mode.
 */
export function enforceHostedServiceCredential(options: {
  hosted: boolean;
  env?: Env;
  onProblem: (message: string) => void;
}): HostedServiceCredentialProblem | null {
  if (!options.hosted) return null;
  const env = options.env ?? process.env;
  const problem = assessHostedServiceCredential(env);
  if (!problem) return null;
  if (isServiceCredentialStrict(env)) {
    throw new HostedServiceCredentialError(problem);
  }
  options.onProblem(
    `${new HostedServiceCredentialError(problem).message
      .replace("; refusing to start half-configured.", "")
      .replace("; refusing to start.", "")} Tool approvals and chat history ` +
      "provenance are disabled on this replica. This will fail startup in a " +
      "future release; set MCPJAM_REQUIRE_SERVICE_CREDENTIAL=true to fail now.",
  );
  return problem;
}
