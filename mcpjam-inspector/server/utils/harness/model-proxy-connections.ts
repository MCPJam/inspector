/**
 * Close a resumed box's open connections to the model proxy.
 *
 * E2B stamps a box's egress header rule once per CONNECTION: a keep-alive
 * connection opened under lease A keeps sending A after the policy is replaced
 * with lease B, and only new connections carry B. Each turn installs a fresh
 * lease and the previous turn's teardown revokes its own, so a runtime that
 * outlived the previous turn (Claude Code paused on a tool approval, holding
 * its pooled connection) would present the revoked lease on its first call
 * after the resume, and the proxy refuses it.
 *
 * Closing those sockets before the runtime continues makes its HTTP client
 * open a new connection, which carries this turn's lease. Only resumes need
 * this: a new session has no runtime holding an old connection.
 */

import type { Sandbox } from "e2b";
import { scrubLogText } from "../../../shared/log-scrubber.js";
import { logger } from "../logger.js";

/** Hostnames only, so the value can sit in a shell command unquoted. */
const HOSTNAME = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;

/**
 * Closes every TCP connection to the proxy's :443 as root (`ss -K` needs
 * CAP_NET_ADMIN). `ss` reads a bare IPv6 address as address:port, so those
 * are bracketed. A failure is reported, not fatal: a resume that keeps its old
 * connection fails on its first model call, as it would without this step.
 */
export async function closeModelProxyConnections(
  sandbox: Pick<Sandbox, "commands">,
  proxyBaseUrl: string | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (!proxyBaseUrl || !URL.canParse(proxyBaseUrl)) return;
  const host = new URL(proxyBaseUrl).hostname;
  if (!HOSTNAME.test(host)) return;
  try {
    await sandbox.commands.run(
      `for ip in $(getent ahosts ${host} | awk '{print $1}' | sort -u); do ` +
        `case "$ip" in *:*) ip="[$ip]" ;; esac; ` +
        `ss -K dst "$ip" dport = :443 || rc=1; done; exit \${rc:-0}`,
      { user: "root", timeoutMs: 10_000, ...(signal ? { signal } : {}) },
    );
  } catch (error) {
    // The detail is in the message because the console prints a warning's
    // message only.
    const detail = error instanceof Error ? error.message : String(error);
    logger.warn(
      `[harness] could not close model-proxy connections: ${scrubLogText(detail).slice(0, 200)}`,
    );
  }
}
