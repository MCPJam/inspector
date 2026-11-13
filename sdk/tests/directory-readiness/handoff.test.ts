/**
 * The handoff summary an agent resumes from: built from the record alone, and
 * every next action it proposes is an operation MCPJam defines, with an input
 * that operation accepts.
 */

import { describe, expect, it } from "vitest";

import {
  CHATGPT_PLUGIN_FLOW,
  CLAUDE_CONNECTOR_FLOW,
  directoryFindingPlace,
} from "../../src/directory-readiness/flows/index.js";
import {
  buildDirectoryHandoff,
  type DirectoryNextAction,
} from "../../src/directory-readiness/handoff.js";
import { ALL_OPERATIONS } from "../../src/platform/operations.js";
import {
  answer,
  completeAnswers,
} from "../support/claude-connector-answers.js";
import {
  event,
  finding,
  handoffInput,
  snapshot,
} from "../support/directory-handoff.js";

const URL = CLAUDE_CONNECTOR_FLOW.submissionUrl;
const WRITE = { project: "project-1", submission: "sub-1", expectedRevision: 4 };

/** A run that found an https blocker, a tool blocker, stale listing evidence, a blocked and an unsure check. */
const FINDINGS = [
  finding("claude.endpoint.https", { status: "violated", remediation: "Serve the endpoint over https." }),
  finding("claude.tools.title-present", { status: "violated" }),
  finding("claude.submission.listing-fields", { lane: "submission-artifacts" }),
  finding("claude.auth.access-token-audience", { status: "not-evaluated", notEvaluatedReason: "No reviewer sign-in." }),
  finding("claude.experience.tool-overlap", {
    lane: "experience-insights",
    class: "heuristic",
    status: "informational",
    provenance: "llm",
    details: { confidence: "low" },
  }),
];

function gradedInput(overrides: Parameters<typeof handoffInput>[0] = {}) {
  return handoffInput({
    answers: completeAnswers(),
    gradedAnswers: completeAnswers([answer("listing.oneLiner", "An older line")]),
    findings: FINDINGS,
    ...overrides,
  });
}

