/**
 * Proxy settings from the environment, shared by the CLI and the Inspector's
 * runtime installer: `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`, either case.
 * Published as `@mcpjam/sdk/internal/network-proxy` with no public API
 * promise. As a library the SDK never changes the process-wide proxy itself.
 */

export interface ProxySettings {
  httpsProxy: string | null;
  httpProxy: string | null;
  noProxy: string | null;
}

/**
 * The first NON-EMPTY of the named variables. Lowercase first, as curl and
 * undici order them, but an empty value does not count: undici reads
 * `https_proxy` with `??`, so an empty `https_proxy=""` beside a real
 * `HTTPS_PROXY` silently meant "no proxy" and every request went direct.
 */
function firstSet(
  env: NodeJS.ProcessEnv,
  names: readonly string[]
): string | null {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
}

/** The proxy settings in effect, resolved once and handed to undici explicitly. */
export function proxySettings(
  env: NodeJS.ProcessEnv = process.env
): ProxySettings {
  return {
    httpsProxy: firstSet(env, ["https_proxy", "HTTPS_PROXY"]),
    httpProxy: firstSet(env, ["http_proxy", "HTTP_PROXY"]),
    noProxy: firstSet(env, ["no_proxy", "NO_PROXY"]),
  };
}

/** A proxy URL fit to print: user and password removed. */
export function redactProxyUrl(url: string | null): string | null {
  if (url === null) return null;
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = "***";
      parsed.password = "";
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url.replace(/\/\/[^@/]*@/, "//***@");
  }
}
