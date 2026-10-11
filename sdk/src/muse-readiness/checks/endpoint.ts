/**
 * Endpoint checks: the connector URL itself, before anything about MCP.
 *
 * §4.4 requires data to be encrypted in transit, and §6.3's end-to-end QA
 * connects to the endpoint the submitter files. A plaintext endpoint fails
 * the first; a redirect chain that downgrades or never ends fails the second
 * before any tool is reached. Both are runtime blockers: nothing further about
 * the server can be graded through them.
 *
 * Pure: reasons over a redirect trace the gatherer captured. Dials nothing.
 */

import type { DirectoryRedirectHop } from "../../directory-readiness/discovery.js";
import { musePolicySource } from "../manifest.js";
import type { MuseReadinessFinding } from "../types.js";
import {
  notEvaluated,
  satisfied,
  violated,
  type MuseCheckDefinition,
  type MuseCheckStamp,
} from "./helpers.js";

const HTTPS_REQUIRED: MuseCheckDefinition = {
  id: "muse.endpoint.https",
  title: "The connector endpoint is served over HTTPS",
  lane: "runtime-compatibility",
  class: "runtime-blocker",
  source: musePolicySource("docs", "§4.4 Security"),
  provenance: "static",
  intrusiveness: "passive",
};

const REDIRECT_STAYS_SECURE: MuseCheckDefinition = {
  id: "muse.endpoint.redirects-stay-https",
  title: "No redirect on the connector endpoint downgrades to plaintext",
  lane: "runtime-compatibility",
  class: "runtime-blocker",
  source: musePolicySource("docs", "§4.4 Security"),
  provenance: "wire",
};

const REDIRECT_TERMINATES: MuseCheckDefinition = {
  id: "muse.endpoint.redirects-terminate",
  title: "The connector endpoint resolves without an unbounded redirect chain",
  lane: "runtime-compatibility",
  class: "runtime-blocker",
  source: musePolicySource("docs", "§6.3 End-to-end QA"),
  provenance: "wire",
};

export interface MuseEndpointEvidence {
  /** The URL exactly as entered — not canonicalized. */
  enteredUrl: string;
  /** Absent (or empty) when the run never reached the endpoint. */
  redirectChain?: DirectoryRedirectHop[];
  /** True when the chain was cut short by the runner's own ceiling. */
  redirectLimitHit?: boolean;
}

export function runMuseEndpointChecks(
  evidence: MuseEndpointEvidence,
  stamp: MuseCheckStamp
): MuseReadinessFinding[] {
  const findings: MuseReadinessFinding[] = [];

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
          "The connector endpoint is not a valid absolute URL.",
          { enteredUrl: evidence.enteredUrl }
        )
      : parsed.protocol === "https:"
        ? satisfied(HTTPS_REQUIRED, stamp)
        : violated(
            HTTPS_REQUIRED,
            stamp,
            "Serve the connector over HTTPS. Muse's guidelines require data to be encrypted in transit.",
            { scheme: parsed.protocol }
          )
  );

  // AN EMPTY CHAIN IS NOT A CLEAN ONE: the trace returns `[]` when the very
  // first request throws, and two satisfied findings over an endpoint nobody
  // reached would be a pass for an unobserved obligation.
  const chain = evidence.redirectChain;
  if (!chain || chain.length === 0) {
    const reason = "the run never reached the connector endpoint";
    findings.push(notEvaluated(REDIRECT_STAYS_SECURE, stamp, reason));
    findings.push(notEvaluated(REDIRECT_TERMINATES, stamp, reason));
    return findings;
  }

  // A downgrade anywhere matters even when the chain ENDS on https: the
  // plaintext hop is rewritable by anyone on the path.
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
          "Remove the plaintext hop from the redirect chain — data crossing it is not encrypted in transit, even when the chain finishes on HTTPS.",
          {
            hops: downgrades.map((hop) => ({
              from: hop.url,
              to: hop.location,
            })),
          }
        )
  );

  findings.push(
    evidence.redirectLimitHit
      ? violated(
          REDIRECT_TERMINATES,
          stamp,
          "The connector endpoint redirected past the client's limit. File the final URL instead.",
          { hops: chain.length }
        )
      : satisfied(REDIRECT_TERMINATES, stamp, { hops: chain.length })
  );

  return findings;
}
