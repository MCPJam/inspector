import { describe, expect, it, vi } from "vitest";
import {
  ComposerResolveError,
  isAdhocUnavailable,
  resolveComposerEnvironments,
  type EnsureAdhocEnvironmentsFn,
} from "../resolve-stacks";
import {
  composerStateFromEnvironments,
  defaultComposerState,
  emptyEnvironmentStack,
  environmentsCarryModels,
  environmentsCarryPluginPins,
  environmentsExceedOneStack,
  type EnvironmentComposerState,
} from "../environment-stack";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";

/**
 * Nameless by default: an ad-hoc row is the common case now, so the fixture that
 * needs no arguments must be one.
 */
function env(
  overrides: Partial<ProjectEnvironmentView> & { environmentId: string }
): ProjectEnvironmentView {
  return {
    projectId: "proj-1",
    hostId: "host-1",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as ProjectEnvironmentView;
}

function named(
  overrides: Partial<ProjectEnvironmentView> & { environmentId: string }
): ProjectEnvironmentView {
  return env({ name: "Prod-like", origin: "named", ...overrides });
}

function composeState(
  stack: Partial<EnvironmentComposerState["stack"]>
): EnvironmentComposerState {
  return {
    environmentIds: [],
    stack: { ...emptyEnvironmentStack(), ...stack },
    customized: true,
  };
}

function ensureReturning(
  ids: string[],
  opts: { created?: boolean } = { created: true }
): EnsureAdhocEnvironmentsFn {
  return vi.fn(async () =>
    ids.map((environmentId) => ({
      environment: env({ environmentId }),
      ...(opts.created === undefined ? {} : { created: opts.created }),
    }))
  );
}

const base = {
  projectId: "proj-1",
  skillsEnabled: true,
  computersEnabled: true,
  max: 10,
};

describe("resolveComposerEnvironments — saved-environment path", () => {
  it("returns the selection untouched and never calls the mutation", async () => {
    const ensure = ensureReturning([]);
    const result = await resolveComposerEnvironments({
      ...base,
      state: {
        environmentIds: ["env-a", "env-b"],
        stack: emptyEnvironmentStack(),
        customized: false,
      },
      liveEnvironments: [
        named({ environmentId: "env-a" }),
        named({ environmentId: "env-b" }),
      ],
      ensureAdhocEnvironments: ensure,
    });
    expect(result.environmentIds).toEqual(["env-a", "env-b"]);
    expect(result.createdIds).toEqual([]);
    expect(ensure).not.toHaveBeenCalled();
  });

  it("refuses a selection whose environment no longer resolves", async () => {
    await expect(
      resolveComposerEnvironments({
        ...base,
        state: {
          environmentIds: ["env-a", "gone"],
          stack: emptyEnvironmentStack(),
          customized: false,
        },
        liveEnvironments: [named({ environmentId: "env-a" })],
        ensureAdhocEnvironments: ensureReturning([]),
      })
    ).rejects.toMatchObject({ code: "UNRESOLVED_ENVIRONMENT" });
  });

  it("treats an archived row as unresolvable", async () => {
    await expect(
      resolveComposerEnvironments({
        ...base,
        state: {
          environmentIds: ["env-a"],
          stack: emptyEnvironmentStack(),
          customized: false,
        },
        liveEnvironments: [named({ environmentId: "env-a", archivedAt: 5 })],
        ensureAdhocEnvironments: ensureReturning([]),
      })
    ).rejects.toMatchObject({ code: "UNRESOLVED_ENVIRONMENT" });
  });
});

describe("resolveComposerEnvironments — compose path", () => {
  it("mints one row per host, in the user's order", async () => {
    const ensure = ensureReturning(["adhoc-1", "adhoc-2"]);
    const result = await resolveComposerEnvironments({
      ...base,
      state: composeState({ hostIds: ["h1", "h2"] }),
      liveEnvironments: [],
      ensureAdhocEnvironments: ensure,
    });
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure).toHaveBeenCalledWith({
      projectId: "proj-1",
      stacks: [{ hostId: "h1" }, { hostId: "h2" }],
    });
    expect(result.environmentIds).toEqual(["adhoc-1", "adhoc-2"]);
    expect(result.createdIds).toEqual(["adhoc-1", "adhoc-2"]);
  });

  it("dedupes a repeated host before calling the backend", async () => {
    const ensure = ensureReturning(["adhoc-1"]);
    const result = await resolveComposerEnvironments({
      ...base,
      state: composeState({ hostIds: ["h1", "h1"] }),
      liveEnvironments: [],
      ensureAdhocEnvironments: ensure,
    });
    expect(ensure).toHaveBeenCalledWith({
      projectId: "proj-1",
      stacks: [{ hostId: "h1" }],
    });
    expect(result.environmentIds).toEqual(["adhoc-1"]);
  });

  it("collapses two hosts the backend fingerprints to the same row", async () => {
    const ensure = ensureReturning(["same", "same"]);
    const result = await resolveComposerEnvironments({
      ...base,
      state: composeState({ hostIds: ["h1", "h2"] }),
      liveEnvironments: [],
      ensureAdhocEnvironments: ensure,
    });
    expect(result.environmentIds).toEqual(["same"]);
    expect(result.environments).toHaveLength(1);
  });

  it("reads an absent `created` as a reuse, not a mint", async () => {
    const result = await resolveComposerEnvironments({
      ...base,
      state: composeState({ hostIds: ["h1"] }),
      liveEnvironments: [],
      ensureAdhocEnvironments: ensureReturning(["adhoc-1"], {
        created: undefined,
      }),
    });
    expect(result.createdIds).toEqual([]);
    expect(result.reusedIds).toEqual(["adhoc-1"]);
  });

  it("sends the shared slots, omitting a null sandbox image", async () => {
    const ensure = ensureReturning(["adhoc-1"]);
    await resolveComposerEnvironments({
      ...base,
      state: composeState({
        hostIds: ["h1"],
        serverAttachmentId: "grp-1",
        skillSelection: { mode: "explicit", skillIds: ["s1"] },
        computerEnvironmentId: null,
      }),
      liveEnvironments: [],
      ensureAdhocEnvironments: ensure,
    });
    const sent = (ensure as unknown as { mock: { calls: any[][] } }).mock
      .calls[0][0];
    expect(sent.stacks[0]).toEqual({
      hostId: "h1",
      serverAttachmentId: "grp-1",
      skillSelection: { mode: "explicit", skillIds: ["s1"] },
    });
    // Convex rejects an explicit null at the validator for this arg.
    expect("computerEnvironmentId" in sent.stacks[0]).toBe(false);
  });

  it("drops flag-gated slots so the same row serves both flag states", async () => {
    const ensure = ensureReturning(["adhoc-1"]);
    await resolveComposerEnvironments({
      ...base,
      skillsEnabled: false,
      computersEnabled: false,
      state: composeState({
        hostIds: ["h1"],
        skillSelection: { mode: "explicit", skillIds: ["s1"] },
        computerEnvironmentId: "img-1",
      }),
      liveEnvironments: [],
      ensureAdhocEnvironments: ensure,
    });
    expect(ensure).toHaveBeenCalledWith({
      projectId: "proj-1",
      stacks: [{ hostId: "h1" }],
    });
  });

  it("refuses zero hosts", async () => {
    await expect(
      resolveComposerEnvironments({
        ...base,
        state: composeState({ hostIds: [] }),
        liveEnvironments: [],
        ensureAdhocEnvironments: ensureReturning([]),
      })
    ).rejects.toMatchObject({ code: "NO_TARGETS" });
  });

  it("refuses more hosts than the surface's cap", async () => {
    await expect(
      resolveComposerEnvironments({
        ...base,
        max: 2,
        state: composeState({ hostIds: ["h1", "h2", "h3"] }),
        liveEnvironments: [],
        ensureAdhocEnvironments: ensureReturning([]),
      })
    ).rejects.toMatchObject({ code: "TOO_MANY_TARGETS" });
  });
});

