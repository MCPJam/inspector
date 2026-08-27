/**
 * App-guidelines checks.
 *
 * THE GUIDELINES ARE MOSTLY NOT DECIDABLE FROM BYTES, and pretending otherwise
 * is the failure mode this file is shaped to avoid. "Is this plugin original?"
 * "Are its side effects predictable?" "Does it minimise what it returns?" are
 * real requirements and a reviewer answers them. A check that scored them from
 * a description would produce a confident number for a question it cannot
 * answer, and a submitter would act on it.
 *
 * So the split is sharp:
 *
 *   - DETERMINISTIC, `required`, in directory-policy: no promotional or ranking
 *     claims in the plugin's own copy, and the commerce restrictions that
 *     attach when a plugin sells something.
 *   - JUDGEMENT, `manual-review`, in experience-insights: advertising,
 *     originality, predictable side effects, response minimisation, and whether
 *     the privacy disclosure matches what the plugin does. Each names WHAT a
 *     reviewer should look at, so "a human has to look" is actionable rather
 *     than a shrug.
 *
 * Pure data. No transport.
 */

import { openaiPolicySource } from "../manifest.js";
import { openaiPortalIssue } from "../portal-errors.js";
import type { OpenAISubmissionProfile } from "../submission-profile.js";
import {
  OPENAI_READINESS_INPUTS,
  type OpenAIReadinessFinding,
} from "../types.js";
import {
  missingInput,
  notApplicable,
  notEvaluated,
  satisfied,
  violated,
  type OpenAICheckDefinition,
  type OpenAICheckStamp,
} from "./helpers.js";

export interface OpenAIPolicyEvidence {
  profile?: OpenAISubmissionProfile;
  /**
   * Metadata the PACKAGE carries, so a run with no submission profile is still
   * gradeable.
   *
   * The guidelines' metadata rules are about what the plugin says about itself,
   * and a package's interface document and skill descriptions say it just as
   * much as a listing form does. Grading only the form would make a
   * package-only preflight — the exact run a submitter makes before filling
   * anything in — report every metadata rule as unevaluable.
   */
  packageMetadata?: { field: string; text: string }[];
  /** Whether the plugin sells anything, from the monetization surface. */
  hasCommerce?: boolean;
}

/**
 * The same rule, graded twice, because the two copies live in different
 * artifacts and therefore in different lanes.
 *
 * The guidelines' metadata rule applies to whatever the plugin says about
 * itself, and that text arrives from two places: the PACKAGE (its manifest
 * description, its interface document, its skill descriptions) and the
 * SUBMISSION FORM. The package's copy is available to a technical preflight;
 * the form's is paperwork, and only exists once someone starts filling it in.
 *
 * Folding them into one `directory-policy` finding made the technical
 * preflight permanently `incomplete` for any run without a profile — which is
 * every run a submitter makes BEFORE writing their listing, and exactly the run
 * the narrow stage exists to serve.
 */
const NON_PROMOTIONAL_PACKAGE: OpenAICheckDefinition = {
  id: "openai.policy.non-promotional-package",
  title: "The package's own copy is descriptive rather than promotional",
  lane: "directory-policy",
  class: "required",
  source: openaiPolicySource("app-guidelines", "§Metadata"),
  provenance: "static",
  intrusiveness: "passive",
};

const NON_PROMOTIONAL_LISTING: OpenAICheckDefinition = {
  id: "openai.policy.non-promotional-listing",
  title: "Listing copy is descriptive rather than promotional",
  lane: "submission-artifacts",
  class: "required",
  source: openaiPolicySource("app-guidelines", "§Metadata"),
  provenance: "declared",
  intrusiveness: "passive",
};

/**
 * Advertising is a JUDGEMENT call, and lives where judgement calls live.
 *
 * It was `required` in directory-policy for one draft, and that was wrong in a
 * way worth recording: nothing a submission declares says whether the plugin
 * shows ads, so the check could only ever report `not-evaluated` — which made
 * the lane permanently `incomplete` for every submission, and a lane that can
 * never reach `ready` teaches its readers to ignore it.
 */
const NO_ADVERTISING: OpenAICheckDefinition = {
  id: "openai.policy.no-advertising",
  title: "The plugin does not carry advertising",
  lane: "experience-insights",
  class: "manual-review",
  source: openaiPolicySource("app-guidelines", "§Prohibited content"),
  provenance: "declared",
  intrusiveness: "passive",
};

