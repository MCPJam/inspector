import type { MetadataSnapshot } from "./eval-tool-metadata";
import { deriveQuery, deriveExpectedToolCalls } from "@/shared/steps";
import { create } from "zustand";
import type { GenerationOptions } from "@/lib/apis/evals-api";
import { generateId } from "ai";
import {
  mintCaseId,
  stepsSchema,
  authoredEvalCaseSchema,
  authoredCaseBlockedReason,
  authoringDraftCheckReason,
  type EvalAuthoringDraft,
  type TestStep,
} from "@mcpjam/sdk/contract";
import {
  authoringRequest,
  AuthoringRequestError,
  readAuthoringJob,
} from "@/lib/apis/eval-authoring-api";
import type { EvalAgentScope } from "@/shared/eval-agent-scope";
import type { CreateEvalTestCaseInput } from "@/lib/evals/generate-and-persist-tests";

export interface EvalDraft {
  title: string;
  expectedOutput?: string;
  steps: TestStep[];
}
export interface EvalDraftBridge {
  read: () => {
    draft: EvalDraft;
    revision: string;
    tools: unknown[];
    metadata?: MetadataSnapshot;
  };
  retryTools?: (serverId?: string) => Promise<void>;
  edit: (revision: string, patch: Partial<EvalDraft>) => unknown;
  undo: (revision: string) => unknown;
}
export interface EvalSuiteBridge {
  read: () => unknown;
  save: (input: CreateEvalTestCaseInput) => Promise<unknown>;
  run?: () => Promise<unknown>;
}
const drafts = new Map<string, EvalDraftBridge>();
const suites = new Map<string, EvalSuiteBridge>();
export const useEvalContextVersion = create(() => ({ version: 0 }));
export function notifyEvalContextChanged() {
  useEvalContextVersion.setState((state) => ({ version: state.version + 1 }));
}
/** Suite history is optional; a readable draft and useful metadata are enough to describe a case. */
export function readEvalContext(scope: EvalAgentScope) {
  let currentCase: ReturnType<EvalDraftBridge["read"]> | undefined;
  let suite: unknown;
  try {
    currentCase = getEvalDraft(scope).read();
  } catch {
    /* Editor is mounting. */
  }
  try {
    suite = getEvalSuite(scope).read();
  } catch {
    /* Suite details can arrive later. */
  }
  const servers = currentCase?.metadata?.servers;
  let status: "loading" | "ready" | "partial" | "empty" | "error" = "loading";
  if (currentCase) {
    if (!servers)
      status = "ready"; // Non-Describe bridges retain their existing contract.
    else if (servers.some((s) => s.status === "ready"))
      status = servers.every(
        (s) => s.status === "ready" || s.status === "empty",
      )
        ? "ready"
        : "partial";
    else if (servers.some((s) => s.status === "loading")) status = "loading";
    else if (servers.some((s) => s.status === "error")) status = "error";
    else status = "empty";
  }
  return {
    status,
    suiteStatus: suite === undefined ? "loading" : "ready",
    suite,
    case: currentCase,
  };
}
export function isEvalContextReady(scope: EvalAgentScope) {
  const { status } = readEvalContext(scope);
  return status === "ready" || status === "partial";
}

let activeDraftScope: EvalAgentScope | undefined;
let activeSuiteScope:
  Omit<EvalAgentScope, "id" | "kind" | "version"> | undefined;
