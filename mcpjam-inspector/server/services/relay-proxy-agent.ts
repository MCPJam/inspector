/**
 * The proxy the tunnel relay's WebSocket dials through.
 *
 * `ws` opens its own socket, so neither undici's dispatcher nor Node's
 * `NODE_USE_ENV_PROXY` reaches it. Where a proxy is the only way out (a
 * Claude Code cloud session has no DNS), the relay never reached the edge,
 * and a hosted harness box could not reach this Inspector's MCP proxy.
 *
 * The variables mean what they mean to undici's `EnvHttpProxyAgent`, which
 * the runtime installer uses: `HTTPS_PROXY` for `wss:`, falling back to
 * `HTTP_PROXY`; `HTTP_PROXY` for `ws:`. A `NO_PROXY` entry matches its host
 * and subdomains, on one port when it names one, and `*` matches every
 * host. Loopback always connects directly, as in the CLI, so a local tunnel
 * edge keeps working behind a proxy.
 */
import type { Agent } from "node:http";
import { proxySettings } from "@mcpjam/sdk/internal/network-proxy";
import { HttpsProxyAgent } from "https-proxy-agent";
import { logger } from "../utils/logger";

/** `[::1]` bracketed, as `URL.hostname` spells it. */
const LOOPBACK = new Set(["localhost", "[::1]"]);
/**
 * All of 127.0.0.0/8 is loopback. `URL.hostname` has already normalized any
 * IPv4 spelling, such as `127.1`, to four decimal parts.
 */
const IPV4_LOOPBACK = /^127(?:\.\d{1,3}){3}$/;

function bypassesProxy(
  host: string,
  port: number,
  noProxy: string | null,
): boolean {
  if (LOOPBACK.has(host) || IPV4_LOOPBACK.test(host)) return true;
  for (const raw of noProxy?.split(/[,\s]/) ?? []) {
    if (!raw) continue;
    if (raw === "*") return true;
    const withPort = raw.match(/^(.+):(\d+)$/);
    if (withPort && Number(withPort[2]) !== port) continue;
    const entry = (withPort ? withPort[1] : raw)
      .replace(/^\*?\./, "")
      .toLowerCase();
    if (host === entry || host.endsWith(`.${entry}`)) return true;
  }
  return false;
}

/** `proxy.corp:8080` means `http://proxy.corp:8080`, as it does to curl. */
function proxyUrl(value: string): URL | null {
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(value)
    ? value
    : `http://${value}`;
  if (!URL.canParse(withScheme)) return null;
  const url = new URL(withScheme);
  return url.protocol === "http:" || url.protocol === "https:" ? url : null;
}

/**
 * A CONNECT tunnel through the environment's proxy for the relay URL, or
 * `undefined` to connect directly, as the relay did before proxies.
 * Aborting `signal` destroys the socket to the proxy, which is how a dial
 * the proxy never answers is given up.
 */
export function relayProxyAgent(
  relayWsUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Agent | undefined {
  // An unparseable URL is left for `ws` to reject with its own error.
  if (!URL.canParse(relayWsUrl)) return undefined;
  const target = new URL(relayWsUrl);
  const secure = target.protocol === "wss:" || target.protocol === "https:";
  const settings = proxySettings(env);
  const proxy = secure
    ? (settings.httpsProxy ?? settings.httpProxy)
    : settings.httpProxy;
  if (proxy === null) return undefined;
  const port = Number(target.port) || (secure ? 443 : 80);
  if (bypassesProxy(target.hostname, port, settings.noProxy)) return undefined;
  const url = proxyUrl(proxy);
  if (url === null) {
    const name =
      secure && settings.httpsProxy !== null ? "HTTPS_PROXY" : "HTTP_PROXY";
    logger.warn(
      `${name} is not an http(s) proxy URL, so the tunnel relay connects directly. Set it like http://proxy.example.com:8080.`,
    );
    return undefined;
  }
  // The agent hands `signal` to the socket it opens to the proxy.
  return new HttpsProxyAgent(url, signal ? { signal } : undefined);
}