const COMMERCE_RESTRICTIONS: OpenAICheckDefinition = {
  id: "openai.policy.commerce",
  title: "A plugin that sells follows the checkout conversion spec",
  lane: "directory-policy",
  class: "required",
  source: openaiPolicySource(
    "guides/product-checkout-conversion-spec",
    "§Requirements",
  ),
  provenance: "declared",
  intrusiveness: "passive",
};

const ORIGINALITY: OpenAICheckDefinition = {
  id: "openai.policy.originality",
  title: "The plugin is the submitter's own work or authorized",
  lane: "experience-insights",
  class: "manual-review",
  source: openaiPolicySource("app-guidelines", "§Originality"),
  provenance: "declared",
  intrusiveness: "passive",
};

const PREDICTABLE_SIDE_EFFECTS: OpenAICheckDefinition = {
  id: "openai.policy.predictable-side-effects",
  title: "Tools do only what a user would expect them to do",
  lane: "experience-insights",
  class: "manual-review",
  source: openaiPolicySource("app-guidelines", "§Predictable side effects"),
  provenance: "declared",
  intrusiveness: "passive",
};

const RESPONSE_MINIMIZATION: OpenAICheckDefinition = {
  id: "openai.policy.response-minimization",
  title: "Tool responses return only what the task needs",
  lane: "experience-insights",
  class: "manual-review",
  source: openaiPolicySource("app-guidelines", "§Data minimization"),
  provenance: "declared",
  intrusiveness: "passive",
};

const PRIVACY_CONSISTENCY: OpenAICheckDefinition = {
  id: "openai.policy.privacy-consistency",
  title: "The privacy disclosure matches what the plugin actually collects",
  lane: "experience-insights",
  class: "manual-review",
  source: openaiPolicySource("app-guidelines", "§Privacy"),
  provenance: "declared",
  intrusiveness: "passive",
};

/**
 * Superlatives and ranking claims a listing may not make.
 *
 * A CLOSED LIST of phrases rather than a sentiment judgement: the rule is about
 * specific claims ("the best", "#1", "guaranteed results"), and something
 * fuzzier would fail ordinary product copy.
 *
 * "GUARANTEED" IS THE ONE TO BE CAREFUL WITH. A bare `\bguaranteed?\b` reads
 * "30-day money-back guarantee" and "guaranteed delivery by Friday" as
 * promotional claims, and this check is `required` — so the cost of that match
 * is a submission blocked on a sentence any reviewer would wave through. What
 * the rule is actually about is a guarantee of OUTCOME or RANK, so the pattern
 * below requires the word to attach to one.
 */
const PROMOTIONAL_PHRASES = [
  /\bbest\b.{0,20}\b(app|plugin|tool)\b/i,
  // NO LEADING `\b`, and BOUND TO A RANK CLAIM. `#` is not a word character, so
  // `\b#` demanded a word character immediately before the hash — which meant
  // the old pattern matched `app#1` and never `The #1 plugin`, the only
  // spelling anyone writes. Removing that anchor alone swings too far the
  // other way: this check is `required`, so a bare `#1` blocks a submission
  // whose description says "fixes issue #1". What makes it promotional is the
  // RANK, so the hash has to reach one — a thing being ranked within a couple
  // of words, or a rating word straight after. The repetition is BOUNDED, so
  // this cannot be the quadratic pattern its neighbours were. `1\b` still
  // spares `#10`.
  /#\s*1\b(?:\s+[\w'-]+){0,2}\s+(?:app|apps|plugin|tool|choice|assistant)\b|#\s*1\s+(?:rated|ranked|selling)\b/i,
  /\bnumber one\b/i,
  /\bworld'?s (?:best|leading|first)\b/i,
  /\bguaranteed\s+(?:results?|success|accurate|accuracy|profits?|savings|rankings?)\b/i,
  // `\s*`, not `\s+`: "100%guaranteed" is the same claim as "100% guaranteed".
  /\b100\s*%\s*guarantee(?:d)?\b/i,
  /\bunlimited free\b/i,
  /\bofficial(?:ly)? (?:endorsed|approved) by openai\b/i,
  /\bmost popular\b/i,
];

function promotionalHits(text: string): string[] {
  return PROMOTIONAL_PHRASES.flatMap((pattern) => {
    const match = pattern.exec(text);
    return match ? [match[0]] : [];
  });
}

