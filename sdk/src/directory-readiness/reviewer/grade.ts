/**
 * Findings from the reviewer path, and the rule that holds every check a flow
 * marks as needing the reviewer to the reviewer account.
 *
 * Each engine passes its own definitions, cited from its own directory's
 * documentation, as the decision checks do. A reviewer-path check that
 * reached no verdict says why and leaves the default gate, as evidence no run
 * gathered does: most submissions never set up a reviewer sign-in, and their
 * runs are not undetermined for it. `failOn` puts the check back.
 *
 * Pure. Safe from the browser entry.
 */

import {
  directoryBlockedReason,
  directoryPlacementOf,
} from "../flows/place.js";
import type { DirectoryFlow } from "../flows/types.js";
import {
  UNGATHERED_EVIDENCE_DETAIL_KEY,
  createFindingConstructors,
  type DirectoryCheckDefinition,
  type DirectoryCheckStamp,
} from "../helpers.js";
import type { DirectoryReadinessFinding } from "../types.js";
import {
  DIRECTORY_CLIENT_SIGNATURES,
  type DirectoryClientSignatureEvidence,
  type DirectoryClientSignatureProbe,
  type DirectoryReviewerPathEvidence,
  type DirectoryReviewerRunInput,
} from "./evidence.js";

export interface DirectoryReviewerChecks<Definition> {
  identity: Definition;
  fixtures: Definition;
  clientSignatures: Definition;
}

const NO_SUBMISSION =
  "This run graded no directory submission, so it had no reviewer account to check.";

const DOCUMENTS: Record<DirectoryClientSignatureProbe["document"], string> = {
  "protected-resource": "The protected resource metadata",
  "authorization-server": "The authorization server metadata",
};

export function gradeDirectoryReviewerPath<
  Lane extends string,
  SourceRef,
  Capability extends string,
