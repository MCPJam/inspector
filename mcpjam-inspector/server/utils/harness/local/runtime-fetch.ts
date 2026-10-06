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

const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] as const;

/** The proxy URL in effect, if any (credentials included — redact before showing). */
export function configuredProxy(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const name of PROXY_VARS) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
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
    noProxy: env.NO_PROXY?.trim() || env.no_proxy?.trim() || null,
    extraCaCerts: env.NODE_EXTRA_CA_CERTS?.trim() || null,
  };
}

let agent: EnvHttpProxyAgent | null = null;
let agentFor: string | null = null;

/** `fetch`, through the environment's proxy when one is configured. */
export function installerFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const proxy = configuredProxy();
  if (proxy === null) return fetch(url, init);
  if (agent === null || agentFor !== proxy) {
    agent = new EnvHttpProxyAgent();
    agentFor = proxy;
  }
  return undiciFetch(url, { ...(init as object), dispatcher: agent } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
}