export function runOpenAIPolicyChecks(
  evidence: OpenAIPolicyEvidence,
  stamp: OpenAICheckStamp,
): OpenAIReadinessFinding[] {
  const { profile } = evidence;

  const findings: OpenAIReadinessFinding[] = [];

  /** Grade one source of self-description against the phrase list. */
  const gradeCopy = (
    definition: OpenAICheckDefinition,
    copy: { field: string; text: string }[],
    absent: () => OpenAIReadinessFinding,
  ): OpenAIReadinessFinding => {
    if (copy.length === 0) return absent();
    const hits = copy.flatMap((entry) =>
      promotionalHits(entry.text).map((phrase) => ({
        field: entry.field,
        phrase,
      })),
    );
    return hits.length === 0
      ? satisfied(definition, stamp, { fieldsRead: copy.length })
      : violated(
          definition,
          stamp,
          `Remove the promotional or ranking claims: ${hits
            .map((hit) => `${hit.field}: "${hit.phrase}"`)
            .join("; ")}.`,
          {
            hits,
            portalIssues: [
              openaiPortalIssue("listing-promotional-metadata", {
                observed: [...new Set(hits.map((hit) => hit.field))].join(", "),
              }),
            ],
          },
        );
  };

  findings.push(
    gradeCopy(NON_PROMOTIONAL_PACKAGE, evidence.packageMetadata ?? [], () =>
      // No package is not a gap here: an MCP-only submission has no package
      // copy, and asking for one would be asking for something that shape
      // does not have.
      notApplicable(
        NON_PROMOTIONAL_PACKAGE,
        stamp,
        "this run inspected no package, so there is no package copy to read",
      ),
    ),
  );

  findings.push(
    gradeCopy(
      NON_PROMOTIONAL_LISTING,
      profile
        ? [
            { field: "listing.name", text: profile.name },
            {
              field: "listing.shortDescription",
              text: profile.shortDescription,
            },
            { field: "listing.description", text: profile.description },
          ]
        : [],
      () =>
        notEvaluated(
          NON_PROMOTIONAL_LISTING,
          stamp,
          "no submission profile was supplied, so there is no listing copy to read",
          missingInput(OPENAI_READINESS_INPUTS.submissionProfile),
        ),
    ),
  );

  // Whether a plugin carries advertising is not visible in a listing form, and
  // there is no attestation that says so directly. It is a manual-review item
  // in experience-insights, so reporting it unevaluated costs no lane its
  // verdict.
  findings.push(
    notEvaluated(
      NO_ADVERTISING,
      stamp,
      "no declared field states whether the plugin carries advertising; a reviewer sees this by using it",
    ),
  );

  findings.push(
    evidence.hasCommerce
      ? notEvaluated(
          COMMERCE_RESTRICTIONS,
          stamp,
          "this plugin sells something; conformance to the checkout conversion spec is beyond what this run inspects",
          { hasCommerce: true },
        )
      : // No observed commerce surface and no declaration of one. Treated as
        // inapplicable rather than unevaluable, on the same basis as the UI
        // rules against a plugin with no UI: the rules attach to a surface, and
        // this submission does not have it. A submission that DOES sell says so
        // via `hasCommerce`, and then this becomes a gap rather than a pass.
        notApplicable(
          COMMERCE_RESTRICTIONS,
          stamp,
          "this run observed no checkout surface and the submission declares none, so the commerce rules do not attach",
        ),
  );

  // -------------------------------------------------------------- judgement
  //
  // Each names WHAT to look at. "A human has to look" with no object is a
  // shrug; with one it is a task.
  findings.push(
    notEvaluated(
      ORIGINALITY,
      stamp,
      "whether this plugin is the submitter's own work, or authorized by whoever owns the service it fronts, cannot be established from a submission",
      {
        attested: profile?.attestations.ownsOrIsAuthorizedForService === true,
      },
    ),
  );
  findings.push(
    notEvaluated(
      PREDICTABLE_SIDE_EFFECTS,
      stamp,
      "whether a tool does what a user would expect needs someone to run it; the annotations say what it CLAIMS",
    ),
  );
  findings.push(
    notEvaluated(
      RESPONSE_MINIMIZATION,
      stamp,
      "whether a tool returns more than the task needs is visible only in its responses, which this run does not collect",
    ),
  );
  findings.push(
    notEvaluated(
      PRIVACY_CONSISTENCY,
      stamp,
      "whether the declared data types match what the plugin actually collects needs a person to read the privacy policy alongside the tools",
      { declaredDataTypes: profile?.privacyPolicyDataTypes ?? [] },
    ),
  );

  return findings;
}