describe("buildDirectoryHandoff", () => {
  it("starts an empty draft at its first step, with what is missing and how to fill it", () => {
    const handoff = buildDirectoryHandoff(handoffInput());
    expect(handoff.status).toBeNull();
    expect(handoff.currentStep).toBe("connection");
    expect(handoff.missingRequired).toContainEqual({ key: "listing.name", step: "listing", label: "Name" });
    expect(handoff.unconfirmedDeclarations).toContainEqual(
      expect.objectContaining({ key: "useCases.access", origin: "default", value: "read-only" })
    );
    const [answers, declarations, run] = handoff.nextActions;
    expect(answers).toMatchObject({ operation: "update_directory_submission", input: WRITE });
    expect(answers!.fields).toContain("listing.name");
    expect(declarations).toMatchObject({ operation: "update_directory_submission", input: WRITE });
    expect(declarations!.fields).toContain("useCases.access");
    expect(run).toEqual({
      operation: "start_directory_submission_run",
      why: "No run has graded this submission yet.",
      input: { project: "project-1", submission: "sub-1" },
    });
    expect(handoff.unknowns.map((entry) => entry.about)).toEqual(["status", "snapshot"]);
    expect(handoff.remainingPortalActions).toEqual([
      { action: "connect", step: "connection", label: "Connection", url: URL },
      {
        action: "attest",
        step: "testLaunch",
        field: "testLaunch.selfTested",
        label: "I have run every tool via MCP Inspector or as a custom connector in Claude",
        url: URL,
      },
      {
        action: "attest",
        step: "compliance",
        field: "compliance.acknowledgments",
        label: "Policy acknowledgements",
        url: URL,
      },
      { action: "submit", step: "review", label: "Submit for review", url: URL },
    ]);
    expect(handoff.links).toEqual({ submissionUrl: URL, managementUrl: null, statusLink: null });
  });

  it("reads the latest status someone recorded, and says when it was uncertain", () => {
    const handoff = buildDirectoryHandoff(
      handoffInput({
        events: [
          event("status", { state: "in-review", uncertain: true, createdAt: 20, reportedOrObserved: "observed" }),
          event("credential", { state: "saved", createdAt: 30 }),
          event("status", { state: "submitted", createdAt: 10, link: "https://claude.ai/directory/manage/1" }),
        ],
      })
    );
    expect(handoff.status).toEqual({
      state: "in-review",
      uncertain: true,
      reportedOrObserved: "observed",
      actor: "user-1",
      createdAt: 20,
    });
    expect(handoff.unknowns[0]).toEqual({
      about: "status",
      detail: "The latest status, in-review, was recorded as uncertain. Check the portal before you try again.",
    });
    // Submitted: only publishing would be left, and Claude's form has no publish step.
    expect(handoff.remainingPortalActions).toEqual([]);
  });

  it("counts findings by evidence status and step, and lists blockers with their step and field", () => {
    const handoff = buildDirectoryHandoff(gradedInput());
    expect(handoff.counts.byEvidence).toEqual({
      established: 2,
      inconclusive: 1,
      stale: 1,
      "not-tested": 0,
      blocked: 1,
    });
    expect(handoff.counts.findings).toBe(5);
    expect(handoff.counts.blockers).toBe(2);
    expect(handoff.counts.steps.find((entry) => entry.step === "tools")).toMatchObject({
      title: "Tools",
      findings: 2,
      blockers: 1,
    });
    expect(handoff.blockers).toEqual([
      {
        checkId: "claude.endpoint.https",
        title: "Check claude.endpoint.https",
        remediation: "Serve the endpoint over https.",
        step: "connection",
        field: "connection.serverUrl",
      },
      { checkId: "claude.tools.title-present", title: "Check claude.tools.title-present", step: "tools" },
    ]);
    expect(handoff.verdict.verdict).toBe("not-ready");
    expect(handoff.currentStep).toBe("connection");
    expect(handoff.nextActions.find((entry) => entry.operation === "start_directory_submission_run")?.why).toBe(
      "1 finding read an answer that changed since the run. Run again to recheck them."
    );
    expect(handoff.unknowns).toContainEqual({
      about: "check",
      id: "claude.auth.access-token-audience",
      detail: "It fails the run when violated, and has no current verdict: No reviewer sign-in.",
    });
  });

  it("follows the submission's gate: warn only drops a blocker, fail on adds one", () => {
    const flagged = finding("claude.scan.cross-tool-direction-candidates", { status: "violated", class: "manual-review" });
    const input = gradedInput({
      findings: [...FINDINGS, flagged],
      checkGate: { warnOnly: ["claude.endpoint.https"], failOn: [flagged.id] },
    });
    const handoff = buildDirectoryHandoff(input);
    expect(handoff.blockers.map((entry) => entry.checkId)).toEqual([
      "claude.tools.title-present",
      "claude.scan.cross-tool-direction-candidates",
    ]);
    expect(handoff.verdict.gate).toEqual({ failOn: [flagged.id], warnOnly: ["claude.endpoint.https"] });
  });

  it("names reviewer credentials by their secret, never a value, and tracks saved, tested and delivered", () => {
    const input = handoffInput({
      flow: CHATGPT_PLUGIN_FLOW,
      answers: [answer("reviewer.passwordSecret", "REVIEWER_PASSWORD")],
      events: [event("credential", { state: "saved", createdAt: 1 }), event("credential", { state: "tested", createdAt: 2 })],
    });
    const handoff = buildDirectoryHandoff(input);
    expect(handoff.credentials).toMatchObject({
      secrets: [{ key: "reviewer.passwordSecret", label: "Password", secretName: "REVIEWER_PASSWORD" }],
      saved: { createdAt: 1, actor: "user-1" },
      tested: { createdAt: 2 },
      delivered: null,
    });
    expect(handoff.remainingPortalActions).toContainEqual({
      action: "enter-secret",
      step: "reviewer",
      field: "reviewer.passwordSecret",
      label: "Password",
      secretName: "REVIEWER_PASSWORD",
      url: CHATGPT_PLUGIN_FLOW.submissionUrl,
    });
    input.events = [...input.events, event("credential", { state: "delivered", createdAt: 3 })];
    const delivered = buildDirectoryHandoff(input);
    expect(delivered.remainingPortalActions.map((entry) => entry.action)).not.toContain("enter-secret");
    expect(delivered.remainingPortalActions.map((entry) => entry.action)).toEqual([
      "upload",
      "connect",
      "attest",
      "submit",
      "publish",
    ]);
  });

  it("leaves only publishing once submitted, and nothing once published", () => {
    const at = (state: string) =>
      buildDirectoryHandoff(handoffInput({ flow: CHATGPT_PLUGIN_FLOW, events: [event("status", { state })] }))
        .remainingPortalActions;
    expect(at("approved")).toEqual([
      { action: "publish", step: "publish", label: "Publish plugin", url: CHATGPT_PLUGIN_FLOW.submissionUrl },
    ]);
    expect(at("published")).toEqual([]);
    expect(at("changes-requested").map((entry) => entry.action)).toContain("submit");
  });

  it("keeps a refresh open while the directory's copy differs from production, even once published", () => {
    const handoff = buildDirectoryHandoff(
      handoffInput({
        events: [event("status", { state: "published" })],
        snapshots: {
          candidate: snapshot("candidate", 12, "fixed"),
          production: snapshot("production", 12, "fixed"),
          directory: snapshot("directory", 10, "old"),
          published: null,
        },
      })
    );
    expect(handoff.snapshots.differs).toEqual([{ from: "production", to: "directory" }]);
    expect(handoff.snapshots.latest.directory).toMatchObject({
      revisionNumber: 10,
      contractHash: "old",
      counts: { tools: 64 },
      serverId: "server-1",
    });
    expect(handoff.remainingPortalActions).toEqual([
      {
        action: "connect",
        step: "connection",
        label: "Connection",
        url: URL,
        why: "The production and directory catalogs differ. Reconnect here so the directory reads your tools again, then record a new directory snapshot.",
      },
    ]);
    expect(handoff.nextActions).toContainEqual({
      operation: "diff_server_revisions",
      why: "The production and directory catalogs differ. Read which tools changed between them.",
      input: { project: "project-1", server: "server-1", revisionNumber: 10, fromRevisionNumber: 12 },
    });
    expect(handoff.unknowns.map((entry) => entry.about)).not.toContain("snapshot");
  });

  it("calls a directory snapshot with no revision unknown", () => {
    const handoff = buildDirectoryHandoff(handoffInput({ snapshots: { directory: snapshot("directory", null) } }));
    expect(handoff.snapshots.latest.directory).not.toHaveProperty("contractHash");
    expect(handoff.unknowns).toContainEqual(expect.objectContaining({ about: "snapshot", id: "directory" }));
  });

  it("points at the run in flight, or at its resume, instead of a new run", () => {
    const running = buildDirectoryHandoff(handoffInput({ latestRun: { id: "run-2", status: "running", resumable: false } }));
    expect(running.nextActions.map((entry) => entry.operation)).toEqual([
      "get_readiness_run",
      "update_directory_submission",
      "update_directory_submission",
    ]);
    const stopped = buildDirectoryHandoff(handoffInput({ latestRun: { id: "run-2", status: "pending", resumable: true } }));
    expect(stopped.nextActions[0]).toEqual({
      operation: "resume_readiness_run",
      why: "The latest run stopped before it finished. Only the person who started it can resume it.",
      input: { project: "project-1", run: "run-2" },
    });
    expect(stopped.run).toEqual({ resultsRunId: null, latest: { id: "run-2", status: "pending", resumable: true } });
  });

  it("names only operations in MCPJam's catalog, each with an input it accepts", () => {
    const actions: DirectoryNextAction[] = [
      handoffInput(),
      gradedInput(),
      handoffInput({ latestRun: { id: "run-2", status: "running", resumable: false } }),
      handoffInput({ latestRun: { id: "run-2", status: "pending", resumable: true } }),
      handoffInput({
        snapshots: { production: snapshot("production", 12, "fixed"), directory: snapshot("directory", 10, "old") },
      }),
    ].flatMap((input) => buildDirectoryHandoff(input).nextActions);
    const keys = new Set(CLAUDE_CONNECTOR_FLOW.steps.flatMap((step) => step.fields.map((field) => field.key)));
    for (const action of actions) {
      const operation = ALL_OPERATIONS.find((entry) => entry.name === action.operation);
      expect(operation, action.operation).toBeDefined();
      const parsed = operation!.inputSchema.safeParse(action.input);
      expect(parsed.success, `${action.operation}: ${JSON.stringify(action.input)}`).toBe(true);
      for (const key of action.fields ?? []) expect(keys.has(key), key).toBe(true);
    }
    expect(new Set(actions.map((entry) => entry.operation))).toEqual(
      new Set([
        "update_directory_submission",
        "start_directory_submission_run",
        "get_readiness_run",
        "resume_readiness_run",
        "diff_server_revisions",
      ])
    );
  });
});

describe("directoryFindingPlace", () => {
  it("places a finding by its placement, else its lane, else the last step", () => {
    expect(directoryFindingPlace(CLAUDE_CONNECTOR_FLOW, { id: "claude.endpoint.https", lane: "directory-policy" })).toEqual({
      step: "connection",
      field: "connection.serverUrl",
    });
    expect(directoryFindingPlace(CLAUDE_CONNECTOR_FLOW, { id: "claude.new-check", lane: "submission-artifacts" })).toEqual({
      step: "listing",
    });
    expect(directoryFindingPlace(CLAUDE_CONNECTOR_FLOW, { id: "claude.new-check", lane: "nowhere" })).toEqual({
      step: "review",
    });
  });
});
