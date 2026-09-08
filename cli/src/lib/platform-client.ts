import {
  DEFAULT_PLATFORM_API_BASE_URL,
  isPlatformApiError,
  PlatformApiClient,
  RUN_LAUNCH_HEADERS,
} from "@mcpjam/sdk/platform";
import { detectCiMetadata, detectLauncherKind } from "@mcpjam/sdk";
import packageJson from "../../package.json" with { type: "json" };
import { getAuthFilePath, readStoredAuth } from "./auth-store.js";
import { CliError, cliError, usageError } from "./output.js";
import {
  DEFAULT_PLATFORM_ORIGIN,
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

export type ApiUrlInspection =
  | { ok: true; apiUrl: string }
  | { ok: false; error: string };

/**
 * Classify an explicit API URL without throwing. `cloud status` reports the
 * error in-band; other Cloud commands still reject via {@link validateApiUrl}.
 */
export function inspectApiUrl(value: string, source: string): ApiUrlInspection {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return {
      ok: false,
      error: `Invalid ${source} value "${value}". Expected a full URL like ${DEFAULT_PLATFORM_API_BASE_URL}.`,
    };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      error: `Invalid ${source} value "${value}". Expected an http(s) URL like ${DEFAULT_PLATFORM_API_BASE_URL}.`,
    };
  }
  return { ok: true, apiUrl: value };
}

/**
 * An explicitly supplied API URL (flag or env) that does not parse must
 * hard-error: silently falling back to prod would run a login or send a
 * token somewhere the user did not ask for.
 */
export function validateApiUrl(value: string, source: string): string {
  const inspected = inspectApiUrl(value, source);
  if (!inspected.ok) {
    throw usageError(inspected.error);
  }
  return inspected.apiUrl;
}

/** The API URL the user explicitly asked for, if any (flag wins over env). */
function resolveExplicitApiUrl(
  options: Pick<PlatformClientOptions, "apiUrl">,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const flagUrl = options.apiUrl?.trim();
  if (flagUrl) {
    return validateApiUrl(flagUrl, "--api-url");
  }
  const envUrl = env.MCPJAM_API_URL?.trim();
  if (envUrl) {
    return validateApiUrl(envUrl, "MCPJAM_API_URL");
  }
  return undefined;
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
    throw usageError(`${source} has an invalid header name ${JSON.stringify(name)}`);
  }
  if (value.length === 0) {
    throw usageError(`${source} has an empty value for ${JSON.stringify(name)}`);
  }
  // A newline in a value is header injection, not a header. Native fetch
  // rejects it too, but a named error beats a runtime TypeError.
  if (/[\r\n]/.test(value)) {
    throw usageError(`${source} value for ${JSON.stringify(name)} contains a line break`);
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

export function resolvePlatformBaseUrl(
  options: Pick<PlatformClientOptions, "apiUrl">,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveExplicitApiUrl(options, env) ?? DEFAULT_PLATFORM_API_BASE_URL;
}

/** Origin for the hosted CLI auth routes, derived from the API base URL. */
export function resolvePlatformOrigin(
  options: Pick<PlatformClientOptions, "apiUrl">,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return new URL(resolvePlatformBaseUrl(options, env)).origin;
}

export function buildPlatformClient(
  options: PlatformClientOptions,
  deps: ResolveCredentialDependencies = {},
): {
  client: PlatformApiClient;
  credentialKind: "api-key" | "oauth";
  /**
   * The API base URL this client actually resolved, including the stored-auth
   * branch below that `resolvePlatformOrigin` cannot see. Returned so callers
   * that print a web link build it against the SAME deployment the request
   * went to — a staging login must not print prod URLs.
   */
  baseUrl: string;
} {
  const env = deps.env ?? process.env;
  const credential = resolvePlatformCredential(options, deps);
  const extraHeaders = resolvePlatformExtraHeaders(options, env);

  // When the stored OAuth login is the credential, its tokens belong to the
  // deployment it was created against — default to that deployment's API URL
  // so a staging login never silently sends its token to prod.
  let baseUrl = resolveExplicitApiUrl(options, env);
  if (!baseUrl && credential.kind === "oauth") {
    const stored = readStoredAuth(deps.authFilePath ?? getAuthFilePath({ env }));
    baseUrl = stored?.apiUrl;
  }

  const resolvedBaseUrl = baseUrl ?? DEFAULT_PLATFORM_API_BASE_URL;
  const client = new PlatformApiClient({
    baseUrl: resolvedBaseUrl,
    getAuth: credential.getAuth,
    ...(deps.fetchFn ? { fetch: deps.fetchFn } : {}),
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
    userAgent: `mcpjam-cli/${packageJson.version}`,
    // WHAT THIS PROCESS IS, declared on every eval-run launch.
    //
    // The platform stamps `source` itself and everything over the public API
    // is `api`, so a CLI run and a GitHub Actions job were the same badge.
    // `detectLauncherKind` reads `GITHUB_ACTIONS` — the same test
    // `report-conformance-run`'s `detectSource` uses, so a composite run and
    // an eval run from one job never disagree about where they came from.
    //
    // Declared, not proven, and the platform treats it that way: it is a
    // display label beside the stamp, never an authorization input. A secret
    // that could prove it cannot live in a public npm package.
    launcher: {
      kind: detectLauncherKind(env, "cli"),
      client: "mcpjam-cli",
      version: packageJson.version,
    },
    ...(() => {
      const ci = detectCiMetadata(env);
      return ci ? { ci } : {};
    })(),
    ...(extraHeaders ? { extraHeaders } : {}),
  });
  return { client, credentialKind: credential.kind, baseUrl: resolvedBaseUrl };
}

/**
 * The app origin matching an API base URL, for printing web deep links.
 * Falls back to the default origin when the URL is unparseable — a bad link
 * is worse than a slightly wrong one, but neither should abort a command
 * whose real work already succeeded.
 */
export function webOriginForApiBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return DEFAULT_PLATFORM_ORIGIN;
  }
}

/**
 * Map platform API failures onto CLI errors: the stable wire code becomes
 * the CLI error code (exit 1), with login guidance on auth failures.
 */
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

export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) {
    return error;
  }
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
        error.details,
      );
    }
    const message =
      error.code === "UNAUTHORIZED"
        ? `${error.message} Run \`mcpjam cloud login\` or pass a valid sk_ API key.`
        : error.message;
    return cliError(error.code, message, 1, error.details);
  }
  return cliError(
    "INTERNAL_ERROR",
    error instanceof Error ? error.message : String(error),
  );
}
