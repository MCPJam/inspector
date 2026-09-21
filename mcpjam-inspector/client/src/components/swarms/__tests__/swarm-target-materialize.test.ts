import { describe, expect, it, vi } from "vitest";
import {
  ENVIRONMENT_NAME_MAX_LENGTH,
  findMatchingLiveEnvironment,
  materializeSwarmTargets,
  SwarmTargetMaterializeError,
} from "../swarm-target-materialize";
import { emptyEnvironmentStack } from "@/components/environment-composer/environment-stack";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";
import { MAX_ENVIRONMENTS_PER_JOURNEY } from "../journey-environments";

function env(
  overrides: Partial<ProjectEnvironmentView> &
    Pick<ProjectEnvironmentView, "environmentId" | "hostId">
): ProjectEnvironmentView {
  return {
    projectId: "proj-1",
    name: overrides.name ?? "Env",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("findMatchingLiveEnvironment", () => {
  it("matches host + stack fields and ignores archived rows", () => {
    const live = [
      env({
        environmentId: "archived",
        hostId: "h1",
        archivedAt: 9,
        serverAttachmentId: "sg1",
      }),
      env({
        environmentId: "match",
        hostId: "h1",
        serverAttachmentId: "sg1",
        skillSelection: { mode: "explicit", skillIds: ["sk1"] },
        computerEnvironmentId: "img1",
      }),
    ];
    expect(
      findMatchingLiveEnvironment(
        "h1",
        {
          serverAttachmentId: "sg1",
          skillSelection: { mode: "explicit", skillIds: ["sk1"] },
          computerEnvironmentId: "img1",
        },
        live
      )?.environmentId
    ).toBe("match");
  });

  it("treats null and undefined stack fields as equal", () => {
    const live = [env({ environmentId: "bare", hostId: "h1" })];
    expect(
      findMatchingLiveEnvironment(
        "h1",
        {
          serverAttachmentId: null,
          skillSelection: null,
          computerEnvironmentId: null,
        },
        live
      )?.environmentId
    ).toBe("bare");
  });

  it("never reuses a row carrying a model override", () => {
    // The swarm strip has no model slot, so its composition always means
    // "inherit the client's model". Matching a row that pins one on the
    // strength of the other slots would run the swarm on a model nobody
    // selected here, under a name that says nothing about it.
    const live = [
      env({
        environmentId: "pinned",
        hostId: "h1",
        modelId: "anthropic/claude-haiku-4.5",
      }),
      env({ environmentId: "inherit", hostId: "h1" }),
    ];
    expect(
      findMatchingLiveEnvironment(
        "h1",
        {
          serverAttachmentId: null,
          skillSelection: null,
          computerEnvironmentId: null,
        },
        live
      )?.environmentId
    ).toBe("inherit");
  });

  it("returns nothing when the only same-stack row pins a model", () => {
    const live = [
      env({
        environmentId: "pinned",
        hostId: "h1",
        modelId: "google/gemini-2.5-flash",
      }),
    ];
    expect(
      findMatchingLiveEnvironment(
        "h1",
        {
          serverAttachmentId: null,
          skillSelection: null,
          computerEnvironmentId: null,
        },
        live
      )
    ).toBeUndefined();
  });
});

describe("materializeSwarmTargets", () => {
  it("reuses matching live envs and creates the rest", async () => {
    const createEnvironment = vi.fn(async (args) =>
      env({
        environmentId: `created-${args.hostId}`,
        hostId: args.hostId,
        name: args.name,
        serverAttachmentId: args.serverAttachmentId ?? null,
      })
    );
    const result = await materializeSwarmTargets({
      projectId: "proj-1",
      stackName: "Billing",
      legos: {
        ...emptyEnvironmentStack(),
        hostIds: ["h1", "h2"],
        serverAttachmentId: "sg1",
      },
      hostName: (id) => (id === "h1" ? "Claude" : "Cursor"),
      liveEnvironments: [
        env({
          environmentId: "existing-h1",
          hostId: "h1",
          serverAttachmentId: "sg1",
        }),
      ],
      createEnvironment,
      skillsEnabled: true,
      computersEnabled: true,
    });

    expect(result.environmentIds).toEqual(["existing-h1", "created-h2"]);
    expect(result.reusedIds).toEqual(["existing-h1"]);
    expect(result.createdIds).toEqual(["created-h2"]);
    expect(createEnvironment).toHaveBeenCalledTimes(1);
    expect(createEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        hostId: "h2",
        name: "Billing · Cursor",
        serverAttachmentId: "sg1",
      })
    );
  });

  it("refuses more than MAX_ENVIRONMENTS_PER_JOURNEY clients", async () => {
    const hostIds = Array.from(
      { length: MAX_ENVIRONMENTS_PER_JOURNEY + 1 },
      (_, i) => `h${i}`
    );
    await expect(
      materializeSwarmTargets({
        projectId: "proj-1",
        stackName: "Swarm setup",
        legos: { ...emptyEnvironmentStack(), hostIds },
        hostName: (id) => id,
        liveEnvironments: [],
        createEnvironment: vi.fn(),
        skillsEnabled: false,
        computersEnabled: false,
      })
    ).rejects.toBeInstanceOf(SwarmTargetMaterializeError);
  });

  it("truncates the stack half so the name fits the backend cap", async () => {
    const createEnvironment = vi.fn(async (args) =>
      env({ environmentId: "created", hostId: args.hostId, name: args.name })
    );
    // A Describe paragraph, which is what `stackName` actually carries.
    const describe =
      "Test whether our support agent can handle refund requests end to end across every connected client we ship";
    await materializeSwarmTargets({
      projectId: "proj-1",
      stackName: describe,
      legos: { ...emptyEnvironmentStack(), hostIds: ["h1"] },
      hostName: () => "Claude Code",
      liveEnvironments: [],
      createEnvironment,
      skillsEnabled: false,
      computersEnabled: false,
    });
    const { name } = createEnvironment.mock.calls[0]![0];
    expect(name.length).toBeLessThanOrEqual(ENVIRONMENT_NAME_MAX_LENGTH);
    // The client half survives whole; the paragraph is what gives way.
    expect(name.endsWith(" · Claude Code")).toBe(true);
    expect(describe.startsWith(name.replace(" · Claude Code", ""))).toBe(true);
  });

  it("uniquifies against live names and rows created in the same batch", async () => {
    const createEnvironment = vi.fn(async (args) =>
      env({
        environmentId: `created-${args.hostId}`,
        hostId: args.hostId,
        name: args.name,
      })
    );
    await materializeSwarmTargets({
      projectId: "proj-1",
      stackName: "Billing",
      legos: { ...emptyEnvironmentStack(), hostIds: ["h1", "h2"] },
      // Both clients render the same display name, so the auto-names collide.
      hostName: () => "Claude",
      liveEnvironments: [
        env({ environmentId: "other", hostId: "h9", name: "Billing · Claude" }),
      ],
      createEnvironment,
      skillsEnabled: false,
      computersEnabled: false,
    });
    const names = createEnvironment.mock.calls.map((c) => c[0].name);
    expect(names).toEqual(["Billing · Claude (2)", "Billing · Claude (3)"]);
  });

  it("retries the next suffix when the backend reports a name conflict", async () => {
    const conflict = Object.assign(new Error("conflict"), {
      data: { code: "CONFLICT", message: 'An environment named "X" already exists.' },
    });
    const createEnvironment = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockImplementationOnce(async (args) =>
        env({ environmentId: "created", hostId: args.hostId, name: args.name })
      );
    const result = await materializeSwarmTargets({
      projectId: "proj-1",
      stackName: "Billing",
      legos: { ...emptyEnvironmentStack(), hostIds: ["h1"] },
      hostName: () => "Claude",
      liveEnvironments: [],
      createEnvironment,
      skillsEnabled: false,
      computersEnabled: false,
    });
    expect(result.createdIds).toEqual(["created"]);
    expect(createEnvironment.mock.calls.map((c) => c[0].name)).toEqual([
      "Billing · Claude",
      "Billing · Claude (2)",
    ]);
  });

  it("surfaces the backend's own message instead of a generic failure", async () => {
    const createEnvironment = vi.fn().mockRejectedValue(
      Object.assign(new Error("rejected"), {
        data: {
          code: "FORBIDDEN",
          message:
            "Managing environments requires project admin (shared execution config).",
        },
      })
    );
    await expect(
      materializeSwarmTargets({
        projectId: "proj-1",
        stackName: "Billing",
        legos: { ...emptyEnvironmentStack(), hostIds: ["h1"] },
        hostName: () => "Claude",
        liveEnvironments: [],
        createEnvironment,
        skillsEnabled: false,
        computersEnabled: false,
      })
    ).rejects.toThrow(/requires project admin/);
    // And it must arrive as the type the create flow renders verbatim.
    await expect(
      materializeSwarmTargets({
        projectId: "proj-1",
        stackName: "Billing",
        legos: { ...emptyEnvironmentStack(), hostIds: ["h1"] },
        hostName: () => "Claude",
        liveEnvironments: [],
        createEnvironment,
        skillsEnabled: false,
        computersEnabled: false,
      })
    ).rejects.toBeInstanceOf(SwarmTargetMaterializeError);
  });

  it("omits flag-gated stack fields from create payloads", async () => {
    const createEnvironment = vi.fn(async (args) =>
      env({
        environmentId: "created",
        hostId: args.hostId,
        name: args.name,
      })
    );
    await materializeSwarmTargets({
      projectId: "proj-1",
      stackName: "Swarm setup",
      legos: {
        ...emptyEnvironmentStack(),
        hostIds: ["h1"],
        skillSelection: { mode: "explicit", skillIds: ["sk1"] },
        computerEnvironmentId: "img1",
      },
      hostName: () => "Claude",
      liveEnvironments: [],
      createEnvironment,
      skillsEnabled: false,
      computersEnabled: false,
    });
    const args = createEnvironment.mock.calls[0]![0];
    expect("skillSelection" in args).toBe(false);
    expect("computerEnvironmentId" in args).toBe(false);
  });
});
