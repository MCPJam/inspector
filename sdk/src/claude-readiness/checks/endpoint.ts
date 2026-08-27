/**
 * Endpoint checks: the connector URL itself, before anything about MCP.
 *
 * These are runtime blockers rather than policy items. A plaintext endpoint is
 * not a paperwork problem — Claude will not dial it at all, so nothing further
 * about the server can be graded. Keeping them in the runtime-compatibility
 * lane is what lets a report say "we never got far enough to check the rest"
 * instead of listing thirty unevaluated policy items with no explanation.
 *
 * Pure: reasons over a redirect trace the runner captured. It dials nothing.
 */

import { claudePolicySource } from "../manifest.js";
import type { ClaudeReadinessFinding } from "../types.js";
import {
  notEvaluated,
  satisfied,
  violated,
  type ClaudeCheckDefinition,
  type ClaudeCheckStamp,
} from "./helpers.js";

const HTTPS_REQUIRED: ClaudeCheckDefinition = {
  id: "claude.endpoint.https",
  title: "The connector URL is served over HTTPS",
  lane: "runtime-compatibility",
  class: "runtime-blocker",
  source: claudePolicySource("submission", "§Requirements → Transport"),
  provenance: "static",
  intrusiveness: "passive",
};

const REDIRECT_STAYS_SECURE: ClaudeCheckDefinition = {
  id: "claude.endpoint.redirects-stay-https",
  title: "No redirect on the connector URL downgrades to plaintext",
  lane: "runtime-compatibility",
  class: "runtime-blocker",
  source: claudePolicySource("troubleshooting", "§Connection → Redirects"),
  provenance: "wire",
};

const REDIRECT_TERMINATES: ClaudeCheckDefinition = {
  id: "claude.endpoint.redirects-terminate",
  title: "The connector URL resolves without an unbounded redirect chain",
  lane: "runtime-compatibility",
  class: "runtime-blocker",
  source: claudePolicySource("troubleshooting", "§Connection → Redirects"),
  provenance: "wire",
};

/**
 * One hop of the chain the runner actually walked.
 *
 * The trace is an INPUT rather than something this module produces, because
 * the only transport allowed to walk it in a hosted run is the pinned one, and
 * a check module that could dial on its own would be a way around that.
 */
export interface ClaudeRedirectHop {
  url: string;
  status: number;
  location?: string;
}

export interface ClaudeEndpointEvidence {
  /** The URL exactly as entered — not canonicalized. */
  enteredUrl: string;
  /** Absent when the run never reached the endpoint. */
  redirectChain?: ClaudeRedirectHop[];
  /** True when the chain was cut short by the runner's own ceiling. */
  redirectLimitHit?: boolean;
}

export function runClaudeEndpointChecks(
  evidence: ClaudeEndpointEvidence,
  stamp: ClaudeCheckStamp,
): ClaudeReadinessFinding[] {
  const findings: ClaudeReadinessFinding[] = [];

  let parsed: URL | undefined;
  try {
    parsed = new URL(evidence.enteredUrl);
  } catch {
    parsed = undefined;
  }

  findings.push(
    parsed === undefined
      ? violated(
          HTTPS_REQUIRED,
          stamp,
          "The connector URL is not a valid absolute URL.",
          { enteredUrl: evidence.enteredUrl },
        )
      : parsed.protocol === "https:"
        ? satisfied(HTTPS_REQUIRED, stamp)
        : violated(
            HTTPS_REQUIRED,
            stamp,
            "Serve the connector over HTTPS. Claude will not connect to a plaintext endpoint.",
            { scheme: parsed.protocol },
          ),
  );

  const chain = evidence.redirectChain;
  // AN EMPTY CHAIN IS NOT A CLEAN ONE. `traceConnectorRedirects` returns
  // `redirectChain: []` when the very first request throws, so treating only
  // the absent field as "never reached" reported two satisfied findings with
  // `hops: 0` for an endpoint the run never actually touched — the exact
  // "unobserved obligation reads as a pass" failure every other check module
  // in this directory is written to avoid.
  if (!chain || chain.length === 0) {
    const reason = "the run never reached the connector endpoint";
    findings.push(notEvaluated(REDIRECT_STAYS_SECURE, stamp, reason));
    findings.push(notEvaluated(REDIRECT_TERMINATES, stamp, reason));
    return findings;
  }

  // A downgrade anywhere in the chain matters even when the chain ENDS on
  // https: the plaintext hop is rewritable by anyone on the path, and what
  // they get to choose is where the connector ends up.
  const downgrades = chain.filter((hop) => {
    if (!hop.location) return false;
    try {
      return new URL(hop.location, hop.url).protocol !== "https:";
    } catch {
      return false;
    }
  });
  findings.push(
    downgrades.length === 0
      ? satisfied(REDIRECT_STAYS_SECURE, stamp, { hops: chain.length })
      : violated(
          REDIRECT_STAYS_SECURE,
          stamp,
          "Remove the plaintext hop from the redirect chain — a hop anyone on the path can rewrite decides where the connection ends up, even when the chain finishes on HTTPS.",
          {
            hops: downgrades.map((hop) => ({
              from: hop.url,
              to: hop.location,
            })),
          },
        ),
  );

  findings.push(
    evidence.redirectLimitHit
      ? violated(
          REDIRECT_TERMINATES,
          stamp,
          "The connector URL redirected past the client's limit. Point the listing at the final URL.",
          { hops: chain.length },
        )
      : satisfied(REDIRECT_TERMINATES, stamp, { hops: chain.length }),
  );

  return findings;
}
