/**
 * Which servers the hosted (cloud) deployment structurally cannot connect.
 *
 * Hosted mode runs the transport in our cloud, not on the user's machine,
 * so two shapes are impossible rather than merely broken (see the
 * constraints documented on `HOSTED_MODE` in `./config`):
 *
 *   - **stdio** — the command would execute on our infrastructure. Disabled
 *     deliberately; this is the RCE boundary, not a missing feature.
 *   - **`http://`** — cleartext to a server reached over the public
 *     internet. Only `https://` is allowed out.
 *
 * Both were previously discovered the expensive way: the auto-connect batch
 * attempted them, the transport refused, and the card painted a red
 * failure for a server that was never going to work in this deployment and
 * whose "fix" is not a retry. So the check has to gate the ATTEMPT, not
 * just decorate the result — a connect that cannot succeed should never be
 * dispatched, and the card should explain the deployment rather than
 * accuse the server.
 *
 * Consolidated here from two drifting private copies (`ServerConnectionCard`
 * and `ActiveServerSelector`), each of which covered only the `http://`
 * half. Local mode has neither restriction, so every predicate returns
 * false when `HOSTED_MODE` is off.
 */

import type { MCPServerConfig } from "@mcpjam/sdk/browser";
import { HOSTED_MODE } from "@/lib/config";

/** Reason a config cannot be connected in this deployment, if any. */
export type HostedUnsupportedReason = "stdio" | "insecure-http";

function readConfigUrl(config: MCPServerConfig): string | undefined {
  // Runtime server entries can be partially hydrated (a Convex-synced row
  // that has a name and a status before its config arrives), so every
  // predicate here has to survive a missing config rather than throw from
  // inside a render or a candidate filter.
  if (!config || typeof config !== "object") return undefined;
  if (!("url" in config) || !config.url) return undefined;
  return config.url.toString();
}

/**
 * True when the config names a local command rather than a URL. Legacy
 * stdio rows predate hosted mode and still exist in hosted projects — the
 * Add/Edit forms merely stop new ones being created — so this cannot be
 * assumed away.
 */
function isStdioConfig(config: MCPServerConfig): boolean {
  const url = readConfigUrl(config);
  if (url) return false;
  return Boolean((config as { command?: unknown }).command);
}

function isInsecureHttpConfig(config: MCPServerConfig): boolean {
  const url = readConfigUrl(config);
  if (!url) return false;
  try {
    return new URL(url).protocol === "http:";
  } catch {
    // An unparseable URL is a different problem (and a real failure worth
    // showing); don't claim it as a hosted-mode restriction.
    return false;
  }
}

/**
 * Why this server can't be connected in the current deployment, or `null`
 * when it can. Always `null` outside hosted mode.
 */
export function getHostedUnsupportedReason(
  config: MCPServerConfig
): HostedUnsupportedReason | null {
  if (!HOSTED_MODE) return null;
  if (isStdioConfig(config)) return "stdio";
  if (isInsecureHttpConfig(config)) return "insecure-http";
  return null;
}

/** Convenience predicate for call sites that don't need the reason. */
export function isHostedUnsupportedServer(config: MCPServerConfig): boolean {
  return getHostedUnsupportedReason(config) !== null;
}

/**
 * Back-compat alias for the `http://`-only check the connect switch and the
 * chip strip already had. Kept separate from
 * {@link isHostedUnsupportedServer} because these two call sites raise an
 * HTTPS-specific message that would be wrong for a stdio server.
 */
export function isHostedInsecureHttpServer(config: MCPServerConfig): boolean {
  return getHostedUnsupportedReason(config) === "insecure-http";
}

/** Short chip text. Neutral — states the deployment, blames nothing. */
export function hostedUnsupportedChipLabel(
  reason: HostedUnsupportedReason
): string {
  return reason === "stdio"
    ? "Not available in cloud mode"
    : "Needs HTTPS in cloud mode";
}

/** One sentence saying what to do about it. */
export function hostedUnsupportedExplanation(
  reason: HostedUnsupportedReason
): string {
  return reason === "stdio"
    ? "STDIO servers run a local command, which the cloud deployment cannot do. Run MCPJam locally to connect this server."
    : "Hosted mode requires HTTPS server URLs. Edit this server to use https://.";
}
