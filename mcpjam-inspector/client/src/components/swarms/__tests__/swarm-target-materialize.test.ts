import { describe, expect, it, vi } from "vitest";
import {
  findMatchingLiveEnvironment,
  materializeSwarmTargets,
  SwarmTargetMaterializeError,
} from "../swarm-target-materialize";
import { emptySwarmLegoStack } from "../swarm-target-types";
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
        ...emptySwarmLegoStack(),
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
        legos: { ...emptySwarmLegoStack(), hostIds },
        hostName: (id) => id,
        liveEnvironments: [],
        createEnvironment: vi.fn(),
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
        ...emptySwarmLegoStack(),
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
