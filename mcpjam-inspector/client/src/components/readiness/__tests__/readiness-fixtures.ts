/**
 * Sample results and submissions for the Readiness page's tests: the
 * Claude flow as the API serves it, findings built by hand, and a submission
 * that places them on the flow's steps.
 */
import {
  CLAUDE_CONNECTOR_FLOW,
  claudePolicySource,
  placeDirectoryResults,
  type DirectoryAnswer,
  type PlacedFinding,
} from "@mcpjam/sdk/browser";
import type { SubmissionView } from "@/lib/apis/directory-submissions-api";

export const flow = CLAUDE_CONNECTOR_FLOW;
export const SCOPE = { projectId: "proj_1", submissionId: "sub_1" };

export const LISTING_FIELDS = "claude.submission.listing-fields";
export const LISTING_URLS = "claude.submission.urls";
export const HTTPS = "claude.endpoint.https";

const TITLES: Record<string, string> = {
  [LISTING_FIELDS]: "Listing fields follow the portal's rules",
  [LISTING_URLS]: "Listing links answer",
  [HTTPS]: "The server URL uses https",
};

export function finding(
  id: string,
  overrides: Partial<PlacedFinding["finding"]> = {},
): PlacedFinding["finding"] {
  return {
    id,
    title: TITLES[id] ?? `Title of ${id}`,
    lane: "submission-artifacts",
    class: "required",
    status: "violated",
    remediation: "Add a one-liner of 200 characters or fewer.",
    source: claudePolicySource("submission", "Listing fields"),
    provenance: "declared",
    intrusiveness: "passive",
    evaluatedAt: "2026-11-13T10:42:00.000Z",
    engineVersion: "1.4.0",
    ...overrides,
  };
}

/** The last run: a Listing blocker, a passing recommended check, https. */
export const RUN_FINDINGS = [
  finding(LISTING_FIELDS),
  finding(LISTING_URLS, { class: "recommended", status: "satisfied" }),
  finding(HTTPS, { status: "satisfied", provenance: "wire" }),
];

export function submissionView(
  findings: PlacedFinding["finding"][] = RUN_FINDINGS,
  overrides: Partial<SubmissionView> = {},
): SubmissionView {
  const answers: DirectoryAnswer[] = [
    { key: "listing.name", value: "Sample server", origin: "set", revision: 2 },
  ];
  return {
    id: SCOPE.submissionId,
    projectId: SCOPE.projectId,
    serverId: "srv_1",
    directory: "claude",
    flowId: flow.id,
    flowVersion: flow.version,
    answers,
    revision: 3,
    createdBy: "user_1",
    createdAt: 1,
    updatedAt: 3,
    fieldIssues: [],
    steps: placeDirectoryResults({ flow, answers, findings }),
    resultsRunId: findings.length > 0 ? "run_7" : null,
    submissionUrl: flow.submissionUrl,
    ...overrides,
  };
}