describe("resolveComposerEnvironments — reusing a named environment", () => {
  it("reuses a named row that already is this composition", async () => {
    const ensure = ensureReturning([]);
    const result = await resolveComposerEnvironments({
      ...base,
      state: composeState({ hostIds: ["h1"], serverAttachmentId: "grp-1" }),
      liveEnvironments: [
        named({
          environmentId: "curated",
          hostId: "h1",
          serverAttachmentId: "grp-1",
        }),
      ],
      ensureAdhocEnvironments: ensure,
    });
    expect(result.environmentIds).toEqual(["curated"]);
    expect(result.reusedIds).toEqual(["curated"]);
    expect(ensure).not.toHaveBeenCalled();
  });

  it("mints only the hosts a named row does not already cover", async () => {
    const ensure = ensureReturning(["adhoc-2"]);
    const result = await resolveComposerEnvironments({
      ...base,
      state: composeState({ hostIds: ["h1", "h2"] }),
      liveEnvironments: [named({ environmentId: "curated", hostId: "h1" })],
      ensureAdhocEnvironments: ensure,
    });
    expect(ensure).toHaveBeenCalledWith({
      projectId: "proj-1",
      stacks: [{ hostId: "h2" }],
    });
    expect(result.environmentIds).toEqual(["curated", "adhoc-2"]);
    expect(result.createdIds).toEqual(["adhoc-2"]);
  });

  it("never reuses a row whose slots differ", async () => {
    const ensure = ensureReturning(["adhoc-1"]);
    const result = await resolveComposerEnvironments({
      ...base,
      state: composeState({ hostIds: ["h1"], serverAttachmentId: "grp-2" }),
      liveEnvironments: [
        named({
          environmentId: "curated",
          hostId: "h1",
          serverAttachmentId: "grp-1",
        }),
      ],
      ensureAdhocEnvironments: ensure,
    });
    expect(result.environmentIds).toEqual(["adhoc-1"]);
  });

  it("never reuses a row with plugin pins the strip cannot express", async () => {
    const ensure = ensureReturning(["adhoc-1"]);
    const result = await resolveComposerEnvironments({
      ...base,
      state: composeState({ hostIds: ["h1"] }),
      liveEnvironments: [
        named({
          environmentId: "pinned",
          hostId: "h1",
          pluginVersionIds: ["pv-1"],
        }),
      ],
      ensureAdhocEnvironments: ensure,
    });
    expect(result.environmentIds).toEqual(["adhoc-1"]);
  });

  it("never reuses an ad-hoc row — the backend's fingerprint owns that", async () => {
    const ensure = ensureReturning(["adhoc-1"]);
    const result = await resolveComposerEnvironments({
      ...base,
      state: composeState({ hostIds: ["h1"] }),
      liveEnvironments: [env({ environmentId: "twin", hostId: "h1" })],
      ensureAdhocEnvironments: ensure,
    });
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(result.environmentIds).toEqual(["adhoc-1"]);
  });
});

