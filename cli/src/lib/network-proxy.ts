/**
 * The corporate proxy, for the CLI process and the update check it starts.
 *
 * Node's `fetch` ignores `HTTPS_PROXY` / `HTTP_PROXY` unless the process was
 * started with `NODE_USE_ENV_PROXY=1`, which the CLI cannot set for itself
 * once it is running. So the CLI entry point installs undici's
 * `EnvHttpProxyAgent` as the global dispatcher instead, and gives the update
 * check, a separate short-lived process, Node's own proxy support. Loopback
 * always connects directly, so local MCP servers and the local Inspector keep
 * working behind a proxy.
 */
import { proxySettings } from "@mcpjam/sdk/internal/network-proxy";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

/**
 * Bracketed `[::1]`, because undici reads a bare `::1` in NO_PROXY as host
 * `:` on port 1.
 */
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

function noProxyWithLoopback(noProxy: string | null): string {
  return [...(noProxy ? [noProxy] : []), ...LOOPBACK].join(",");
}

/**
 * Routes every `fetch` this process makes through the configured proxy.
 * Called by the CLI entry point only: a program that embeds the CLI's `main`
 * keeps its own process-wide networking.
 */
export function installProxyDispatcher(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const settings = proxySettings(env);
  if (!settings.httpsProxy && !settings.httpProxy) return false;
  setGlobalDispatcher(
    new EnvHttpProxyAgent({
      ...(settings.httpsProxy ? { httpsProxy: settings.httpsProxy } : {}),
      ...(settings.httpProxy ? { httpProxy: settings.httpProxy } : {}),
      noProxy: noProxyWithLoopback(settings.noProxy),
    })
  );
  return true;
}

/**
 * Whether Node routes `http` and `https` requests through the environment's
 * proxy when started with `NODE_USE_ENV_PROXY=1`: from v22.21 and v24.5.
 */
export function nodeHonorsEnvProxy(
  version: string = process.versions.node
): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  if (major === 22) return minor >= 21;
  if (major === 24) return minor >= 5;
  return major >= 25;
}

const PROXY_VARIABLES = [
  "https_proxy",
  "HTTPS_PROXY",
  "http_proxy",
  "HTTP_PROXY",
  "no_proxy",
  "NO_PROXY",
];

/**
 * The update check's environment: the proxy settings resolved here, in both
 * spellings (Node prefers the lowercase one even when it is empty), and
 * `NODE_USE_ENV_PROXY=1` so the check uses them. `null` when a proxy is set
 * but this Node cannot use it: the check is skipped rather than sent direct.
 */
export function updateCheckEnv(
  env: NodeJS.ProcessEnv = process.env,
  version: string = process.versions.node
): NodeJS.ProcessEnv | null {
  const settings = proxySettings(env);
  if (!settings.httpsProxy && !settings.httpProxy) return env;
  if (!nodeHonorsEnvProxy(version)) return null;
  const next: NodeJS.ProcessEnv = { ...env, NODE_USE_ENV_PROXY: "1" };
  for (const name of PROXY_VARIABLES) delete next[name];
  const resolved = {
    https_proxy: settings.httpsProxy,
    http_proxy: settings.httpProxy,
    no_proxy: noProxyWithLoopback(settings.noProxy),
  };
  for (const [name, value] of Object.entries(resolved)) {
    if (value === null) continue;
    next[name] = value;
    next[name.toUpperCase()] = value;
  }
  return next;
}
