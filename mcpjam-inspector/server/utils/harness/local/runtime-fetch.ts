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
import {
  proxySettings,
  redactProxyUrl,
} from "@mcpjam/sdk/internal/network-proxy";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

/** The proxy URL in effect, if any (credentials included — redact before showing). */
export function configuredProxy(env: NodeJS.ProcessEnv = process.env): string | null {
  const settings = proxySettings(env);
  return settings.httpsProxy ?? settings.httpProxy;
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