export function currentEvalPageScope() {
  if (activeDraftScope) {
    const {
      id: _id,
      kind: _kind,
      version: _version,
      ...scope
    } = activeDraftScope;
    try {
      return {
        ...scope,
        caseTitle: getEvalDraft(activeDraftScope).read().draft.title,
        hasCaseContent: getEvalDraft(activeDraftScope)
          .read()
          .draft.steps.some(
            (step) => step.kind !== "prompt" || Boolean(step.prompt.trim()),
          ),
      };
    } catch {
      return scope;
    }
  }
  return activeSuiteScope;
}
export function evalSuiteKey(
  scope: Pick<EvalAgentScope, "projectId" | "suiteId">,
) {
  return JSON.stringify([scope.projectId, scope.suiteId]);
}
function draftKey(
  scope: Pick<EvalAgentScope, "projectId" | "suiteId" | "caseId">,
) {
  return JSON.stringify([scope.projectId, scope.suiteId, scope.caseId]);
}
export function registerEvalDraft(
  scope: EvalAgentScope,
  bridge: EvalDraftBridge,
) {
  const key = draftKey(scope);
  drafts.set(key, bridge);
  activeDraftScope = scope;
  notifyEvalContextChanged();
  return () => {
    if (drafts.get(key) === bridge) {
      drafts.delete(key);
      if (activeDraftScope === scope) activeDraftScope = undefined;
      notifyEvalContextChanged();
    }
  };
}
export function getEvalDraft(scope: EvalAgentScope) {
  const bridge = drafts.get(draftKey(scope));
  if (!bridge)
    throw new Error(
      "Return to the selected case editor before reading or changing its draft.",
    );
  return bridge;
}
export function registerEvalSuite(
  scope: Pick<EvalAgentScope, "projectId" | "suiteId" | "suiteName">,
  bridge: EvalSuiteBridge,
) {
  const key = evalSuiteKey(scope);
  suites.set(key, bridge);
  activeSuiteScope = scope;
  notifyEvalContextChanged();
  return () => {
    if (suites.get(key) === bridge) {
      suites.delete(key);
      if (activeSuiteScope === scope) activeSuiteScope = undefined;
      notifyEvalContextChanged();
    }
  };
}
export function getEvalSuite(scope: EvalAgentScope) {
  const bridge = suites.get(evalSuiteKey(scope));
  if (!bridge)
    throw new Error(
      "Return to the selected eval suite to continue. No navigation was performed.",
    );
  return bridge;
}
export function parseDraftPatch(
  args: Record<string, unknown>,
): Partial<EvalDraft> {
  const patch: Partial<EvalDraft> = {};
  if (args.title !== undefined) {
    if (typeof args.title !== "string" || !args.title.trim())
      throw new Error("Case title must not be empty.");
    patch.title = args.title.trim();
  }
  if (args.steps !== undefined) {
    patch.steps = stepsSchema.parse(args.steps);
    if (new Set(patch.steps.map((s) => s.id)).size !== patch.steps.length)
      throw new Error("Step ids must be unique.");
  }
  if (Object.keys(patch).length === 0)
    throw new Error("Provide title or steps to edit.");
  return patch;
}
export interface GeneratedDraft {
  authoring?: EvalAuthoringDraft;
  authoringPrepared?: boolean;
  issueResolutions?: Record<string, string>;
  acceptedAdditionIds?: string[];
  /**
   * The authoring job that staged this draft.
   *
   * Recorded HERE rather than derived from `authoring.draftId`: the status
   * query answers `draftId` as the Convex row id
   * (`convex/evalAuthoringState.ts`), overwriting the `<jobId>:<n>` form the
   * worker wrote into the draft JSON, so the id carries no job.
   */
  authoringJobId?: string;
  id: string;
  revision: string;
  input: CreateEvalTestCaseInput;
  saving?: boolean;
  error?: string;
}
export interface GenerationState {
  availableTools?: Array<{
    name: string;
    description?: string;
    inputSchema?: unknown;
    serverId?: string;
  }>;
  suiteServers?: string[];
  authoringJobId?: string;
  /**
   * What the running job is authoring FROM.
   *
   * A suite with no cases yet and an import in flight is not an empty suite
   * waiting to be filled — it is an import in progress, and it belongs on the
   * import surface rather than behind "No cases yet".
   */
  authoringSource?: "markdown" | "generation" | "agent" | "import";
  reviewRequestId?: string;
  /**
   * The `reviewRequestId` the reader has already been shown and dismissed.
   *
   * Lives in the store, not in component state, because the suite page
   * unmounts: navigating away and back, or a reload, made a dismissal look
   * like a fresh import, and a fresh import look like one already dismissed.
   * Persisted with the drafts it is about.
   */
  reviewSeenId?: string;
  status: "running" | "ready" | "error";
  error?: string;
  drafts: GeneratedDraft[];
}
const GENERATION_KEY = "mcpjam:eval-generated-drafts:v1";
function loadGeneration(): Record<string, GenerationState> {
  try {
    const raw = JSON.parse(localStorage.getItem(GENERATION_KEY) ?? "{}");
    return Object.fromEntries(
      Object.entries(raw).flatMap(([key, value]) => {
        const state = value as GenerationState;
        if (!Array.isArray(state?.drafts)) return [];
        const drafts = state.drafts
          .filter(
            (d) =>
              typeof d?.id === "string" &&
              typeof d.revision === "string" &&
              typeof d.input?.suiteId === "string" &&
              typeof d.input?.title === "string" &&
              stepsSchema.safeParse(d.input.steps).success,
          )
          .map((d) => ({ ...d, saving: false }));
        return [
          [
            key,
            {
              ...state,
              drafts,
              ...(state.status === "running"
                ? {
                    status: "error" as const,
                    error:
                      "Generation was interrupted by reload. Review retained drafts before generating again.",
                  }
                : {}),
            },
          ],
        ];
      }),
    );
  } catch {
    return {};
  }
}
export const useEvalGeneration = create<{
  suites: Record<string, GenerationState>;
}>(() => ({ suites: loadGeneration() }));
useEvalGeneration.subscribe((state) => {
  try {
    localStorage.setItem(GENERATION_KEY, JSON.stringify(state.suites));
  } catch {
    /* In-memory drafts remain usable if storage is full. */
  }
});
function updateGeneration(
  key: string,
  update: (state: GenerationState) => GenerationState,
) {
  useEvalGeneration.setState((s) => ({
    suites: {
      ...s.suites,
      [key]: update(s.suites[key] ?? { status: "ready", drafts: [] }),
    },
  }));
}
/**
 * Short label for the draft card's badge.
 *
 * `importedDraftBlockedReason` stays a full sentence because it is also thrown
 * as an error message on save. A pill needs the problem NAMED instead: the
 * sentence listed all three fields whichever one was missing, and sat in grey
 * body copy where it read as a hint rather than the reason Add was refused.
 */
