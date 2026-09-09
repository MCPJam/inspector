import { deriveQuery, deriveExpectedToolCalls } from "@/shared/steps";
import { create } from "zustand";
import { generateId } from "ai";
import { stepsSchema, type TestStep } from "@mcpjam/sdk/contract";
import type { EvalAgentScope } from "@/shared/eval-agent-scope";
import type { CreateEvalTestCaseInput } from "@/lib/evals/generate-and-persist-tests";

export interface EvalDraft {
  title: string;
  steps: TestStep[];
}
export interface EvalDraftBridge {
  read: () => { draft: EvalDraft; revision: string; tools: unknown[] };
  edit: (revision: string, patch: Partial<EvalDraft>) => unknown;
  undo: (revision: string) => unknown;
}
export interface EvalSuiteBridge {
  read: () => unknown;
  generate: (
    instructions: string,
    stage: (input: CreateEvalTestCaseInput) => Promise<unknown>,
  ) => Promise<void>;
  save: (input: CreateEvalTestCaseInput) => Promise<unknown>;
  run?: () => Promise<unknown>;
}
const drafts = new Map<string, EvalDraftBridge>();
const suites = new Map<string, EvalSuiteBridge>();
let activeDraftScope: EvalAgentScope | undefined;
let activeSuiteScope:
  | Omit<EvalAgentScope, "id" | "kind" | "version">
  | undefined;
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
        hasCaseContent: getEvalDraft(activeDraftScope).read().draft.steps.some((step) => step.kind !== "prompt" || Boolean(step.prompt.trim())),
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
  return () => {
    if (drafts.get(key) === bridge) {
      drafts.delete(key);
      if (activeDraftScope === scope) activeDraftScope = undefined;
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
  return () => {
    if (suites.get(key) === bridge) {
      suites.delete(key);
      if (activeSuiteScope === scope) activeSuiteScope = undefined;
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
  id: string;
  revision: string;
  input: CreateEvalTestCaseInput;
  saving?: boolean;
  error?: string;
}
export interface GenerationState {
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
export function startEvalGeneration(
  scope: EvalAgentScope,
  instructions: string,
) {
  const key = evalSuiteKey(scope);
  const bridge = getEvalSuite(scope);
  if (useEvalGeneration.getState().suites[key]?.status === "running")
    throw new Error(
      "Generation is already running. Read context for progress; do not start another job.",
    );
  updateGeneration(key, (s) => ({ ...s, status: "running", error: undefined }));
  void bridge
    .generate(instructions, async (input) => {
      if (input.suiteId !== scope.suiteId)
        throw new Error("Generated case is outside the scoped suite.");
      const id = `generated-${generateId()}`;
      updateGeneration(key, (s) => ({
        ...s,
        drafts: [...s.drafts, { id, revision: generateId(), input }],
      }));
      return id;
    })
    .then(
      () => updateGeneration(key, (s) => ({ ...s, status: "ready" })),
      (error) =>
        updateGeneration(key, (s) => ({
          ...s,
          status: "error",
          error: String(error instanceof Error ? error.message : error),
        })),
    );
  return {
    status: "generation_started",
    note: "Drafts will appear for review. Read ui_eval_context for progress. They are not saved yet.",
  };
}
export function editGeneratedDraft(
  scope: EvalAgentScope,
  id: string,
  revision: string,
  patch: Partial<EvalDraft>,
) {
  const key = evalSuiteKey(scope);
  const current = useEvalGeneration
    .getState()
    .suites[key]?.drafts.find((d) => d.id === id);
  if (!current || current.revision !== revision || current.saving)
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
    const bridge = getEvalSuite(scope);
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
    await bridge.save(current.input);
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
