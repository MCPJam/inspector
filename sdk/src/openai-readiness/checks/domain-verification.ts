/**
 * Domain-verification checks.
 *
 * WHAT A PREFLIGHT CAN AND CANNOT ESTABLISH HERE, because the difference is the
 * whole design of this file. It CAN establish that the well-known path responds
 * over the endpoint's own origin, and that the body matches the token the
 * submitter said the portal issued. It CANNOT establish that the portal issued
 * that token — the token is `declared`, and a run that treated a self-declared
 * value as proof would be verifying a submitter against themselves.
 *
 * So the finding that compares them is `required` and deterministic, and it
 * says in its provenance that half its input was declared. With no declared
 * token the check is `not-evaluated` naming the input, never a pass on the
 * strength of "something answered".
 *
 * Pure data. No transport — the fetch happens in discovery.
 */

import { openaiPolicySource } from "../manifest.js";
import { OPENAI_DOMAIN_VERIFICATION_PATH } from "../profile.js";
import {
  OPENAI_READINESS_INPUTS,
  type OpenAIReadinessFinding,
} from "../types.js";
import type { OpenAIDomainVerificationEvidence } from "../discovery.js";
import {
  missingInput,
  notEvaluated,
  satisfied,
  violated,
  type OpenAICheckDefinition,
  type OpenAICheckStamp,
} from "./helpers.js";

const CHALLENGE_SERVED: OpenAICheckDefinition = {
  id: "openai.domain.challenge-served",
  title: `The domain-verification challenge is served at ${OPENAI_DOMAIN_VERIFICATION_PATH}`,
  lane: "directory-policy",
  class: "required",
  source: openaiPolicySource("deploy/submission", "§Domain verification"),
  provenance: "wire",
};

/**
 * In `submission-artifacts`, not `directory-policy`.
 *
 * The token is issued by the portal DURING a submission, so a submitter running
 * a technical preflight before starting one does not have it and could not have
 * deployed it. Grading this in the narrow stage would report every pre-
 * submission run as incomplete on a step that cannot have happened yet.
 * Serving the path at all stays technical; matching a portal-issued value is
 * paperwork.
 */
const CHALLENGE_MATCHES: OpenAICheckDefinition = {
  id: "openai.domain.challenge-matches",
  title: "The served challenge matches the declared verification token",
  lane: "submission-artifacts",
  class: "required",
  // `declared`, not `wire`: one side of this comparison is the submitter's own
  // statement about what the portal issued, and the provenance has to say so.
  source: openaiPolicySource("deploy/submission", "§Domain verification"),
  provenance: "declared",
};

export interface OpenAIDomainVerificationInput {
  evidence?: OpenAIDomainVerificationEvidence;
  /** The token the submitter says the portal issued. Never verified as issued. */
  declaredToken?: string;
}

export function runOpenAIDomainVerificationChecks(
  input: OpenAIDomainVerificationInput,
  stamp: OpenAICheckStamp,
): OpenAIReadinessFinding[] {
  const findings: OpenAIReadinessFinding[] = [];
  const { evidence, declaredToken } = input;

  if (!evidence) {
    return [CHALLENGE_SERVED, CHALLENGE_MATCHES].map((definition) =>
      notEvaluated(
        definition,
        stamp,
        "this run was given no endpoint whose origin could be probed",
        missingInput(OPENAI_READINESS_INPUTS.serverUrl),
      ),
    );
  }

  if (evidence.fetchError !== undefined) {
    findings.push(
      notEvaluated(
        CHALLENGE_SERVED,
        stamp,
        `the challenge path could not be reached: ${evidence.fetchError}`,
        { url: evidence.url },
      ),
    );
  } else if (
    evidence.status !== undefined &&
    evidence.status >= 200 &&
    evidence.status < 300
  ) {
    findings.push(
      satisfied(CHALLENGE_SERVED, stamp, {
        url: evidence.url,
        status: evidence.status,
      }),
    );
  } else {
    findings.push(
      violated(
        CHALLENGE_SERVED,
        stamp,
        `Serve the verification token at ${OPENAI_DOMAIN_VERIFICATION_PATH} on the endpoint's own origin; it answered ${evidence.status}.`,
        { url: evidence.url, status: evidence.status },
      ),
    );
  }

  if (!declaredToken) {
    findings.push(
      notEvaluated(
        CHALLENGE_MATCHES,
        stamp,
        "the submission profile declares no domain-verification token, so there is nothing to compare the served body against",
        missingInput(OPENAI_READINESS_INPUTS.submissionProfile, {
          field: "domainVerificationToken",
        }),
      ),
    );
    return findings;
  }

  if (evidence.body === undefined) {
    findings.push(
      notEvaluated(
        CHALLENGE_MATCHES,
        stamp,
        "the challenge path returned no body to compare",
        { url: evidence.url },
      ),
    );
    return findings;
  }

  findings.push(
    evidence.body === declaredToken
      ? satisfied(CHALLENGE_MATCHES, stamp, {
          url: evidence.url,
          // The token itself is NOT recorded. It is a value the portal issued
          // to this submitter, findings are rendered into reports and CI logs,
          // and a match is the whole fact worth reporting.
          matched: true,
        })
      : violated(
          CHALLENGE_MATCHES,
          stamp,
          "The body served at the challenge path is not the token the profile declares. Re-copy the token from the portal, or redeploy.",
          {
            url: evidence.url,
            matched: false,
            servedLength: evidence.body.length,
            declaredLength: declaredToken.length,
          },
        ),
  );

  return findings;
}