export function importedDraftBlockedBadge(
  draft: GeneratedDraft,
): string | undefined {
  const reason = importedDraftBlockedReason(draft);
  if (!reason) return undefined;
  // Short form OF THE REASON. This used to list whichever of title/prompt/
  // expected outcome was empty, which was a different question: a case
  // blocked by its issues, or one that opens with a tool call and needs no
  // prompt, was labelled "Missing expected outcome" and sent the reader
  // hunting for a field that was never required.
  if (/blocking issues/i.test(reason)) return "Fix the issues";
  if (/case title/i.test(reason)) return "Missing title";
  if (/at least one step/i.test(reason)) return "No steps";
  if (/each prompt step/i.test(reason)) return "Empty prompt";
  if (/Step ids/i.test(reason)) return "Repeated step ids";
  if (/Negative cases/i.test(reason)) return "Tool call in a negative case";
  if (/assertion, expected outcome/i.test(reason)) return "Nothing to check";
  return "Can't be added";
}

/**
 * What the authoring model was unsure about, as one sentence.
 *
 * Distinct from `importedDraftBlockedReason`, which is a refusal: the case
 * cannot be written. This is a doubt — the case IS writable, and the model
 * said something about it that a person should read first. A draft carrying
 * one is kept out of "Add all" and saved one at a time, deliberately.
 */
export function draftCheckSummary(draft: GeneratedDraft): string | undefined {
  // The rule itself is in the SDK contract, because the API route applies the
  // same one to decide what it may save unattended. Only the closing
  // instruction is this surface's: an API caller has no steps "above".
  const reason = draft.authoring && authoringDraftCheckReason(draft.authoring);
  return reason ? `${reason}. Read the steps above before you save.` : undefined;
}

