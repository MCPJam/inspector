/**
 * A composed setup's MCP-server skills and "All shared Library skills"
 * scope: they reach the environments the backend creates, a saved
 * environment is reused only when it runs the same ones, and they survive the
 * trip through a saved environment's stack.
 */
import { describe, expect, it, vi } from "vitest";
import {
  resolveComposerEnvironments,
  type EnsureAdhocEnvironmentsFn,
} from "../resolve-stacks";
import {
  composerStateFromEnvironments,
  emptyEnvironmentStack,
  environmentsExceedOneStack,
  stackFromEnvironment,
  type EnvironmentStack,
} from "../environment-stack";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";

const lookup = { mode: "explicit" as const, serverSkillIds: ["lookup"] };

const named = (
  overrides: Partial<ProjectEnvironmentView>,
): ProjectEnvironmentView =>
  ({
    environmentId: "named",
    projectId: "proj-1",
    hostId: "host-1",
    name: "Support",
    origin: "named",
    serverAttachmentId: "group",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }) as ProjectEnvironmentView;

const resolve = (
  stack: Partial<EnvironmentStack>,
  options: {
    liveEnvironments?: ProjectEnvironmentView[];
    skillsEnabled?: boolean;
  } = {},
) => {
  const ensure = vi.fn<EnsureAdhocEnvironmentsFn>(async () => [
    { environment: named({ environmentId: "minted", origin: "adhoc" }) },
  ]);
  const result = resolveComposerEnvironments({
    projectId: "proj-1",
    skillsEnabled: options.skillsEnabled ?? true,
    computersEnabled: false,
    max: 10,
    state: {
      environmentIds: [],
      stack: {
        ...emptyEnvironmentStack(),
        hostIds: ["host-1"],
        serverAttachmentId: "group",
        ...stack,
      },
      customized: true,
    },
    liveEnvironments: options.liveEnvironments ?? [],
    ensureAdhocEnvironments: ensure,
  });
  return { ensure, result };
};

describe("resolveComposerEnvironments with server skills and the scope", () => {
  it("sends both to the environments it creates", async () => {
    const { ensure, result } = resolve({
      serverSkillSelection: lookup,
      skillScope: "all-shared-library",
    });
    await result;
    expect(ensure).toHaveBeenCalledWith({
      projectId: "proj-1",
      stacks: [
        {
          hostId: "host-1",
          serverAttachmentId: "group",
          serverSkillSelection: lookup,
          skillScope: "all-shared-library",
        },
      ],
    });
  });

  it("drops both without skills-enabled, like a Library pick", async () => {
    const { ensure, result } = resolve(
      { serverSkillSelection: lookup, skillScope: "all-shared-library" },
      { skillsEnabled: false },
    );
    await result;
    expect(ensure).toHaveBeenCalledWith({
      projectId: "proj-1",
      stacks: [{ hostId: "host-1", serverAttachmentId: "group" }],
    });
  });

  it("reuses a saved environment only when it runs the same scope and server skills", async () => {
    const scoped = named({ skillScope: "all-shared-library" });
    const same = resolve(
      { skillScope: "all-shared-library" },
      { liveEnvironments: [scoped] },
    );
    expect((await same.result).environmentIds).toEqual(["named"]);
    expect(same.ensure).not.toHaveBeenCalled();

    const plain = resolve({}, { liveEnvironments: [scoped] });
    expect((await plain.result).environmentIds).toEqual(["minted"]);

    const withServer = resolve(
      { serverSkillSelection: lookup },
      { liveEnvironments: [named({})] },
    );
    expect((await withServer.result).environmentIds).toEqual(["minted"]);
  });
});

describe("a saved environment's stack", () => {
  const scope = "all-shared-library" as const;
  const fields = { serverSkillSelection: lookup, skillScope: scope };
  const rich = named(fields);
  const other = (overrides: Partial<ProjectEnvironmentView> = {}) =>
    named({ environmentId: "other", hostId: "host-2", ...overrides });

  it("carries the server skills and the scope, so the environment still matches its own stack", async () => {
    const stack = stackFromEnvironment(rich);
    expect(stack).toMatchObject({
      serverSkillSelection: lookup,
      skillScope: scope,
    });
    const { ensure, result } = resolve(stack, { liveEnvironments: [rich] });
    expect((await result).environmentIds).toEqual(["named"]);
    expect(ensure).not.toHaveBeenCalled();
  });

  it("seeds the composer with what every environment runs, and nothing where they differ", () => {
    const same = composerStateFromEnvironments([rich, other(fields)]);
    expect(same.stack).toMatchObject({
      serverSkillSelection: lookup,
      skillScope: scope,
    });
    const apart = composerStateFromEnvironments([rich, other()]);
    expect(apart.stack).toMatchObject({
      serverSkillSelection: null,
      skillScope: null,
    });
  });

  it("can't be edited as one stack when environments differ in either", () => {
    const enabled = { skillsEnabled: true, computersEnabled: false };
    const scoped = named({ skillScope: scope });
    const picked = named({ serverSkillSelection: lookup });
    expect(environmentsExceedOneStack([scoped, other()], enabled)).toBe(true);
    expect(environmentsExceedOneStack([picked, other()], enabled)).toBe(true);
    expect(environmentsExceedOneStack([rich, other(fields)], enabled)).toBe(
      false,
    );
    // Without skills-enabled no run uses them, so differing costs nothing.
    expect(
      environmentsExceedOneStack([scoped, other()], {
        ...enabled,
        skillsEnabled: false,
      }),
    ).toBe(false);
  });
});
