/**
 * Every network request the runtime installer makes — pack manifests and
 * archives, the revocation list — goes through here, so a machine behind a
 * corporate proxy can install at all.
 *
 *   - `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` (either case) are honoured
 *     through undici's `EnvHttpProxyAgent`. Node's built-in `fetch` ignores
 *     them, which is why an installer that "just used fetch" failed with a
 *     bare `fetch failed` on every proxied network.
 *   - A TLS-inspecting proxy's root certificate is trusted the Node way:
 *     `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`, read by Node at startup (so it
 *     must be in the environment the Inspector starts in, not set later).
 *
 * Without proxy variables this is plain `fetch`.
 */
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

/**
 * The first NON-EMPTY of the named variables. Lowercase first, as curl and
 * undici order them — but an empty value does not count: undici reads
 * `https_proxy` with `??`, so an empty `https_proxy=""` beside a real
 * `HTTPS_PROXY` silently meant "no proxy" and every request went direct.
 */
function firstSet(env: NodeJS.ProcessEnv, names: readonly string[]): string | null {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
}

/** The proxy settings in effect, resolved once here and handed to undici explicitly. */
export function proxySettings(env: NodeJS.ProcessEnv = process.env): {
  httpsProxy: string | null;
  httpProxy: string | null;
  noProxy: string | null;
} {
  return {
    httpsProxy: firstSet(env, ["https_proxy", "HTTPS_PROXY"]),
    httpProxy: firstSet(env, ["http_proxy", "HTTP_PROXY"]),
    noProxy: firstSet(env, ["no_proxy", "NO_PROXY"]),
  };
}

/** The proxy URL in effect, if any (credentials included — redact before showing). */
export function configuredProxy(env: NodeJS.ProcessEnv = process.env): string | null {
  const settings = proxySettings(env);
  return settings.httpsProxy ?? settings.httpProxy;
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

/** What the installer's networking will do, for `harness doctor`. */
export function describeInstallerNetwork(env: NodeJS.ProcessEnv = process.env): {
  proxy: string | null;
  noProxy: string | null;
  extraCaCerts: string | null;
} {
  return {
    proxy: redactProxyUrl(configuredProxy(env)),
    noProxy: proxySettings(env).noProxy,
    extraCaCerts: env.NODE_EXTRA_CA_CERTS?.trim() || null,
  };
}

let agent: EnvHttpProxyAgent | null = null;
let agentFor: string | null = null;

/** `fetch`, through the environment's proxy when one is configured. */
export function installerFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const settings = proxySettings();
  if (settings.httpsProxy === null && settings.httpProxy === null) return fetch(url, init);
  const key = JSON.stringify(settings);
  if (agent === null || agentFor !== key) {
    // Explicit, never left to undici's own environment reading (see firstSet).
    agent = new EnvHttpProxyAgent({
      ...(settings.httpsProxy ? { httpsProxy: settings.httpsProxy } : {}),
      ...(settings.httpProxy ? { httpProxy: settings.httpProxy } : {}),
      noProxy: settings.noProxy ?? "",
    });
    agentFor = key;
  }
  return undiciFetch(url, { ...(init as object), dispatcher: agent } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
}
