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

/** The proxy as the CLI uses it: each value a full http(s) URL, or unset. */
export interface CliProxy {
  httpsProxy: string | null;
  httpProxy: string | null;
  noProxy: string;
  /** The variables that are set but are not a usable proxy URL. */
  unusable: Array<"HTTPS_PROXY" | "HTTP_PROXY">;
}

/**
 * `proxy.corp:8080` means `http://proxy.corp:8080`, as it does to curl. A
 * value that is still not an http(s) URL is unusable: handed to undici, it
 * throws while the CLI starts, which stopped every command, `--help` too.
 */
function usableProxyUrl(value: string): string | null {
  const url = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  if (!URL.canParse(url)) return null;
  const { protocol } = new URL(url);
  return protocol === "http:" || protocol === "https:" ? url : null;
}

export function cliProxy(env: NodeJS.ProcessEnv = process.env): CliProxy {
  const settings = proxySettings(env);
  const unusable: CliProxy["unusable"] = [];
  const usable = (name: CliProxy["unusable"][number], value: string | null) => {
    if (value === null) return null;
    const url = usableProxyUrl(value);
    if (url === null) unusable.push(name);
    return url;
  };
  return {
    httpsProxy: usable("HTTPS_PROXY", settings.httpsProxy),
    httpProxy: usable("HTTP_PROXY", settings.httpProxy),
    noProxy: noProxyWithLoopback(settings.noProxy),
    unusable,
  };
}

/**
 * Routes every `fetch` this process makes through the configured proxy.
 * Called by the CLI entry point only: a program that embeds the CLI's `main`
 * keeps its own process-wide networking. An unusable value is reported and
 * left out, so it cannot stop the CLI from starting.
 */
export function installProxyDispatcher(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) =>
    process.stderr.write(`${message}\n`)
): boolean {
  const proxy = cliProxy(env);
  for (const name of proxy.unusable) {
    warn(
      `${name} is not an http(s) proxy URL, so the CLI ignores it. Set it like http://proxy.example.com:8080.`
    );
  }
  if (!proxy.httpsProxy && !proxy.httpProxy) return false;
  setGlobalDispatcher(
    new EnvHttpProxyAgent({
      // Both passed, empty when unset: undici reads the raw environment for
      // an option that is left out.
      httpsProxy: proxy.httpsProxy ?? "",
      httpProxy: proxy.httpProxy ?? "",
      noProxy: proxy.noProxy,
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
 * The update check's environment: the proxy as the CLI uses it, in both
 * spellings (Node prefers the lowercase one even when it is empty), and
 * `NODE_USE_ENV_PROXY=1` so the check uses it. https falls back to the http
 * proxy, as it does for the CLI; Node alone would send it direct. `null` when
 * a proxy is set but cannot be used, because this Node lacks proxy support or
 * a value is unusable: the check is skipped rather than sent direct.
 */
export function updateCheckEnv(
  env: NodeJS.ProcessEnv = process.env,
  version: string = process.versions.node
): NodeJS.ProcessEnv | null {
  const proxy = cliProxy(env);
  if (proxy.unusable.length > 0) return null;
  if (!proxy.httpsProxy && !proxy.httpProxy) return env;
  if (!nodeHonorsEnvProxy(version)) return null;
  const next: NodeJS.ProcessEnv = { ...env, NODE_USE_ENV_PROXY: "1" };
  for (const name of PROXY_VARIABLES) delete next[name];
  const resolved = {
    https_proxy: proxy.httpsProxy ?? proxy.httpProxy,
    http_proxy: proxy.httpProxy,
    no_proxy: proxy.noProxy,
  };
  for (const [name, value] of Object.entries(resolved)) {
    if (value === null) continue;
    next[name] = value;
    next[name.toUpperCase()] = value;
  }
  return next;
}