export function importedDraftBlockedReason(
  draft: GeneratedDraft,
): string | undefined {
  if (draft.authoring) {
    const parsed = authoredEvalCaseSchema.safeParse({
      ...draft.authoring.case,
      title: draft.input.title,
      steps: draft.input.steps,
      expectedOutput: draft.input.expectedOutput,
      runs: draft.input.runs,
      models: draft.input.models,
      isNegativeTest: draft.input.isNegativeTest,
      checks: draft.input.predicates ?? undefined,
      matchOptions: draft.input.matchOptions ?? undefined,
    });
    if (!parsed.success) return "Complete the case steps and settings.";
    const blocked = authoredCaseBlockedReason(parsed.data);
    if (blocked) return blocked;
    if (!draft.authoringPrepared) {
      const unresolved = draft.authoring.issues.some(
        (issue, index) =>
          issue.blocking &&
          !issue.resolution &&
          (issue.origin === "validation"
            ? JSON.stringify(parsed.data) ===
                JSON.stringify(draft.authoring!.case) &&
              (draft.issueResolutions?.[index]?.trim().length ?? 0) < 10
            : (draft.issueResolutions?.[index]?.trim().length ?? 0) < 10),
      );
      if (unresolved) return "Resolve the blocking issues before adding.";
    }
    // Additions are IN the steps, so the case on screen is the case that will
    // be saved: reading it is the review, and "Add to suite" is the consent.
    // A tick-box per addition asked for the same yes twice.
    return;
  }
}

export function startEvalGeneration(
  scope: EvalAgentScope,
  instructions: string,
  options?: GenerationOptions,
  /**
   * Environment suites: the environment whose servers the job discovers.
   * Required when the suite's environments connect different servers; the
   * server refuses to guess.
   */
  environmentId?: string,
) {
  const key = evalSuiteKey(scope);
  // Reading the suite is still the scope check: generation is only startable
  // from a suite the caller is actually on.
  getEvalSuite(scope);
  if (useEvalGeneration.getState().suites[key]?.status === "running")
    throw new Error(
      "Generation is already running. Read context for progress; do not start another job.",
    );
  updateGeneration(key, (s) => ({ ...s, status: "running", error: undefined }));
  void authoringRequest({
    operation: "start",
    input: {
      projectId: scope.projectId,
      suiteId: scope.suiteId,
      source: "generation",
      requestKey: crypto.randomUUID(),
      instructions:
        instructions.trim() || "Generate eval cases for the suite's tools.",
      options,
      ...(environmentId ? { environmentId } : {}),
    },
  })
    .then(({ jobId }) =>
      followAuthoringJob(scope, jobId, {
        takeOver: true,
        source: "generation",
      }),
    )
    .catch((error) =>
      updateGeneration(key, (state) => ({
        ...state,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      })),
    );
  return {
    status: "generation_started",
    note: "Drafts will appear for review. Read ui_eval_context for progress.",
  };
}
export function editGeneratedDraft(
  scope: EvalAgentScope,
  id: string,
  revision: string,
  patch: Partial<EvalDraft> &
    Pick<
      Partial<CreateEvalTestCaseInput>,
      | "expectedOutput"
      | "matchOptions"
      | "predicates"
      | "runs"
      | "models"
      | "isNegativeTest"
    >,
) {
  const key = evalSuiteKey(scope);
  const current = useEvalGeneration
    .getState()
    .suites[key]?.drafts.find((d) => d.id === id);
  if (
    !current ||
    current.revision !== revision ||
    current.saving ||
    current.authoringPrepared
  )
    throw new Error(
      "Generated draft changed or is unavailable. Read context before retrying.",
    );
  const nextRevision = generateId();
  updateGeneration(key, (s) => ({
    ...s,
    drafts: s.drafts.map((d) =>
      d.id === id
        ? {
            ...d,
            revision: nextRevision,
            ...(d.authoring ? { acceptedAdditionIds: [] } : {}),
            input: {
              ...d.input,
              ...patch,
              ...(patch.steps
                ? {
                    query: deriveQuery(patch.steps),
                    expectedToolCalls: deriveExpectedToolCalls(patch.steps),
                  }
                : {}),
            },
          }
        : d,
    ),
  }));
  return {
    status: "updated",
    draftId: id,
    revision: nextRevision,
    changedFields: Object.keys(patch),
  };
}
/** Discard only an unsaved draft; pending saves must finish first. */
export function removeGeneratedDraft(scope: EvalAgentScope, id: string) {
  const key = evalSuiteKey(scope);
  const current = useEvalGeneration
    .getState()
    .suites[key]?.drafts.find((draft) => draft.id === id);
  if (!current || current.saving) return;
  updateGeneration(key, (state) => ({
    ...state,
    drafts: state.drafts.filter((draft) => draft.id !== id),
  }));
}

