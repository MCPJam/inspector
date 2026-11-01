/**
 * The parts of "which MCPJam server" that every runtime shares: the one MCPJam
 * Cloud default, parsing and normalizing a server address, the environment
 * alias, and the redirect rule for MCPJam API requests.
 *
 * Pure and browser-safe. It reads no environment of its own (callers pass
 * `env`) and imports nothing from Node, so the browser, worker and
 * model-factory bundles can include it. The order between sources, the saved
 * login and the IT file live in `resolve.ts`, which is Node-only.
 */
import { SdkError } from "../errors.js";

/** MCPJam Cloud: the server every caller uses when nothing names another. */
export const MCPJAM_CLOUD_BASE_URL = "https://app.mcpjam.com";
export const MCPJAM_CLOUD_API_URL = `${MCPJAM_CLOUD_BASE_URL}/api/v1`;

const API_PATH = "/api/v1";

/** One MCPJam server, spelled the two ways callers use it. */
export interface DeploymentAddress {
  /** `https://host/api/v1`: what `--api-url` and the platform client take. */
  apiUrl: string;
  /** `apiUrl` without `/api/v1`: the base SDK modules append `/api/v1/…` to. */
  baseUrl: string;
}

export const MCPJAM_CLOUD: Readonly<DeploymentAddress> = Object.freeze({
  apiUrl: MCPJAM_CLOUD_API_URL,
  baseUrl: MCPJAM_CLOUD_BASE_URL,
});

/** Where the chosen server came from. `managed` means locked by IT. */
export type DeploymentSource =
  "managed" | "flag" | "env" | "oauth" | "managed-default" | "default";

export type DeploymentErrorCode =
  | "API_URL_INVALID"
  | "DEPLOYMENT_CONFLICT"
  | "DEPLOYMENT_LOCKED"
  | "MANAGED_SETTINGS_INVALID"
  | "LOGIN_DEPLOYMENT_MISMATCH"
  | "BACKEND_REDIRECT_REFUSED";

/**
 * The SDK ships each entry point as its own bundle, each with its own copy of
 * this class, so `instanceof` fails between them. The registered symbol does
 * not, which is what {@link isMcpjamDeploymentError} checks.
 */
const DEPLOYMENT_ERROR_BRAND = Symbol.for("mcpjam.deploymentError");

/**
 * A refusal because of where a request would go. Every code except
 * `BACKEND_REDIRECT_REFUSED` is raised before the first request is sent; that
 * one is raised instead of following the redirect.
 */
export class McpjamDeploymentError extends SdkError {
  declare readonly code: DeploymentErrorCode;
  readonly [DEPLOYMENT_ERROR_BRAND] = true;
  /** The address and source the refusal is about, for status reports. */
  readonly apiUrl?: string;
  readonly source?: DeploymentSource;

  constructor(
    code: DeploymentErrorCode,
    message: string,
    about: { apiUrl?: string; source?: DeploymentSource } = {}
  ) {
    super(message, code);
    this.name = "McpjamDeploymentError";
    this.apiUrl = about.apiUrl;
    this.source = about.source;
  }
}

export function isMcpjamDeploymentError(
  value: unknown
): value is McpjamDeploymentError {
  return (
    typeof value === "object" &&
    value !== null &&
    DEPLOYMENT_ERROR_BRAND in value
  );
}

/**
 * `value` without its trailing slashes. Written as a loop because
 * `/\/+$/` is rated a polynomial-time regex on input like `"a" + "/".repeat(n)`.
 */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

type Normalized = { ok: true; url: string } | { ok: false; problem: string };

/**
 * Scheme and host lowercased, the default port dropped, trailing slashes
 * removed: two spellings of one server compare equal after this.
 */
function normalize(value: string, example: string): Normalized {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { ok: false, problem: `Expected a full URL like ${example}.` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, problem: `Expected an http(s) URL like ${example}.` };
  }
  if (url.username || url.password || url.search || url.hash) {
    return {
      ok: false,
      problem: `Expected a server address with no credentials, query or fragment, like ${example}.`,
    };
  }
  return { ok: true, url: `${url.origin}${trimTrailingSlashes(url.pathname)}` };
}

function fromApiUrl(apiUrl: string): DeploymentAddress {
  return {
    apiUrl,
    // Stripped exactly once: a server under a path prefix keeps its prefix.
    baseUrl: apiUrl.endsWith(API_PATH)
      ? apiUrl.slice(0, -API_PATH.length)
      : apiUrl,
  };
}

/**
 * The rejected value as a refusal may print it. Addresses are often pasted
 * from a secret store or a CI variable, so credentials, a query and a
 * fragment are masked, and a value that is not a URL with a host, such as an
 * API key in the wrong variable, is not repeated at all.
 */
