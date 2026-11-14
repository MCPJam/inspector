/**
 * Sample ChatGPT plugin submissions for the plugin page's tests: a stored
 * plugin with two versions, a run's results placed by the flow, and a
 * session the page reads. Sample names only.
 */
import { vi } from "vitest";
import {
  CHATGPT_PLUGIN_FLOW,
  directoryFlowField,
  placeDirectoryResults,
  validateDirectoryAnswers,
  type DirectoryAnswer,
  type DirectoryAnswerValue,
  type PlacedFinding,
} from "@mcpjam/sdk/browser";
import type { DirectorySubmissionSession } from "@/hooks/use-directory-submission";
import type { ReadinessRun } from "@/lib/apis/directory-readiness-api";
import type { SubmissionView } from "@/lib/apis/directory-submissions-api";
import type {
  PluginDetail,
  PluginSummary,
  PluginVersionDetail,
} from "@/lib/plugins/plugin-api-types";

export const flow = CHATGPT_PLUGIN_FLOW;

export function finding(
  id: string,
  status: PlacedFinding["finding"]["status"],
  overrides: Partial<PlacedFinding["finding"]> = {},
): PlacedFinding["finding"] {
  return {
    id,
    title: `Title of ${id}`,
    lane: "submission-artifacts",
    class: "required",
    status,
    remediation: status === "violated" ? `Fix ${id}.` : undefined,
    source: {},
    provenance: "wire",
    intrusiveness: "passive",
    evaluatedAt: "2026-11-13T10:00:00.000Z",
    engineVersion: "test",
    ...overrides,
  };
}

/** What an import from the package stored. */
export const IMPORTED: Record<string, DirectoryAnswerValue> = {
  "listing.displayName": "Sample Plugin",
  "listing.shortDescription": "Checks sample servers",
  "listing.description": "Inspect sample servers and review their results.",
  "listing.developer": "Sample Co",
  "listing.name": "sample-plugin",
  "listing.category": "Developer Tools",
  "listing.website": "https://example.com",
  "listing.privacyPolicy": "https://example.com/privacy",
};

export const answersOf = (
  values: Record<string, DirectoryAnswerValue>,
): DirectoryAnswer[] =>
  Object.entries(values).map(([key, value]) => ({
    key,
    value,
    origin: "imported",
  }));

export function view(
  overrides: Partial<SubmissionView> = {},
  {
    values = IMPORTED,
    findings = [],
  }: {
    values?: Record<string, DirectoryAnswerValue>;
    findings?: PlacedFinding["finding"][];
  } = {},
): SubmissionView {
  const answers = answersOf(values);
  return {
    id: "sub_1",
    projectId: "proj_1",
    serverId: "srv_1",
    directory: "openai",
    flowId: flow.id,
    flowVersion: flow.version,
    answers,
    revision: 4,
    createdBy: "user_1",
    pluginId: "plg_1",
    pluginVersionId: "ver_2",
    createdAt: 1,
    updatedAt: 2,
    fieldIssues: [],
    steps: placeDirectoryResults({ flow, answers, findings }),
    resultsRunId: findings.length > 0 ? "run_1" : null,
    lastRunId: findings.length > 0 ? "run_1" : undefined,
    submissionUrl: flow.submissionUrl,
    ...overrides,
  };
}

/** A finished run of the submission's version, four minutes ago. */
export function runRow(
  id: string,
  submission: SubmissionView,
  pluginVersionId = submission.pluginVersionId ?? null,
): ReadinessRun {
  const at = Date.now() - 4 * 60_000;
  return {
    id,
    readinessKind: "openai",
    serverId: "srv_1",
    serverUrl: "https://mcp.example.com/mcp",
    submissionMode: null,
    status: "completed",
    overallStatus: "not-ready",
    lanes: [],
    stages: [],
    authMode: "headless",
    capabilities: [],
    attemptCount: 1,
    resumable: false,
    terminalReason: null,
    errorMessage: null,
    policySnapshotDate: null,
    engineVersion: "test",
    sdkVersion: null,
    includeLlmObservations: false,
    llmObservations: { status: "not-requested" },
    hasReport: true,
    reportUrl: null,
    submissionId: submission.id,
    submissionRevision: submission.revision,
    pluginVersionId,
    testPlanRevision: null,
    createdAt: at,
    updatedAt: at,
  };
}

/** The session the page reads, with the plugin choice as a spy. */
export function session(
  submission: SubmissionView,
  overrides: Partial<DirectorySubmissionSession> = {},
): DirectorySubmissionSession {
  const values = Object.fromEntries(
    submission.answers.map(({ key, value }) => [key, value]),
  );
  const answered = new Set(Object.keys(values));
  return {
    flow,
    view: submission,
    values,
    // As the hook reports them: a package field nobody imported is not missing.
    issues: validateDirectoryAnswers(flow, submission.answers).filter(
      (issue) =>
        answered.has(issue.key) ||
        directoryFlowField(flow, issue.key)?.managedBy !== "package",
    ),
    reviewIssues: [],
    base: null,
    conflict: null,
    saving: false,
    savedAt: null,
    error: null,
    pluginSaving: false,
    pluginError: null,
    run: submission.resultsRunId
      ? { status: "done", run: runRow(submission.resultsRunId, submission) }
      : { status: "idle" },
    startRun: vi.fn(),
    setAnswer: vi.fn(),
    saveNow: vi.fn(),
    reapply: vi.fn(),
    keepSaved: vi.fn(),
    setPlugin: vi.fn(),
    ...overrides,
  };
}

export const PLUGIN: PluginSummary = {
  pluginId: "plg_1",
  projectId: "proj_1",
  name: "sample-plugin",
  displayName: "Sample Plugin",
  description: "Checks sample servers.",
  enabled: true,
  activeVersionId: "ver_2",
  createdAt: 1,
  updatedAt: 2,
};

const counts = { skills: 2, servers: 1, apps: 0, assets: 1, unsupported: 0 };

export const PLUGIN_DETAIL: PluginDetail = {
  ...PLUGIN,
  versions: [
    {
      pluginVersionId: "ver_2",
      pluginId: "plg_1",
      declaredVersion: "1.0.1",
      bundleHash: "b".repeat(64),
      status: "ready",
      componentCounts: counts,
      createdAt: 2,
    },
    {
      pluginVersionId: "ver_1",
      pluginId: "plg_1",
      declaredVersion: "1.0.0",
      bundleHash: "a".repeat(64),
      status: "ready",
      componentCounts: counts,
      createdAt: 1,
    },
  ],
};

export const VERSION: PluginVersionDetail = {
  ...PLUGIN_DETAIL.versions[0],
  manifestHash: "c".repeat(64),
  servers: [
    {
      componentId: "cmp_1",
      componentKey: "sample",
      declaredName: "sample",
      placement: "remote",
      authenticationPolicy: "on_use",
      httpVariant: "streamable-http",
    },
  ],
  skills: ["run-checks", "review-results"].map((name) => ({
    componentId: `skill_${name}`,
    componentKey: name,
    declaredName: name,
    modelRef: `sample-plugin/${name}`,
  })),
};
