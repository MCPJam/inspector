import {
  describePlatformRefusal,
  isPlatformApiError,
  PlatformApiClient,
  platformRefusalHint,
  RUN_LAUNCH_HEADERS,
  type PlatformApiError,
} from "@mcpjam/sdk/platform";
import { detectCiMetadata } from "@mcpjam/sdk";
import {
  backendFetch,
  isMcpjamDeploymentError,
  resolveDeployment,
  type DeploymentCredential,
  type ResolvedDeployment,
} from "@mcpjam/sdk/internal/deployment";
import { readFileSync } from "node:fs";
import packageJson from "../../package.json" with { type: "json" };
import {
  CliError,
  cliError,
  deploymentCliError,
  deploymentRefusalOf,
  usageError,
} from "./output.js";
import {
  resolvePlatformCredential,
  type ResolveCredentialDependencies,
} from "./platform-auth.js";

export interface PlatformClientOptions {
  apiKey?: string;
  apiUrl?: string;
  /** Repeatable `Name: value` headers for an edge authenticator in front. */
  apiHeader?: string[];
  timeoutMs?: number;
}

function readGithubEvent(env: NodeJS.ProcessEnv): string | undefined {
  if (!env.GITHUB_EVENT_PATH) return undefined;
  try {
    const payload = readFileSync(env.GITHUB_EVENT_PATH, "utf8");
    JSON.parse(payload);
    return payload;
  } catch {
    return undefined;
  }
}

/**
 * The MCPJam server for this command, as the SDK resolver decides it, with its
 * refusals as CLI errors. An address that does not parse is a hard error:
 * falling back to MCPJam Cloud would run a login or send a token somewhere the
 * user did not ask for.
 */
export function resolveCliDeployment(
  input: {
    apiUrl?: string;
    apiUrlLabel?: string;
    credential: DeploymentCredential;
  },
  deps: { env?: NodeJS.ProcessEnv; authFilePath?: string } = {},
): ResolvedDeployment {
  try {
    return resolveDeployment({ ...input, ...deps });
  } catch (error) {
    throw isMcpjamDeploymentError(error) ? deploymentCliError(error) : error;
  }
}

/**
 * Headers this client derives from its own contract. A caller that supplies
 * one is not customizing a request — it is trying to replace the credential,
 * the retry key, or the body's own description, and each would break a
 * guarantee something else depends on. Rejected loudly at the boundary rather
 * than dropped quietly, so the caller learns the flag did nothing.
 *
 * `PlatformApiClient` also spreads extras BEFORE its own headers, so this list
 * is the readable half of a defence the transport enforces regardless.
 */
const RESERVED_HEADER_NAMES = new Set([
  "authorization",
  "idempotency-key",
  "content-type",
  // The run's DECLARED origin, which this client sets from the environment. A
  // `--header` that could overwrite it would let a badge be forged from a flag
  // — which is exactly why the platform's own `source` is stamped server-side
  // and why `user-agent`-derived attribution was removed as forgeable.
  RUN_LAUNCH_HEADERS.launcher,
  RUN_LAUNCH_HEADERS.ci,
]);

/** RFC 7230 token. Anything else cannot be a header name. */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Parse one `Name: value` header. Split on the FIRST colon only — values
 * legitimately contain colons (a URL, a timestamp), and splitting on all of
 * them would corrupt them silently.
 */
function parseHeader(raw: string, source: string): [string, string] {
  const separator = raw.indexOf(":");
  if (separator < 1) {
    throw usageError(
      `${source} must be "Name: value" — got ${JSON.stringify(raw)}`,
    );
  }
  const name = raw.slice(0, separator).trim();
  const value = raw.slice(separator + 1).trim();
  if (!HEADER_NAME_RE.test(name)) {
    throw usageError(
      `${source} has an invalid header name ${JSON.stringify(name)}`,
    );
  }
  if (value.length === 0) {
    throw usageError(
      `${source} has an empty value for ${JSON.stringify(name)}`,
    );
  }
  // A newline in a value is header injection, not a header. Native fetch
  // rejects it too, but a named error beats a runtime TypeError.
  if (/[\r\n]/.test(value)) {
    throw usageError(
      `${source} value for ${JSON.stringify(name)} contains a line break`,
    );
  }
  const lower = name.toLowerCase();
  if (RESERVED_HEADER_NAMES.has(lower)) {
    throw usageError(
      `${source} cannot set ${JSON.stringify(name)} — the CLI derives it from the credential, the request, or the environment`,
    );
  }
  return [lower, value];
}