export function printableAddress(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (!url.host) return undefined;
  const userinfo = url.username || url.password ? "***@" : "";
  const query = url.search ? "?***" : "";
  const fragment = url.hash ? "#***" : "";
  return `${url.protocol}//${userinfo}${url.host}${url.pathname}${query}${fragment}`;
}

function invalid(
  label: string,
  value: string,
  problem: string,
  source?: DeploymentSource
) {
  const shown = printableAddress(value);
  return new McpjamDeploymentError(
    "API_URL_INVALID",
    `Invalid ${label} value${shown ? ` "${shown}"` : ""}. ${problem}`,
    { apiUrl: shown ?? "", ...(source ? { source } : {}) }
  );
}

/**
 * An API base such as `--api-url`, named `label` in the error. Throws
 * `API_URL_INVALID`.
 */
export function parseApiUrl(
  value: string,
  label: string,
  source?: DeploymentSource
): DeploymentAddress {
  const normalized = normalize(value, MCPJAM_CLOUD_API_URL);
  if (!normalized.ok) throw invalid(label, value, normalized.problem, source);
  return fromApiUrl(normalized.url);
}

/** An app base such as `MCPJAM_BASE_URL`. Throws `API_URL_INVALID`. */
export function parseBaseUrl(
  value: string,
  label: string,
  source?: DeploymentSource
): DeploymentAddress {
  const normalized = normalize(value, MCPJAM_CLOUD_BASE_URL);
  if (!normalized.ok) throw invalid(label, value, normalized.problem, source);
  return { apiUrl: `${normalized.url}${API_PATH}`, baseUrl: normalized.url };
}

/** {@link parseApiUrl} for a stored value, which reports no error. */
export function tryParseApiUrl(value: string): DeploymentAddress | undefined {
  const normalized = normalize(value, MCPJAM_CLOUD_API_URL);
  return normalized.ok ? fromApiUrl(normalized.url) : undefined;
}

/** Whether two addresses name the same server, `/api/v1` spelled or not. */
export function sameServer(
  left: DeploymentAddress,
  right: DeploymentAddress
): boolean {
  return left.baseUrl === right.baseUrl;
}

export type DeploymentEnv = Readonly<Record<string, string | undefined>>;

/**
 * The server the environment names. `MCPJAM_BASE_URL` is the older spelling
 * of `MCPJAM_API_URL` without `/api/v1`; naming two different servers is a
 * refusal (`DEPLOYMENT_CONFLICT`), never a silent pick of one.
 */
export function deploymentFromEnv(
  env: DeploymentEnv
): DeploymentAddress | undefined {
  const apiValue = env.MCPJAM_API_URL?.trim();
  const baseValue = env.MCPJAM_BASE_URL?.trim();
  const api = apiValue
    ? parseApiUrl(apiValue, "MCPJAM_API_URL", "env")
    : undefined;
  const base = baseValue
    ? parseBaseUrl(baseValue, "MCPJAM_BASE_URL", "env")
    : undefined;
  if (api && base && !sameServer(api, base)) {
    throw new McpjamDeploymentError(
      "DEPLOYMENT_CONFLICT",
      `MCPJAM_API_URL (${api.apiUrl}) and MCPJAM_BASE_URL (${base.baseUrl}) name different MCPJam servers. Unset one of them, or point both at the same server.`,
      { apiUrl: api.apiUrl, source: "env" }
    );
  }
  return api ?? base;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function redirectTarget(response: Response, requested: URL): string {
  const location = response.headers.get("location");
  if (!location || !URL.canParse(location, requested)) return "";
  // The origin only: a sign-in redirect's query can carry a one-time state.
  return ` to ${new URL(location, requested).origin}`;
}

/**
 * `fetch` for requests to MCPJam's own API, which refuses any redirect
 * instead of following it.
 *
 * Node's `fetch` drops `Authorization` on a cross-origin redirect but keeps
 * custom headers, so following one would hand `--api-header` values to
 * whatever host the response names. No `/api/v1` route redirects, so a 3xx
 * means the address points at something other than the API.
 */
export function backendFetch(fetchImpl?: typeof fetch): typeof fetch {
  const send: typeof fetch =
    fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  return async (input, init) => {
    const response = await send(input, { ...init, redirect: "manual" });
    const redirected =
      response.type === "opaqueredirect" ||
      (response.status >= 300 && response.status < 400);
    if (!redirected) return response;
    const requested = new URL(requestUrl(input));
    const target = redirectTarget(response, requested);
    try {
      await response.body?.cancel();
    } catch {
      // The redirect is refused either way; a body that cannot be cancelled
      // is released with the response.
    }
    throw new McpjamDeploymentError(
      "BACKEND_REDIRECT_REFUSED",
      `MCPJam at ${requested.origin} answered ${requested.pathname} with a redirect${target}, which MCPJam requests never follow. Check that the server address points at the MCPJam API.`,
      { apiUrl: requested.origin }
    );
  };
}