export async function saveGeneratedDraft(scope: EvalAgentScope, id: string) {
  const key = evalSuiteKey(scope);
  const current = useEvalGeneration
    .getState()
    .suites[key]?.drafts.find((d) => d.id === id);
  if (!current || current.saving) return;
  updateGeneration(key, (s) => ({
    ...s,
    drafts: s.drafts.map((d) =>
      d.id === id ? { ...d, saving: true, error: undefined } : d,
    ),
  }));
  try {
    if (current.input.suiteId !== scope.suiteId)
      throw new Error("Draft is outside the selected suite.");
    if (!current.input.title.trim())
      throw new Error("Add a case title before saving.");
    if (
      !current.input.steps?.length ||
      current.input.steps.some(
        (step) => step.kind === "prompt" && !step.prompt.trim(),
      )
    )
      throw new Error("Complete the case steps before saving.");
    stepsSchema.parse(current.input.steps);
    if (current.authoring) {
      const blocked = importedDraftBlockedReason(current);
      if (blocked) throw new Error(blocked);
      const authored = authoredEvalCaseSchema.parse({
        ...current.authoring.case,
        title: current.input.title,
        steps: current.input.steps,
        expectedOutput: current.input.expectedOutput,
        runs: current.input.runs,
        models: current.input.models,
        isNegativeTest: current.input.isNegativeTest,
        checks: current.input.predicates ?? undefined,
        matchOptions: current.input.matchOptions ?? undefined,
      });
      let revision = current.authoring.revision;
      if (
        !current.authoringPrepared &&
        (JSON.stringify(authored) !== JSON.stringify(current.authoring.case) ||
          Object.keys(current.issueResolutions ?? {}).length)
      ) {
        const edited = await authoringRequest({
          operation: "edit",
          draftId: current.authoring.draftId,
          revision,
          case: authored,
          resolutions: current.issueResolutions,
        });
        revision = edited.revision;
        updateGeneration(key, (state) => ({
          ...state,
          drafts: state.drafts.map((draft) =>
            draft.id === id
              ? {
                  ...draft,
                  issueResolutions: {},
                  authoring: edited.draft,
                }
              : draft,
          ),
        }));
      }
      await authoringRequest({
        operation: "accept",
        draftId: current.authoring.draftId,
        revision,
        // Every addition is already in the steps the reader just approved.
        acceptedAdditionIds: current.authoring.additions.map(
          (addition) => addition.id,
        ),
      });
      updateGeneration(key, (state) => ({
        ...state,
        drafts: state.drafts.map((draft) =>
          draft.id === id ? { ...draft, authoringPrepared: true } : draft,
        ),
      }));
      const result = await authoringRequest({
        operation: "commit",
        suiteId: scope.suiteId,
        draftId: current.authoring.draftId,
        revision,
        caseId: current.input.caseId,
      });
      if (result.failed?.length) {
        updateGeneration(key, (state) => ({
          ...state,
          drafts: state.drafts.map((draft) =>
            draft.id === id ? { ...draft, authoringPrepared: false } : draft,
          ),
        }));
        throw new Error(result.failed[0].message);
      }
      if (result.committed?.length !== 1)
        throw new Error("Save outcome is unknown. Retry to confirm.");
    } else {
      await getEvalSuite(scope).save(current.input);
    }
    updateGeneration(key, (s) => ({
      ...s,
      drafts: s.drafts.filter((d) => d.id !== id),
    }));
  } catch (error) {
    updateGeneration(key, (s) => ({
      ...s,
      drafts: s.drafts.map((d) =>
        d.id === id
          ? {
              ...d,
              saving: false,
              error: error instanceof Error ? error.message : String(error),
            }
          : d,
      ),
    }));
  }
}