/**
 * Extra request headers for a deployment behind an edge authenticator.
 *
 * Flag and env COMBINE rather than one winning: CI supplies the machine
 * credential through the environment (so it stays out of `ps` and shell
 * history) while a developer adds a one-off header on the command line, and
 * needing both is the normal case rather than a conflict. A name given twice
 * takes the flag's value, since that is the more specific of the two.
 */
export function resolvePlatformExtraHeaders(
  options: Pick<PlatformClientOptions, "apiHeader">,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  for (const line of (env.MCPJAM_API_HEADERS ?? "").split("\n")) {
    if (line.trim().length === 0) continue;
    const [name, value] = parseHeader(line, "MCPJAM_API_HEADERS");
    headers[name] = value;
  }
  for (const raw of options.apiHeader ?? []) {
    const [name, value] = parseHeader(raw, "--api-header");
    headers[name] = value;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export function buildPlatformClient(
  options: PlatformClientOptions,
  deps: ResolveCredentialDependencies = {},
): {
  client: PlatformApiClient;
  credentialKind: "api-key" | "oauth";
  /**
   * The API base URL this client sends to. Returned so callers that print a
   * web link build it against the SAME deployment the request went to: a
   * staging login must not print prod URLs.
   */
  baseUrl: string;
  /** The app base, from the resolver's one rule for stripping `/api/v1`. */
  appBaseUrl: string;
} {
  const env = deps.env ?? process.env;
  const credential = resolvePlatformCredential(options, deps);
  const extraHeaders = resolvePlatformExtraHeaders(options, env);
  // A saved login is sent only to the server it was made against; the
  // resolver refuses any other before this client is built.
  const deployment = resolveCliDeployment(
    { apiUrl: options.apiUrl, credential: credential.kind },
    { env, ...(deps.authFilePath ? { authFilePath: deps.authFilePath } : {}) },
  );

  const client = new PlatformApiClient({
    baseUrl: deployment.apiUrl,
    getAuth: credential.getAuth,
    fetch: backendFetch(deps.fetchFn),
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
    userAgent: `mcpjam-cli/${packageJson.version}`,
    // WHAT THIS PROCESS IS, declared on every eval-run launch.
    //
    // The platform stamps `source` itself and everything over the public API
    // is `api`, so a CLI run and a GitHub Actions job were the same badge.
    // ALWAYS `cli`, even inside CI. This used to be
    // `detectLauncherKind(env, "cli")`, which declared `github_action` from a
    // workflow — and in the runs table `GitHub` means the GitHub App: a check
    // run we built and ran ourselves. A `mcpjam cloud eval run` in someone's
    // own workflow is not that. It borrowed the App's badge and gave up its
    // own, so the CLI chip never returned it.
    //
    // Where it ran is still recorded, in the `ci` envelope below.
    //
    // Declared, not proven, and the platform treats it that way: it is a
    // display label beside the stamp, never an authorization input. A secret
    // that could prove it cannot live in a public npm package.
    launcher: {
      kind: "cli",
      client: "mcpjam-cli",
      version: packageJson.version,
    },
    ...(() => {
      const githubEvent = readGithubEvent(env);
      const ci = detectCiMetadata(
        githubEvent
          ? { ...env, MCPJAM_GITHUB_EVENT_PAYLOAD: githubEvent }
          : env,
      );
      return ci ? { ci } : {};
    })(),
    ...(extraHeaders ? { extraHeaders } : {}),
  });
  return {
    client,
    credentialKind: credential.kind,
    baseUrl: deployment.apiUrl,
    appBaseUrl: deployment.baseUrl,
  };
}

/**
 * Whether a platform refusal is the CI-owned suite lock.
 *
 * Reads `details.reason`, which is the platform's stable code, rather than the
 * HTTP status or the message: 409 also covers genuine races, and matching on
 * copy would break the first time somebody improved the sentence.
 */
function ciOwnedSuiteReason(details: unknown): boolean {
  return (
    typeof details === "object" &&
    details !== null &&
    (details as { reason?: unknown }).reason === "CI_OWNED_SUITE_READ_ONLY"
  );
}

/**
 * The failing request's id, carried in `details` (the JSON a script reads) so
 * a bug report can quote the id the API logged that request under. Client-side
 * failures (network, timeout) never reached the API and carry none.
 */
function withRequestId(
  details: Record<string, unknown> | undefined,
  requestId: string | undefined,
): Record<string, unknown> | undefined {
  return requestId ? { ...(details ?? {}), requestId } : details;
}

/** Failures that may be MCPJam's own fault, and so worth reporting. */
const REPORTABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  "INTERNAL_ERROR",
  "FEATURE_NOT_SUPPORTED",
]);

