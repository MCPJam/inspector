import type { CapturePolicy } from "./error-origin-capture.js";
import {
  AGENT_SURFACE,
  agentFingerprint,
  agentPageClass,
  type FailureFacts,
} from "../../shared/agent-failure-class.js";

export {
  AGENT_SURFACE,
  agentFingerprint,
  agentPageClass,
  type FailureFacts,
  type PageClass,
} from "../../shared/agent-failure-class.js";

/**
 * Ask MCPJam's capture policy: every failure reaches Sentry, classified.
 *
 * Why the agent opts out of the origin policy: since v3.12.2 every self-hosted
 * Ask MCPJam turn failed for a week and nothing paged. The agent reuses the
 * Playground engine, which files its failures as `user_server_hop`, and the
 * refusal codes it met map to a `user_config` slug — both are, correctly for
 * the Playground, "not ours", so nothing reached Sentry from any install. The
 * agent is ours end to end (our prompt, our pinned model, our docs servers), so
 * it captures everything except the user pressing Stop and tags each capture
 * `surface: mcpjam_agent` plus a `page_class`:
 *
 * - `incident` pings #mcpjam-alerts immediately;
 * - `routine` pings only on a spike — an expired sign-in, a validation error,
 *   or a user's or org's OWN quota, which are the product working.
 *
 * Origins, hops, Axiom rows and `x-mcpjam-error-origin` are untouched: this
 * changes what Sentry hears, not how a failure is attributed.
 */

/** A surface's capture rule, as the engine and the routes consume it. */
export type FailureCapture = {
  policyFor(facts: FailureFacts): CapturePolicy;
};

export function agentCapturePolicy(facts: FailureFacts): CapturePolicy {
  const pageClass = agentPageClass(facts);
  return {
    always: true,
    tags: {
      surface: AGENT_SURFACE,
      page_class: pageClass,
      agent_failure_source: facts.source,
      ...(facts.code ? { agent_failure_code: facts.code } : {}),
    },
    fingerprint: agentFingerprint(facts),
    level: facts.level ?? (pageClass === "routine" ? "warning" : "error"),
  };
}

export const MCPJAM_AGENT_FAILURE_CAPTURE: FailureCapture = {
  policyFor: agentCapturePolicy,
};

/**
 * The MCP server an error names, when it names one.
 *
 * Every connect/call failure the SDK's `MCPClientManager` raises quotes the
 * server it was reaching (`… MCP server "mcp-spec" …`), in MCPJam's own wording
 * — so a third party cannot forge it. Lets a docs-server failure that ends a
 * turn group apart from every other engine failure.
 */
export function mcpServerNamedIn(error: unknown): string | undefined {
  let message: string;
  try {
    message = error instanceof Error ? error.message : String(error);
  } catch {
    return undefined;
  }
  return /\bMCP server "([^"]{1,128})"/i.exec(message)?.[1];
}

/**
 * Routes whose every failure belongs to Ask MCPJam: the in-app agent and its
 * widget sub-route, and the public `/api/v1` agent (Slack, Discord, API keys).
 */
export function isAgentRequestPath(path: string): boolean {
  return (
    /^\/api\/web\/mcpjam-agent(?:\/|$)/.test(path) ||
    /^\/api\/v1\/projects\/[^/]+\/agent(?:\/|$)/.test(path)
  );
}
