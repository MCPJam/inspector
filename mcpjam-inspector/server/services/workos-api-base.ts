/**
 * Where this server sends its WorkOS traffic.
 *
 * Production reads nothing here: with `WORKOS_API_BASE_URL` unset every caller
 * resolves to `https://api.workos.com` and behaves exactly as it did before
 * this module existed. The variable exists so a test can point the server at a
 * local `@workos/emulate` instance and exercise the AuthKit proxy, API-key
 * validation and key management against a real API surface.
 *
 * LOOPBACK ONLY, and here that rule earns its keep more than anywhere else in
 * the codebase. Every management call carries `WORKOS_API_KEY` — the admin key
 * — in an `Authorization` header, and preview environments on Railway are
 * duplicated from staging wholesale (`pr-preview.yml`), while
 * `railway-set-vars.sh` can only set a variable and never unset one. So a value
 * set once on staging would propagate to every future preview with no way to
 * withdraw it. The only durable defence is refusing the value here.
 *
 * Rejecting a path or query is not pedantry: callers append their own paths to
 * `baseUrl`, and the SDK composes `${protocol}://${apiHostname}[:${port}]` and
 * drops everything else, so a base URL with a path would be silently truncated
 * in one caller and doubled in another.
 *
 * NOT to be confused with `WORKOS_API_HOSTNAME` (server/env.ts), which is a
 * BROWSER-facing hostname serialized into `window.__MCP_RUNTIME_CONFIG__` for
 * `@workos-inc/authkit-js`. This one is server-only and must never be added to
 * `InspectorClientRuntimeConfig`.
 */

export const DEFAULT_WORKOS_API_BASE_URL = "https://api.workos.com";

/** `[::1]` keeps its brackets — that is what `URL.hostname` reports. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The subset of `WorkOSOptions` that redirects the SDK at another host. */
export interface WorkosSdkHostOptions {
  apiHostname: string;
  https: boolean;
  port?: number;
}

export interface ResolvedWorkosApiBase {
  /** Origin, never with a trailing slash; callers concatenate paths onto it. */
  baseUrl: string;
  /**
   * Options for `new WorkOS(key, options)`, or `undefined` when the override is
   * unset — the client is then constructed with no options at all, so the
   * default path is byte-for-byte what it was.
   */
  sdkOptions?: WorkosSdkHostOptions;
}

function reject(value: string): never {
  throw new Error(
    `WORKOS_API_BASE_URL must be a loopback http(s) origin such as ` +
      `http://127.0.0.1:4820 (got "${value}")`,
  );
}

export function resolveWorkosApiBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedWorkosApiBase {
  const raw = env.WORKOS_API_BASE_URL?.trim();
  if (!raw) {
    return { baseUrl: DEFAULT_WORKOS_API_BASE_URL };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    reject(raw);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") reject(raw);
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) reject(raw);
  if (url.pathname !== "/") reject(raw);
  if (url.search || url.hash) reject(raw);
  if (url.username || url.password) reject(raw);

  return {
    baseUrl: url.origin,
    sdkOptions: {
      apiHostname: url.hostname,
      https: url.protocol === "https:",
      // '' for a protocol-default port; `Number('')` is 0, which the SDK would
      // dutifully append as `:0`.
      port: url.port ? Number(url.port) : undefined,
    },
  };
}