/**
 * The gateway in front of the platform, or the user's own server behind it,
 * failing: an envelope-less 502 still decodes as `INTERNAL_ERROR`, but it is
 * not a platform bug worth a report.
 */
const GATEWAY_FAILURE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

const FEEDBACK_COMMAND = "cloud feedback";

/**
 * The ready-to-run report command for a platform fault, or nothing.
 *
 * Only with a request id — a report without one cannot be joined to the
 * server's logs, and the id is the reason to report from the terminal rather
 * than later — and never on `cloud feedback` itself.
 */
function feedbackHint(
  error: PlatformApiError,
  command: string | undefined,
): string | undefined {
  if (command === FEEDBACK_COMMAND) return undefined;
  if (!error.requestId) return undefined;
  if (!REPORTABLE_ERROR_CODES.has(error.code)) return undefined;
  if (GATEWAY_FAILURE_STATUSES.has(error.status)) return undefined;
  const kind =
    error.code === "FEATURE_NOT_SUPPORTED" ? "missing_capability" : "bug";
  return `Report it: \`mcpjam cloud feedback --kind ${kind} --request-id ${error.requestId} --summary "…"\``;
}

/**
 * Map platform API failures onto CLI errors: the stable wire code becomes
 * the CLI error code (exit 1), with login guidance on auth failures.
 *
 * `command` is the failing command's path (`cloud eval run`), when the caller
 * knows it.
 */
export function toCliError(
  error: unknown,
  context: { command?: string } = {},
): CliError {
  if (error instanceof CliError) {
    return error;
  }
  const refusal = deploymentRefusalOf(error);
  if (refusal) return deploymentCliError(refusal);
  if (isPlatformApiError(error)) {
    // The CI-owned suite lock. `CONFLICT` alone reads like a race the caller
    // should retry, which is the one thing that will never help here: the
    // suite's configuration lives somewhere else. Re-coded and re-worded so
    // the terminal says what to do, and detected on the platform's stable
    // `reason` rather than on the prose.
    if (ciOwnedSuiteReason(error.details)) {
      return cliError(
        "CI_OWNED_SUITE_READ_ONLY",
        `${error.message} If this run is syncing a suite file, make sure the file's ` +
          "`suite.id` still matches the suite it created — a renamed id no longer owns it.",
        1,
        withRequestId(error.details, error.requestId),
      );
    }
    // A usage-limit refusal keeps its exit code and wire code (it is not an
    // auth or credit failure), but says when to come back and whether credits
    // would help, and carries `retryAfterSeconds` into the JSON `details` so a
    // script can wait instead of parsing prose.
    const refusal = describePlatformRefusal(error);
    if (refusal) {
      return cliError(
        error.code,
        `${error.message} ${platformRefusalHint(refusal)}`,
        1,
        withRequestId({ ...(error.details ?? {}), refusal }, error.requestId),
      );
    }
    const hint = feedbackHint(error, context.command);
    const message =
      error.code === "UNAUTHORIZED"
        ? `${error.message} Run \`mcpjam cloud login\` or pass a valid sk_ API key.`
        : hint
          ? `${error.message} ${hint}`
          : error.message;
    return cliError(
      error.code,
      message,
      1,
      withRequestId(error.details, error.requestId),
    );
  }
  return cliError(
    "INTERNAL_ERROR",
    error instanceof Error ? error.message : String(error),
  );
}