const startingRuns = new Set<string>();
const authoringPolls = new Set<string>();
/**
 * True once another job has taken this suite's follower over.
 *
 * `authoringJobId` is cleared when a job reaches a terminal state, so an empty
 * value means "nobody is following" rather than "someone else is" — only a
 * DIFFERENT id counts as a takeover.
 */
function supersededBy(key: string, jobId: string): boolean {
  const current = useEvalGeneration.getState().suites[key]?.authoringJobId;
  return Boolean(current && current !== jobId);
}
/** Resume polling persisted jobs after reload; disconnecting never cancels work. */
export async function followAuthoringJob(
  scope: Pick<EvalAgentScope, "projectId" | "suiteId">,
  jobId: string,
  options?: {
    /**
     * This job was just started from this tab, so it outranks whatever the
     * suite was pointing at.
     *
     * Without it a failed job kept its id on the suite, the next job read that
     * id as a newer follower and stood down before polling, and the suite sat
     * on "running" forever — one failed generation was enough to make the
     * Generate button refuse every retry.
     */
    takeOver?: boolean;
    /**
     * What this job is, when the caller already knows.
     *
     * The surface picks itself from `authoringSource`, which otherwise only
     * arrives with the first poll: an import started after a generation sat
     * behind "No cases yet" until the round trip landed, and a generation
     * started after an import flashed the import surface for the same beat.
     * Callers that cannot know (a resume, a review link for a job they have
     * not read) leave it out, and the poll fills it in.
     */
    source?: GenerationState["authoringSource"];
  },
) {
  if (authoringPolls.has(jobId)) return;
  const key = evalSuiteKey(scope);
  // Claiming the suite is itself a write, so an already-superseded job must
  // stand down BEFORE it announces itself — otherwise it takes the key back
  // from the job the reader opened and the guards below never fire.
  if (!options?.takeOver && supersededBy(key, jobId)) return;
  authoringPolls.add(jobId);
  updateGeneration(key, (state) => ({
    ...state,
    // The panel shows the job it is following, and only that one. A second
    // import used to append its cases to the first one's, so a six-case
    // document read back as twelve drafts — two of every case, one set
    // uncommittable because its job was already finished with.
    //
    // Drafts with no authoring job are a person's own staging (Describe, a
    // generated draft they have not saved) and are left alone.
    //
    // THIS job's drafts are kept. Re-following one is ordinary: the review
    // link is revisited, the component remounts, the tab is reloaded. Dropping
    // them here re-staged every draft from the server on the way back, which
    // threw away the local half of the review (typed issue resolutions,
    // accepted additions, edits made in the step editor) with nothing on
    // screen to say it had happened.
    drafts: state.drafts.filter(
      (draft) => !draft.authoring || draft.authoringJobId === jobId,
    ),
    authoringJobId: jobId,
    // Set with the claim, not on the first poll. Carrying the PREVIOUS job's
    // value into this one is the bug; `undefined` when the caller does not
    // know is merely unknown, and the poll settles it a beat later.
    authoringSource: options?.source,
    status: "running",
  }));
  try {
    let failures = 0;
    for (;;) {
      let status;
      try {
        status = await readAuthoringJob(jobId);
        failures = 0;
      } catch (error) {
        if (
          error instanceof AuthoringRequestError &&
          error.status < 500 &&
          ![408, 429].includes(error.status)
        )
          throw error;
        if (++failures > 3) throw error;
        updateGeneration(key, (state) => ({
          ...state,
          error:
            error instanceof Error
              ? error.message
              : "Could not read authoring job.",
        }));
        await new Promise((resolve) =>
          setTimeout(resolve, 1000 * 2 ** (failures - 1)),
        );
        continue;
      }
      // Two jobs can target one suite — a link to an older import opened
      // while a newer one is being followed. Both polls write to the same
      // store key, so the loser has to stand down rather than overwrite the
      // job the reader is actually looking at.
      if (supersededBy(key, jobId)) break;
      updateGeneration(key, (state) => {
        const known = new Set(state.drafts.map((d) => d.authoring?.draftId));
        const staged: GeneratedDraft[] = status.drafts
          .filter((draft) => !known.has(draft.draftId))
          .map((draft) => ({
            id: `authoring-${draft.draftId}`,
            revision: generateId(),
            authoring: draft,
            authoringJobId: jobId,
            acceptedAdditionIds: [],
            input: {
              suiteId: scope.suiteId!,
              caseId: mintCaseId(),
              title: draft.case.title,
              steps: draft.case.steps,
              query: deriveQuery(draft.case.steps),
              expectedToolCalls: deriveExpectedToolCalls(draft.case.steps),
              expectedOutput: draft.case.expectedOutput,
              models: draft.case.models,
              runs: draft.case.runs,
              isNegativeTest: draft.case.isNegativeTest,
              scenario: draft.case.scenario,
              predicates: draft.case
                .checks as CreateEvalTestCaseInput["predicates"],
              matchOptions: draft.case
                .matchOptions as CreateEvalTestCaseInput["matchOptions"],
            },
          }));
        return {
          ...state,
          drafts: [...state.drafts, ...staged],
          availableTools: status.availableTools,
          suiteServers: status.suiteServers,
          authoringSource: status.source,
          reviewRequestId: staged.length ? generateId() : state.reviewRequestId,
          status:
            status.status === "pending"
              ? "running"
              : status.status === "completed"
                ? "ready"
                : "error",
          error: status.error ?? undefined,
          authoringJobId:
            status.status === "pending" || status.status === "failed"
              ? jobId
              : undefined,
        };
      });
      if (status.status !== "pending") break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  } catch (error) {
    // Same standing-down rule as the poll loop: a superseded job's failure is
    // not news about the job the reader is watching.
    if (!supersededBy(key, jobId))
      updateGeneration(key, (state) => ({
        ...state,
        status: "error",
        error:
          error instanceof Error
            ? error.message
            : "Could not read authoring job. Reload to reconnect.",
      }));
  } finally {
    authoringPolls.delete(jobId);
  }
}
/** The reader has seen this suite's waiting drafts; stop opening on them. */
export function markImportReviewSeen(
  scope: Pick<EvalAgentScope, "projectId" | "suiteId">,
) {
  updateGeneration(evalSuiteKey(scope), (state) => ({
    ...state,
    reviewSeenId: state.reviewRequestId,
  }));
}

/** Show this suite's waiting drafts again, on request. */
export function reopenImportReview(
  scope: Pick<EvalAgentScope, "projectId" | "suiteId">,
) {
  updateGeneration(evalSuiteKey(scope), (state) => ({
    ...state,
    reviewSeenId: undefined,
  }));
}

export async function runScopedEvalSuite(scope: EvalAgentScope) {
  const key = evalSuiteKey(scope);
  const run = getEvalSuite(scope).run;
  if (!run) throw new Error("Running evals is unavailable in this workspace.");
  if (startingRuns.has(key))
    throw new Error("A suite run is already starting.");
  startingRuns.add(key);
  try {
    return await run();
  } finally {
    startingRuns.delete(key);
  }
}

export function resolveAuthoringIssue(
  scope: Pick<EvalAgentScope, "projectId" | "suiteId">,
  id: string,
  index: number,
  resolution: string,
) {
  updateGeneration(evalSuiteKey(scope), (state) => ({
    ...state,
    drafts: state.drafts.map((draft) =>
      draft.id === id
        ? {
            ...draft,
            issueResolutions: {
              ...draft.issueResolutions,
              [index]: resolution,
            },
          }
        : draft,
    ),
  }));
}

export async function controlAuthoringJob(
  scope: EvalAgentScope,
  operation: "cancel" | "retry",
) {
  const key = evalSuiteKey(scope);
  const jobId = useEvalGeneration.getState().suites[key]?.authoringJobId;
  if (!jobId) return;
  try {
    await authoringRequest({ operation, jobId });
    if (operation === "retry")
      await followAuthoringJob(scope, jobId, { takeOver: true });
  } catch (error) {
    updateGeneration(key, (state) => ({
      ...state,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}
