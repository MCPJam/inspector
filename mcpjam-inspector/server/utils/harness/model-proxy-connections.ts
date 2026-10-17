/**
 * Close a resumed box's open connections to the model proxy.
 *
 * E2B stamps a box's egress header rule once per CONNECTION: measured on a
 * real sandbox, a keep-alive connection opened under lease A kept sending A
 * after the policy was replaced with lease B, and only new connections carried
 * B. Each turn installs a fresh lease and the previous turn's teardown revokes
 * its own, so a runtime that outlived the previous turn — Claude Code paused on
 * a tool approval, holding its pooled connection — would present the revoked
 * lease on its first call after the resume, and the proxy refuses it.
 *
 * Closing those sockets before the runtime continues makes its HTTP client
 * open a new connection, which carries this turn's lease. A pooled client drops
 * an idle socket that closes under it without failing a request (verified for
 * Node's keep-alive agent and `fetch` on the hosted template). Only resumes
 * need this: a new session has no runtime holding an old connection.
 */

import { CommandExitError, type Sandbox } from "e2b";
import { scrubLogText } from "../../../shared/log-scrubber.js";
import { logger } from "../logger.js";

/** Hostnames only, so the value can sit in a shell command unquoted. */
const HOSTNAME = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;

/**
 * The root command that closes every TCP connection to `host`:443 in the box
 * and prints how many it closed, or null when `host` is not a plain hostname.
 * `ss -K` needs CAP_NET_ADMIN, so it must run as root, and it reads a bare
 * IPv6 address as address:port, so those are bracketed. Every address is
 * tried; the exit status says whether any failed.
 */
export function closeModelProxyConnectionsCommand(host: string): string | null {
  if (!HOSTNAME.test(host)) return null;
  return (
    `n=0; rc=0; for ip in $(getent ahosts ${host} | awk '{print $1}' | sort -u); do ` +
    `case "$ip" in *:*) ip="[$ip]" ;; esac; ` +
    `out=$(ss -K dst "$ip" dport = :443) || rc=1; ` +
    `n=$((n + $(printf '%s\\n' "$out" | tail -n +2 | grep -c .))); done; ` +
    `echo "$n"; exit $rc`
  );
}

/** Run the close as root on a resumed box; a failure is reported, not fatal. */
export async function closeModelProxyConnections(
  sandbox: Pick<Sandbox, "commands">,
  host: string | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const command = host ? closeModelProxyConnectionsCommand(host) : null;
  if (!command) return;
  try {
    const result = await sandbox.commands.run(command, {
      user: "root",
      timeoutMs: 10_000,
      ...(signal ? { signal } : {}),
    });
    logger.info(
      `[harness] closed ${result.stdout.trim() || "0"} model-proxy connection(s) on resume`,
    );
  } catch (error) {
    // Not fatal: a resume that keeps its old connection fails on its first
    // model call exactly as it did before this step existed. The detail is in
    // the message because the console prints a warning's message only.
    logger.warn(
      `[harness] could not close model-proxy connections: ${closeFailureDetail(error)}`,
    );
  }
}

function closeFailureDetail(error: unknown): string {
  if (error instanceof CommandExitError) {
    const stderr = error.stderr.trim().split("\n")[0] ?? "";
    return `exit ${error.exitCode}${stderr ? `: ${scrubLogText(stderr).slice(0, 200)}` : ""}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** The model proxy's hostname from the broker's proxy base URL. */
export function modelProxyHostOf(proxyBaseUrl: string): string | undefined {
  try {
    return new URL(proxyBaseUrl).hostname;
  } catch {
    // A malformed URL has no host to close; the resume proceeds as before.
    return undefined;
  }
}