>(
  input: DirectoryReviewerRunInput,
  checks: DirectoryReviewerChecks<
    DirectoryCheckDefinition<Lane, SourceRef, Capability>
  >,
  options: { engineVersion: string; stamp: DirectoryCheckStamp }
): DirectoryReadinessFinding<Lane, SourceRef, Capability>[] {
  const build = createFindingConstructors<Lane, SourceRef, Capability>(options);
  const { stamp } = options;
  const path = input.reviewerPath;
  type Definition = DirectoryCheckDefinition<Lane, SourceRef, Capability>;
  // Not checked: blocked with the reason, outside the default gate.
  const blocked = (definition: Definition, reason: string, details = {}) =>
    build.notEvaluated(definition, stamp, directoryBlockedReason(reason), {
      ...details,
      [UNGATHERED_EVIDENCE_DETAIL_KEY]: "reviewerPath",
    });
  const notGathered = (what: string) =>
    path && "missing" in path.account ? path.account.missing : what;

  const identity = (definition: Definition) => {
    if (!path) return build.notApplicable(definition, stamp, NO_SUBMISSION);
    if (!path.identity) {
      return blocked(
        definition,
        notGathered("MCPJam did not check who the reviewer is.")
      );
    }
    const details = { ...path.identity };
    const { outcome, reason, observed = {}, expected = {} } = path.identity;
    if (outcome === "verified")
      return build.satisfied(definition, stamp, details);
    if (outcome === "unverified") {
      return blocked(definition, `identity unverified: ${reason}`, details);
    }
    const [what, seen, wanted] =
      outcome === "wrong-account"
        ? ["is signed in as", observed.identity, expected.identity]
        : [
            "answers for organization",
            observed.organization,
            expected.organization,
          ];
    return build.violated(
      definition,
      stamp,
      `The reviewer account ${what} ${seen}, not ${wanted}. ${outcome === "wrong-account" ? "Rehearse the reviewer sign-in with the account the submission names" : "Leave the reviewer account in that one organization or project"}, then run again.`,
      details
    );
  };

  const fixtures = (definition: Definition) => {
    if (!path) return build.notApplicable(definition, stamp, NO_SUBMISSION);
    const evidence = path.fixtures;
    if (!evidence)
      return blocked(
        definition,
        notGathered("MCPJam did not look up the fixtures.")
      );
    const details = { ...evidence };
    if (evidence.blocked) return blocked(definition, evidence.blocked, details);
    if (evidence.fixtures.length === 0) {
      return build.notApplicable(
        definition,
        stamp,
        "The submission names no fixtures to look up."
      );
    }
    const missing = evidence.fixtures.filter(
      (entry) => entry.status === "missing"
    );
    if (missing.length > 0) {
      const names = missing.map((entry) => entry.name).join(", ");
      const cases = evidence.blockedCases.map((entry) => entry.case).join(", ");
      return build.violated(
        definition,
        stamp,
        `The reviewer account has no ${names}${cases ? `, which ${cases} need` : ""}. Create what is missing in that account, or change the cases that name it, then run again.`,
        details
      );
    }
    const unchecked = evidence.fixtures.filter(
      (entry) => entry.status === "unchecked"
    );
    return unchecked.length > 0
      ? blocked(
          definition,
          `fixtures not looked up: ${unchecked.map((entry) => `${entry.name}: ${entry.reason}`).join("; ")}`,
          details
        )
      : build.satisfied(definition, stamp, details);
  };

  const signatures = (
    definition: Definition,
    evidence: DirectoryClientSignatureEvidence | undefined
  ) => {
    if (!evidence?.probes.length) {
      return build.notEvaluated(
        definition,
        stamp,
        evidence
          ? "Discovery found no metadata document to request again."
          : "This run did not request discovery with other client signatures."
      );
    }
    const details = { ...evidence };
    const refused = evidence.probes.filter((probe) => probe.status >= 400);
    if (refused.length > 0) {
      return build.violated(
        definition,
        stamp,
        `${refused.map((probe) => `${DOCUMENTS[probe.document]} answered ${probe.status} to ${signatureLabel(probe.signature)}`).join("; ")}. Serve discovery to every client, or a directory's client may be refused the same way.`,
        details
      );
    }
    const unanswered = evidence.probes.filter((probe) => probe.status === 0);
    return unanswered.length > 0
      ? build.notEvaluated(
          definition,
          stamp,
          `${unanswered.map((probe) => `${DOCUMENTS[probe.document]} gave ${signatureLabel(probe.signature)} no answer (${probe.body})`).join("; ")}.`,
          details
        )
      : build.satisfied(definition, stamp, details);
  };

  return [
    identity(checks.identity),
    fixtures(checks.fixtures),
    signatures(checks.clientSignatures, input.clientSignatures),
  ];
}

function signatureLabel(id: string): string {
  return (
    DIRECTORY_CLIENT_SIGNATURES.find((entry) => entry.id === id)?.label ?? id
  );
}

/**
 * The reviewer-only rule. A check whose placement needs the reviewer runs on
 * the reviewer account or not at all: on a run without one it is blocked with
 * the reason, and a verdict it reached anyway is withdrawn, because it came
 * from another account. A run that graded no submission is left as it is.
 */
export function holdToReviewerAccount<
  Finding extends DirectoryReadinessFinding,
>(
  findings: readonly Finding[],
  flow: DirectoryFlow,
  account: DirectoryReviewerPathEvidence["account"] | undefined
): Finding[] {
  if (!account || !("missing" in account)) return [...findings];
  const reason = directoryBlockedReason(account.missing);
  return findings.map((finding): Finding => {
    const needs = directoryPlacementOf(flow, finding.id)?.needs ?? [];
    return !needs.includes("reviewer") || finding.status === "not-applicable"
      ? finding
      : {
          ...finding,
          status: "not-evaluated",
          notEvaluatedReason: reason,
          remediation: undefined,
          details: {
            ...finding.details,
            [UNGATHERED_EVIDENCE_DETAIL_KEY]: "reviewerAccount",
          },
        };
  });
}
