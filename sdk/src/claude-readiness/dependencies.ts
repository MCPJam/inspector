/**
 * What a Claude run reports when it could not use the server.
 *
 * A failed dependency blocks only its dependents. Which checks need the
 * server is declared once, in the connector flow's placements (`needs`),
 * and `placeDirectoryResults` reads the same declaration; a check graded
 * from answers needs no server and keeps its verdict.
 *
 * Pure. No transport.
 */

import { CLAUDE_CONNECTOR_FLOW } from "../directory-readiness/flows/claude-connector.js";
import { directoryBlockedReason } from "../directory-readiness/flows/place.js";
import { CLAUDE_APPS_RESULT_INPUT } from "./checks/apps.js";
import { CLAUDE_TOOL_LISTING_INPUT } from "./checks/tools.js";
import type { ClaudeReadinessFinding } from "./types.js";

/** Why the run could not use the server, as the gather saw it. */
export interface ClaudeServerFailure {
  /**
   * `unreachable`: nothing at the connector URL answered, so no check that
   * needs the server could run. `connection`: the server answered but did
   * not open an MCP session, so only what that session lists is missing.
   */
  kind: "unreachable" | "connection";
  /** The transport's error, or the server's refusal. */
  detail: string;
}

const NEEDS_SERVER: ReadonlySet<string> = new Set(
  CLAUDE_CONNECTOR_FLOW.placements
    .filter((placement) => placement.needs?.includes("server"))
    .map((placement) => placement.checkId)
);

/** The evidence an MCP session provides, by the input name its checks miss. */
const SESSION_INPUTS: unknown[] = [
  CLAUDE_TOOL_LISTING_INPUT,
  CLAUDE_APPS_RESULT_INPUT,
];

/**
 * Give each dependent the run left without a verdict the failure as its
 * reason. A verdict stands: the checks grade unanswered requests as not
 * evaluated themselves, so one that reached a verdict here graded evidence
 * the caller supplied.
 */
export function blockOnServerFailure(
  findings: readonly ClaudeReadinessFinding[],
  failure: ClaudeServerFailure | undefined
): ClaudeReadinessFinding[] {
  if (!failure) return [...findings];
  const reason = directoryBlockedReason(
    failure.kind === "unreachable"
      ? `the server could not be reached: ${failure.detail}`
      : `the connection to the server failed: ${failure.detail}`
  );
  return findings.map((finding) => {
    const missing = (finding.details as { missingInput?: unknown } | undefined)
      ?.missingInput;
    const dependent =
      failure.kind === "unreachable"
        ? NEEDS_SERVER.has(finding.id)
        : SESSION_INPUTS.includes(missing);
    return finding.status === "not-evaluated" && dependent
      ? { ...finding, notEvaluatedReason: reason }
      : finding;
  });
}
