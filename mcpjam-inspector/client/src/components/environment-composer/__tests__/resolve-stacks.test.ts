import { describe, expect, it, vi } from "vitest";
import {
  ComposerResolveError,
  isAdhocUnavailable,
  resolveComposerEnvironments,
  type EnsureAdhocEnvironmentsFn,
} from "../resolve-stacks";
import {
  emptyEnvironmentStack,
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