describe("resolveComposerEnvironments — backend skew", () => {
  const missingFunction = Object.assign(
    new Error(
      "[CONVEX M(projectEnvironments:ensureAdhocEnvironments)] Could not find public function"
    ),
    {
      data: "Could not find public function for 'projectEnvironments:ensureAdhocEnvironments'",
    }
  );

  it("classifies a missing mutation as ADHOC_UNAVAILABLE", async () => {
    const err = await resolveComposerEnvironments({
      ...base,
      state: composeState({ hostIds: ["h1"] }),
      liveEnvironments: [],
      ensureAdhocEnvironments: vi.fn(async () => {
        throw missingFunction;
      }),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ComposerResolveError);
    expect(err.code).toBe("ADHOC_UNAVAILABLE");
    expect(isAdhocUnavailable(err)).toBe(true);
  });

  it("surfaces any other rejection verbatim, and not as skew", async () => {
    const err = await resolveComposerEnvironments({
      ...base,
      state: composeState({ hostIds: ["h1"] }),
      liveEnvironments: [],
      ensureAdhocEnvironments: vi.fn(async () => {
        throw Object.assign(new Error("boom"), {
          data: { message: "Pinning plugin versions requires an admin." },
        });
      }),
    }).catch((e) => e);
    expect(err.code).toBe("BACKEND_REJECTED");
    expect(err.message).toBe("Pinning plugin versions requires an admin.");
    expect(isAdhocUnavailable(err)).toBe(false);
  });

  it("refuses a short batch rather than silently dropping a target", async () => {
    await expect(
      resolveComposerEnvironments({
        ...base,
        state: composeState({ hostIds: ["h1", "h2"] }),
        liveEnvironments: [],
        ensureAdhocEnvironments: ensureReturning(["adhoc-1"]),
      })
    ).rejects.toMatchObject({ code: "BACKEND_REJECTED" });
  });
});

/**
 * Seeding a persisted selection back into composer state, and the cases where it
 * cannot be done without losing something.
 */
describe("defaultComposerState", () => {
  it("seeds the preferred named environment when environments are on", () => {
    const state = defaultComposerState({
      environmentsEnabled: true,
      environments: [
        named({
          environmentId: "env-a",
          hostId: "h1",
          serverAttachmentId: "grp-1",
        }),
        named({
          environmentId: "env-b",
          hostId: "h2",
          serverAttachmentId: "grp-2",
          skillSelection: { mode: "explicit", skillIds: ["s1"] },
        }),
      ],
      hosts: [{ hostId: "h1" }, { hostId: "h2" }],
      preferredEnvironmentId: "env-b",
      serverAttachments: [{ _id: "grp-x" }],
    });
    expect(state).toEqual(
      composerStateFromEnvironments([
        named({
          environmentId: "env-b",
          hostId: "h2",
          serverAttachmentId: "grp-2",
          skillSelection: { mode: "explicit", skillIds: ["s1"] },
        }),
      ])
    );
  });

  it("falls back to the first named environment when preference is missing", () => {
    const state = defaultComposerState({
      environmentsEnabled: true,
      environments: [
        named({ environmentId: "env-a", hostId: "h1" }),
        named({ environmentId: "env-b", hostId: "h2" }),
      ],
      hosts: [{ hostId: "h1" }],
      preferredEnvironmentId: "gone",
      serverAttachments: [],
    });
    expect(state?.environmentIds).toEqual(["env-a"]);
    expect(state?.stack.hostIds).toEqual(["h1"]);
    expect(state?.customized).toBe(false);
  });

  it("skips archived and ad-hoc rows when looking for a named seed", () => {
    const state = defaultComposerState({
      environmentsEnabled: true,
      environments: [
        env({ environmentId: "adhoc-1", hostId: "h1", origin: "adhoc" }),
        named({
          environmentId: "archived",
          hostId: "h2",
          archivedAt: 99,
        }),
        named({ environmentId: "live", hostId: "h3" }),
      ],
      hosts: [{ hostId: "h9" }],
      serverAttachments: [{ _id: "grp-1" }],
    });
    expect(state?.environmentIds).toEqual(["live"]);
    expect(state?.stack.hostIds).toEqual(["h3"]);
  });

  it("composes on preferred host + first server group when no named envs", () => {
    const state = defaultComposerState({
      environmentsEnabled: true,
      environments: [
        env({ environmentId: "adhoc-1", hostId: "h1", origin: "adhoc" }),
      ],
      hosts: [{ hostId: "h1" }, { hostId: "h2" }],
      preferredHostId: "h2",
      serverAttachments: [{ _id: "grp-1" }, { _id: "grp-2" }],
    });
    expect(state).toEqual({
      environmentIds: [],
      stack: {
        hostIds: ["h2"],
        serverAttachmentId: "grp-1",
        skillSelection: null,
        computerEnvironmentId: null,
        modelSelection: { includeClientDefaults: true, explicitModelIds: [] },
      },
      customized: true,
    });
  });

  it("composes when environments flag is off even if named envs exist", () => {
    const state = defaultComposerState({
      environmentsEnabled: false,
      environments: [named({ environmentId: "env-a", hostId: "h1" })],
      hosts: [{ hostId: "h2" }],
      serverAttachments: [{ _id: "grp-1" }],
    });
    expect(state?.environmentIds).toEqual([]);
    expect(state?.stack.hostIds).toEqual(["h2"]);
    expect(state?.stack.serverAttachmentId).toBe("grp-1");
    expect(state?.customized).toBe(true);
  });

  it("returns null when nothing can be seeded", () => {
    expect(
      defaultComposerState({
        environmentsEnabled: true,
        environments: [],
        hosts: [],
        serverAttachments: [{ _id: "grp-1" }],
      })
    ).toBeNull();
  });
});

describe("composerStateFromEnvironments", () => {
  it("keeps a named multi-env selection on the saved path", () => {
    const state = composerStateFromEnvironments([
      named({ environmentId: "a", hostId: "h1" }),
      named({ environmentId: "b", hostId: "h2" }),
    ]);
    expect(state.environmentIds).toEqual(["a", "b"]);
    expect(state.customized).toBe(false);
    expect(state.stack.hostIds).toEqual(["h1", "h2"]);
  });

  it("empties a shared slot the selection disagrees on", () => {
    // Imposing one environment's server group on the rest would be a silent
    // change to what the others run.
    const state = composerStateFromEnvironments([
      named({ environmentId: "a", hostId: "h1", serverAttachmentId: "g1" }),
      named({ environmentId: "b", hostId: "h2", serverAttachmentId: "g2" }),
    ]);
    expect(state.stack.serverAttachmentId).toBeNull();
  });

  it("keeps an agreed slot when a DIFFERENT slot disagrees", () => {
    // Agreement is per slot. All-or-nothing seeding would null the server
    // group both environments share just because their skills differ — its own
    // silent change once the guard lets the selection stay editable (e.g. when
    // the disagreeing slot is flag-disabled).
    const state = composerStateFromEnvironments([
      named({
        environmentId: "a",
        hostId: "h1",
        serverAttachmentId: "g1",
        skillSelection: { mode: "explicit", skillIds: ["s1"] },
      }),
      named({ environmentId: "b", hostId: "h2", serverAttachmentId: "g1" }),
    ]);
    expect(state.stack.serverAttachmentId).toBe("g1");
    expect(state.stack.skillSelection).toBeNull();
  });

  it("seeds ad-hoc rows as a COMPOSITION, not a selection", () => {
    // Ad-hoc rows are never offerable in the saved-environment picker, so
    // presenting them there would render undetachable generic chips.
    const state = composerStateFromEnvironments([
      env({ environmentId: "adhoc-1", hostId: "h1" }),
    ]);
    expect(state.environmentIds).toEqual([]);
    expect(state.customized).toBe(true);
    expect(state.stack.hostIds).toEqual(["h1"]);
  });
});

describe("environmentsExceedOneStack", () => {
  const allSlots = { skillsEnabled: true, computersEnabled: true };

  it("flags two environments sharing a client", () => {
    // The stack fans out over hostIds, so these two would resolve to ONE row —
    // a lost target, not just a homogenized slot.
    expect(
      environmentsExceedOneStack(
        [
          named({ environmentId: "a", hostId: "h1", serverAttachmentId: "g1" }),
          named({ environmentId: "b", hostId: "h1", serverAttachmentId: "g2" }),
        ],
        allSlots
      )
    ).toBe(true);
  });

  it("passes a selection with one environment per client and agreeing slots", () => {
    expect(
      environmentsExceedOneStack(
        [
          named({ environmentId: "a", hostId: "h1" }),
          named({ environmentId: "b", hostId: "h2" }),
        ],
        allSlots
      )
    ).toBe(false);
  });

  it("flags a selection that DISAGREES on a shared slot", () => {
    // A stack has ONE server group for all its clients. Seeding a disagreement
    // reads the slot as empty, so an edit would resolve both with defaults and
    // silently replace each environment's execution context.
    expect(
      environmentsExceedOneStack(
        [
          named({ environmentId: "a", hostId: "h1", serverAttachmentId: "g1" }),
          named({ environmentId: "b", hostId: "h2", serverAttachmentId: "g2" }),
        ],
        allSlots
      )
    ).toBe(true);
  });

  it("ignores a disagreement on a flag-DISABLED slot", () => {
    // The resolver drops disabled slots (`sharedFields`), so these two resolve
    // to the same run — blocking edits over the difference costs the user a
    // working strip for nothing.
    const selection = [
      named({
        environmentId: "a",
        hostId: "h1",
        skillSelection: { mode: "explicit", skillIds: ["s1"] },
        computerEnvironmentId: "img-1",
      }),
      named({ environmentId: "b", hostId: "h2" }),
    ];
    expect(
      environmentsExceedOneStack(selection, {
        skillsEnabled: false,
        computersEnabled: false,
      })
    ).toBe(false);
    expect(environmentsExceedOneStack(selection, allSlots)).toBe(true);
  });

  it("passes a single environment, which is always one stack", () => {
    expect(
      environmentsExceedOneStack(
        [named({ environmentId: "a", hostId: "h1" })],
        allSlots
      )
    ).toBe(false);
  });
});

describe("environmentsCarryPluginPins", () => {
  it("flags a selection that pins plugin versions, even a single one", () => {
    // The stack has no plugin slot and the resolver never reuses a pinned named
    // row, so an edit would silently shed the pins. Callers block stack edits.
    expect(
      environmentsCarryPluginPins([
        named({
          environmentId: "a",
          hostId: "h1",
          pluginVersionIds: ["pv-1"],
        }),
      ])
    ).toBe(true);
  });

  it("passes unpinned rows, including an empty pins array", () => {
    expect(
      environmentsCarryPluginPins([
        named({ environmentId: "a", hostId: "h1", pluginVersionIds: [] }),
        named({ environmentId: "b", hostId: "h2" }),
      ])
    ).toBe(false);
  });
});

describe("named reuse — which matching row wins", () => {
  it("prefers an environment the user actually SELECTED", async () => {
    // Two named rows with identical stacks are interchangeable to us and not to
    // the user: on User Testing, silently swapping opens a different
    // environment's scenario, with its own name and access.
    const ensure = ensureReturning([]);
    const result = await resolveComposerEnvironments({
      ...base,
      state: {
        environmentIds: ["second"],
        stack: { ...emptyEnvironmentStack(), hostIds: ["h1"] },
        customized: true,
      },
      liveEnvironments: [
        named({ environmentId: "first", hostId: "h1" }),
        named({ environmentId: "second", hostId: "h1" }),
      ],
      ensureAdhocEnvironments: ensure,
    });
    expect(result.environmentIds).toEqual(["second"]);
    expect(ensure).not.toHaveBeenCalled();
  });

  it("falls back to any matching named row when none was selected", async () => {
    const result = await resolveComposerEnvironments({
      ...base,
      state: composeState({ hostIds: ["h1"] }),
      liveEnvironments: [
        named({ environmentId: "first", hostId: "h1" }),
        named({ environmentId: "second", hostId: "h1" }),
      ],
      ensureAdhocEnvironments: ensureReturning([]),
    });
    expect(result.environmentIds).toEqual(["first"]);
  });
});

describe("resolveComposerEnvironments — model axis", () => {
  it("mints inherit then explicit, host-major", async () => {
    const ensure = ensureReturning(["a", "b", "c", "d"]);
    const result = await resolveComposerEnvironments({
      ...base,
      modelMatrixEnabled: true,
      state: composeState({
        hostIds: ["h1", "h2"],
        modelSelection: {
          includeClientDefaults: true,
          explicitModelIds: ["google/gemini-2.5-flash"],
        },
      }),
      liveEnvironments: [],
      ensureAdhocEnvironments: ensure,
    });
    expect(ensure).toHaveBeenCalledWith({
      projectId: "proj-1",
      stacks: [
        { hostId: "h1" },
        { hostId: "h1", modelId: "google/gemini-2.5-flash" },
        { hostId: "h2" },
        { hostId: "h2", modelId: "google/gemini-2.5-flash" },
      ],
    });
    expect(result.environmentIds).toEqual(["a", "b", "c", "d"]);
  });

  it("dedupes explicit model ids before minting or counting the product", async () => {
    const ensure = ensureReturning(["inherit", "override"]);
    await resolveComposerEnvironments({
      ...base,
      modelMatrixEnabled: true,
      state: composeState({
        hostIds: ["h1"],
        modelSelection: {
          includeClientDefaults: true,
          explicitModelIds: ["google/gemini-2.5-flash", "google/gemini-2.5-flash"],
        },
      }),
      liveEnvironments: [],
      ensureAdhocEnvironments: ensure,
    });
    expect(ensure).toHaveBeenCalledWith({
      projectId: "proj-1",
      stacks: [
        { hostId: "h1" },
        { hostId: "h1", modelId: "google/gemini-2.5-flash" },
      ],
    });
  });

  it("omits modelId on inherit cells and sends it on explicit cells", async () => {
    const ensure = ensureReturning(["inherit", "override"]);
    await resolveComposerEnvironments({
      ...base,
      modelMatrixEnabled: true,
      state: composeState({
        hostIds: ["h1"],
        modelSelection: {
          includeClientDefaults: true,
          explicitModelIds: ["anthropic/claude-haiku-4.5"],
        },
      }),
      liveEnvironments: [],
      ensureAdhocEnvironments: ensure,
    });
    const stacks = (ensure as unknown as { mock: { calls: any[][] } }).mock
      .calls[0][0].stacks;
    expect("modelId" in stacks[0]).toBe(false);
    expect(stacks[1].modelId).toBe("anthropic/claude-haiku-4.5");
  });

  it("refuses a product that exceeds the cap with an axis-aware message", async () => {
    const err = await resolveComposerEnvironments({
      ...base,
      max: 10,
      modelMatrixEnabled: true,
      state: composeState({
        hostIds: ["h1", "h2", "h3"],
        modelSelection: {
          includeClientDefaults: true,
          explicitModelIds: ["m1", "m2", "m3"],
        },
      }),
      liveEnvironments: [],
      ensureAdhocEnvironments: ensureReturning([]),
    }).catch((e) => e);
    expect(err.code).toBe("TOO_MANY_TARGETS");
    expect(err.message).toMatch(/3 clients × 4 model choices = 12 targets; limit 10/);
  });

  it("does not reuse a named override row for an inherit compose", async () => {
    const ensure = ensureReturning(["adhoc-1"]);
    const result = await resolveComposerEnvironments({
      ...base,
      state: composeState({ hostIds: ["h1"] }),
      liveEnvironments: [
        named({
          environmentId: "curated",
          hostId: "h1",
          modelId: "google/gemini-2.5-flash",
        }),
      ],
      ensureAdhocEnvironments: ensure,
    });
    expect(result.environmentIds).toEqual(["adhoc-1"]);
    expect(ensure).toHaveBeenCalled();
  });

  it("reuses a named override row for the matching explicit cell", async () => {
    const ensure = ensureReturning([]);
    const result = await resolveComposerEnvironments({
      ...base,
      modelMatrixEnabled: true,
      state: composeState({
        hostIds: ["h1"],
        modelSelection: {
          includeClientDefaults: false,
          explicitModelIds: ["google/gemini-2.5-flash"],
        },
      }),
      liveEnvironments: [
        named({
          environmentId: "curated",
          hostId: "h1",
          modelId: "google/gemini-2.5-flash",
        }),
      ],
      ensureAdhocEnvironments: ensure,
    });
    expect(result.environmentIds).toEqual(["curated"]);
    expect(ensure).not.toHaveBeenCalled();
  });

  it("refuses explicit models when the backend has no model matrix", async () => {
    const ensure = ensureReturning([]);
    const err = await resolveComposerEnvironments({
      ...base,
      modelMatrixEnabled: false,
      state: composeState({
        hostIds: ["h1"],
        modelSelection: {
          includeClientDefaults: true,
          explicitModelIds: ["google/gemini-2.5-flash"],
        },
      }),
      liveEnvironments: [],
      ensureAdhocEnvironments: ensure,
    }).catch((e) => e);
    expect(err.code).toBe("BACKEND_REJECTED");
    expect(ensure).not.toHaveBeenCalled();
  });

  it("does not mint a modelId when the selection is untouched inherit", async () => {
    const ensure = ensureReturning(["adhoc-1"]);
    await resolveComposerEnvironments({
      ...base,
      state: composeState({ hostIds: ["h1"] }),
      liveEnvironments: [],
      ensureAdhocEnvironments: ensure,
    });
    expect(ensure).toHaveBeenCalledWith({
      projectId: "proj-1",
      stacks: [{ hostId: "h1" }],
    });
  });
});

describe("environmentsCarryModels and modelsEnabled gating", () => {
  it("flags a single env that carries a model override", () => {
    expect(
      environmentsCarryModels([
        named({ environmentId: "a", hostId: "h1", modelId: "m1" }),
      ])
    ).toBe(true);
  });

  it("does not collapse two same-host model cells when modelsEnabled", () => {
    expect(
      environmentsExceedOneStack(
        [
          named({ environmentId: "a", hostId: "h1" }),
          named({
            environmentId: "b",
            hostId: "h1",
            modelId: "google/gemini-2.5-flash",
          }),
        ],
        { skillsEnabled: true, computersEnabled: true, modelsEnabled: true }
      )
    ).toBe(false);
  });

  it("collapses two same-host model cells when modelsEnabled is off", () => {
    expect(
      environmentsExceedOneStack(
        [
          named({ environmentId: "a", hostId: "h1" }),
          named({
            environmentId: "b",
            hostId: "h1",
            modelId: "google/gemini-2.5-flash",
          }),
        ],
        { skillsEnabled: true, computersEnabled: true }
      )
    ).toBe(true);
  });

  it("collapses per-host model-choice asymmetry", () => {
    expect(
      environmentsExceedOneStack(
        [
          named({ environmentId: "a", hostId: "h1" }),
          named({
            environmentId: "b",
            hostId: "h1",
            modelId: "m1",
          }),
          named({ environmentId: "c", hostId: "h2" }),
        ],
        { skillsEnabled: true, computersEnabled: true, modelsEnabled: true }
      )
    ).toBe(true);
  });

  it("reconstructs modelSelection when modelsEnabled", () => {
    const state = composerStateFromEnvironments(
      [
        named({ environmentId: "a", hostId: "h1" }),
        named({
          environmentId: "b",
          hostId: "h1",
          modelId: "google/gemini-2.5-flash",
        }),
        named({ environmentId: "c", hostId: "h2" }),
        named({
          environmentId: "d",
          hostId: "h2",
          modelId: "google/gemini-2.5-flash",
        }),
      ],
      { skillsEnabled: true, computersEnabled: true, modelsEnabled: true }
    );
    expect(state.stack.modelSelection).toEqual({
      includeClientDefaults: true,
      explicitModelIds: ["google/gemini-2.5-flash"],
    });
    expect(state.stack.hostIds).toEqual(["h1", "h2"]);
  });

  it("does not reconstruct modelSelection when the slot is off", () => {
    const state = composerStateFromEnvironments([
      named({
        environmentId: "a",
        hostId: "h1",
        modelId: "google/gemini-2.5-flash",
      }),
    ]);
    expect(state.stack.modelSelection).toEqual({
      includeClientDefaults: true,
      explicitModelIds: [],
    });
  });
});
