import { describe, expect, it, vi } from "vitest";
import type { ModelSelection as SavedModelSelection } from "@mcpjam/sdk/browser";
import type { ModelDefinition } from "@/shared/types";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";
import {
  resolveComposerEnvironments,
  type EnsureAdhocEnvironmentsFn,
} from "../resolve-stacks";
import {
  emptyEnvironmentStack,
  expandModelChoices,
  sameModelSelection,
  stackFromEnvironment,
  syncExplicitModelSelections,
  type EnvironmentComposerState,
} from "../environment-stack";

const SAME_ID = "anthropic/claude-haiku-4.5";
const hostedRow: ModelDefinition = {
  id: SAME_ID,
  name: "Claude Haiku 4.5",
  provider: "anthropic",
  hosted: true,
};
const orgRow: ModelDefinition = {
  id: SAME_ID,
  name: SAME_ID,
  provider: "openrouter",
  hosted: false,
  orgProvider: { providerKey: "openrouter", id: "orgprov_1" },
};
const ORG: SavedModelSelection = {
  modelId: SAME_ID,
  source: "org",
  connectionRef: { kind: "orgProvider", id: "orgprov_1" },
  fallback: { provider: "none", model: "none" },
};
const HOSTED: SavedModelSelection = {
  modelId: SAME_ID,
  source: "hosted",
  fallback: { provider: "none", model: "none" },
};

function env(
  overrides: Partial<ProjectEnvironmentView> & { environmentId: string },
): ProjectEnvironmentView {
  return {
    projectId: "proj-1",
    hostId: "h1",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as ProjectEnvironmentView;
}

function composeState(
  stack: Partial<EnvironmentComposerState["stack"]>,
): EnvironmentComposerState {
  return {
    environmentIds: [],
    stack: { ...emptyEnvironmentStack(), ...stack },
    customized: true,
  };
}

function ensureReturning(ids: string[]): EnsureAdhocEnvironmentsFn {
  return vi.fn(async () =>
    ids.map((environmentId) => ({
      environment: env({ environmentId }),
      created: true,
    })),
  );
}

const base = {
  projectId: "proj-1",
  skillsEnabled: true,
  computersEnabled: true,
  max: 10,
  modelMatrixEnabled: true,
};

describe("syncExplicitModelSelections", () => {
  it("saves the row the user picked, not the first row with that id", () => {
    const next = syncExplicitModelSelections(
      { includeClientDefaults: false, explicitModelIds: [SAME_ID] },
      { models: [hostedRow, orgRow], picked: orgRow },
    );
    expect(next.explicitModelSelections).toEqual({ [SAME_ID]: ORG });
  });

  it("keeps a saved selection across unrelated edits and drops removed ids", () => {
    const previous = {
      includeClientDefaults: false,
      explicitModelIds: [SAME_ID],
      explicitModelSelections: { [SAME_ID]: ORG },
    };
    const kept = syncExplicitModelSelections(
      { ...previous, includeClientDefaults: true },
      { models: [hostedRow, orgRow], previous },
    );
    expect(kept.explicitModelSelections).toEqual({ [SAME_ID]: ORG });
    const removed = syncExplicitModelSelections(
      { includeClientDefaults: true, explicitModelIds: [] },
      { models: [hostedRow, orgRow], previous },
    );
    expect(removed).toEqual({
      includeClientDefaults: true,
      explicitModelIds: [],
    });
  });

  it("a checkbox pick by id takes the first listed row (hosted-first)", () => {
    const next = syncExplicitModelSelections(
      { includeClientDefaults: false, explicitModelIds: [SAME_ID] },
      { models: [hostedRow, orgRow] },
    );
    expect(next.explicitModelSelections?.[SAME_ID]?.source).toBe("hosted");
  });

  it("selections take part in equality and expansion", () => {
    const org = {
      includeClientDefaults: false,
      explicitModelIds: [SAME_ID],
      explicitModelSelections: { [SAME_ID]: ORG },
    };
    const hosted = { ...org, explicitModelSelections: { [SAME_ID]: HOSTED } };
    expect(sameModelSelection(org, hosted)).toBe(false);
    expect(sameModelSelection(org, { ...org })).toBe(true);
    expect(expandModelChoices(org)).toEqual([
      { modelId: SAME_ID, modelSelection: ORG },
    ]);
  });

  it("an environment's stored selection seeds the stack", () => {
    expect(
      stackFromEnvironment(
        env({ environmentId: "e1", modelId: SAME_ID, modelSelection: ORG }),
      ).modelSelection.explicitModelSelections,
    ).toEqual({ [SAME_ID]: ORG });
  });
});

describe("resolveComposerEnvironments — saved selections", () => {
  const state = composeState({
    hostIds: ["h1"],
    modelSelection: {
      includeClientDefaults: false,
      explicitModelIds: [SAME_ID],
      explicitModelSelections: { [SAME_ID]: ORG },
    },
  });

  it("mints the cell with its selection when the backend stores selections", async () => {
    const ensure = ensureReturning(["a"]);
    await resolveComposerEnvironments({
      ...base,
      modelSelectionsEnabled: true,
      state,
      liveEnvironments: [],
      ensureAdhocEnvironments: ensure,
    });
    expect(ensure).toHaveBeenCalledWith({
      projectId: "proj-1",
      stacks: [{ hostId: "h1", modelId: SAME_ID, modelSelection: ORG }],
    });
  });

  it("sends the legacy id alone to a backend without the capability", async () => {
    const ensure = ensureReturning(["a"]);
    await resolveComposerEnvironments({
      ...base,
      state,
      liveEnvironments: [],
      ensureAdhocEnvironments: ensure,
    });
    expect(ensure).toHaveBeenCalledWith({
      projectId: "proj-1",
      stacks: [{ hostId: "h1", modelId: SAME_ID }],
    });
  });

  it("does not reuse a named row that runs the same id on another source", async () => {
    const ensure = ensureReturning(["minted"]);
    const result = await resolveComposerEnvironments({
      ...base,
      modelSelectionsEnabled: true,
      state,
      liveEnvironments: [
        env({
          environmentId: "hosted-named",
          name: "Prod",
          origin: "named",
          modelId: SAME_ID,
          modelSelection: HOSTED,
        } as Partial<ProjectEnvironmentView> & { environmentId: string }),
      ],
      ensureAdhocEnvironments: ensure,
    });
    expect(result.environmentIds).toEqual(["minted"]);
  });
});
