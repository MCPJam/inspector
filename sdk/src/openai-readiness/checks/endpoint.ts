/**
 * Endpoint checks: the URL itself, before anything about MCP.
 *
 * These are runtime blockers rather than policy items. A plaintext endpoint is
 * not a paperwork problem — ChatGPT will not dial it at all, so nothing further
 * about the server can be graded. Keeping them in the runtime-compatibility
 * lane is what lets a report say "we never got far enough to check the rest"
 * instead of listing thirty unevaluated policy items with no explanation.
 *
 * Pure: reasons over a redirect trace the gatherer captured. It dials nothing.
 */

import { openaiPolicySource } from "../manifest.js";
import { OPENAI_EXPECTED_MCP_PATH } from "../profile.js";
import {
  OPENAI_READINESS_INPUTS,
  type OpenAIReadinessFinding,
} from "../types.js";
import type { OpenAIEndpointEvidence } from "../discovery.js";
import {
  missingInput,
  notEvaluated,
  satisfied,
  violated,
  type OpenAICheckDefinition,
  type OpenAICheckStamp,
} from "./helpers.js";

const HTTPS_REQUIRED: OpenAICheckDefinition = {
  id: "openai.endpoint.https",
  title: "The MCP endpoint is served over HTTPS",
  lane: "runtime-compatibility",
  class: "runtime-blocker",
  source: openaiPolicySource("deploy/connect-chatgpt", "§Hosting requirements"),
  provenance: "static",
  intrusiveness: "passive",
};

const REDIRECT_STAYS_SECURE: OpenAICheckDefinition = {
  id: "openai.endpoint.redirects-stay-https",
  title: "No redirect on the endpoint downgrades to plaintext",
  lane: "runtime-compatibility",
  class: "runtime-blocker",
  source: openaiPolicySource("deploy/troubleshooting", "§Connection"),
  provenance: "wire",
};

const REDIRECT_TERMINATES: OpenAICheckDefinition = {
  id: "openai.endpoint.redirects-terminate",
  title: "The endpoint resolves without an unbounded redirect chain",
  lane: "runtime-compatibility",
  class: "runtime-blocker",
  source: openaiPolicySource("deploy/troubleshooting", "§Connection"),
  provenance: "wire",
};

/**
 * The documented endpoint path, checked as GUIDANCE and not as a blocker.
 *
 * `/mcp` is what the docs use and what a reviewer expects to find, but a server
 * on another path works. Grading it `required` would fail a submission that is
 * going to be accepted, which is the one direction a preflight must not err in.
 */
const EXPECTED_PATH: OpenAICheckDefinition = {
  id: "openai.endpoint.path",
  title: `The MCP endpoint is served at ${OPENAI_EXPECTED_MCP_PATH}`,
  lane: "directory-policy",
  class: "recommended",
  source: openaiPolicySource("deploy/connect-chatgpt", "§Endpoint"),
  provenance: "static",
  intrusiveness: "passive",
};

const ALL: OpenAICheckDefinition[] = [
  HTTPS_REQUIRED,
  REDIRECT_STAYS_SECURE,
  REDIRECT_TERMINATES,
  EXPECTED_PATH,
];

function isHttps(url: string): boolean | undefined {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return undefined;
  }
}

export function runOpenAIEndpointChecks(
  evidence: OpenAIEndpointEvidence | undefined,
  stamp: OpenAICheckStamp,
): OpenAIReadinessFinding[] {
  if (!evidence) {
    return ALL.map((definition) =>
      notEvaluated(
        definition,
        stamp,
        "this run was given no endpoint to trace",
        missingInput(OPENAI_READINESS_INPUTS.serverUrl),
      ),
    );
  }

  const findings: OpenAIReadinessFinding[] = [];
  // PARSED ONCE. Two checks below ask about this URL — is it HTTPS, is it on
  // the documented path — and both need the same answer to "does it parse at
  // all". Deciding that twice is two places for it to be decided differently.
  let parsed: URL | undefined;
  try {
    parsed = new URL(evidence.enteredUrl);
  } catch {
    parsed = undefined;
  }
  const secure = parsed ? parsed.protocol === "https:" : undefined;

  if (secure === undefined) {
    findings.push(
      violated(HTTPS_REQUIRED, stamp, "The endpoint is not a parseable URL.", {
        enteredUrl: evidence.enteredUrl,
      }),
    );
  } else if (secure) {
    findings.push(satisfied(HTTPS_REQUIRED, stamp));
  } else {
    findings.push(
      violated(
        HTTPS_REQUIRED,
        stamp,
        "Serve the MCP endpoint over HTTPS; ChatGPT will not connect to a plaintext endpoint.",
        { enteredUrl: evidence.enteredUrl },
      ),
    );
  }

  // A chain that downgrades in the middle and recovers is invisible from the
  // destination alone, which is why the trace records every hop and this looks
  // at all of them rather than at where it landed.
  const insecureHops = evidence.redirectChain.filter(
    (hop) => isHttps(hop.url) === false,
  );
  const insecureTargets = evidence.redirectChain.filter(
    (hop) => hop.location !== undefined && isHttps(resolve(hop)) === false,
  );
  const downgrades = [...insecureHops, ...insecureTargets];

  if (evidence.redirectChain.length === 0) {
    findings.push(
      notEvaluated(
        REDIRECT_STAYS_SECURE,
        stamp,
        "the endpoint could not be reached, so no redirect chain was observed",
      ),
    );
    findings.push(
      notEvaluated(
        REDIRECT_TERMINATES,
        stamp,
        "the endpoint could not be reached, so no redirect chain was observed",
      ),
    );
  } else {
    findings.push(
      downgrades.length === 0
        ? satisfied(REDIRECT_STAYS_SECURE, stamp, {
            hops: evidence.redirectChain.length,
          })
        : violated(
            REDIRECT_STAYS_SECURE,
            stamp,
            "A redirect in the chain moves to a plaintext URL; the whole chain must stay HTTPS.",
            { downgrades: downgrades.map((hop) => hop.url) },
          ),
    );
    findings.push(
      evidence.redirectLimitHit
        ? violated(
            REDIRECT_TERMINATES,
            stamp,
            "The endpoint's redirect chain did not terminate within the hop limit.",
            { hops: evidence.redirectChain.length },
          )
        : satisfied(REDIRECT_TERMINATES, stamp, {
            hops: evidence.redirectChain.length,
          }),
    );
  }

  // A URL THAT DOES NOT PARSE HAS NO PATH TO GRADE. Reporting it as a path
  // violation would print `path: undefined` and send the submitter to fix a
  // path when the URL itself is the problem — which the HTTPS check above
  // already says, in the right words.
  const path = parsed?.pathname.replace(/\/$/, "");
  findings.push(
    parsed === undefined
      ? notEvaluated(
          EXPECTED_PATH,
          stamp,
          "the entered endpoint is not a parseable URL, so it has no path to compare",
        )
      : path === OPENAI_EXPECTED_MCP_PATH
        ? satisfied(EXPECTED_PATH, stamp, { path })
        : violated(
            EXPECTED_PATH,
            stamp,
            `The docs describe the endpoint at ${OPENAI_EXPECTED_MCP_PATH}; a reviewer will look there first.`,
            { path },
          ),
  );

  return findings;
}

/** The absolute URL a hop's `Location` resolves to. */
function resolve(hop: { url: string; location?: string }): string {
  if (!hop.location) return hop.url;
  try {
    return new URL(hop.location, hop.url).toString();
  } catch {
    return hop.location;
  }
}
