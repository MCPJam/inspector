import { describe, expect, it, vi } from "vitest";
import type { EnsureServersReadyResult } from "@/hooks/use-app-state";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";
import {
  attachedSuiteEnvironments,
  defaultQuickRunModelIds,
  defaultQuickRunServerGroup,
  ensureLocalEnvironmentServers,
  planQuickRunTargets,
  quickRunClientIds,
  resolveQuickRunEnvironments,
} from "../environment-quick-run";

function env(
  id: string,
  fields: Partial<ProjectEnvironmentView> = {},
): ProjectEnvironmentView {
  return {
    environmentId: id,
    projectId: "p",
    hostId: "host-1",
    serverAttachmentId: "group-1",
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
    ...fields,
  };
}

describe("attachedSuiteEnvironments", () => {
  it("keeps suite order and waits for every environment", () => {
    const rows = [env("b"), env("a")];
    expect(
      attachedSuiteEnvironments({ environmentIds: ["a", "b"] }, rows)?.map(
        (row) => row.environmentId,
      ),
    ).toEqual(["a", "b"]);
    expect(
      attachedSuiteEnvironments({ environmentIds: ["a", "missing"] }, rows),
    ).toBeNull();
    expect(
      attachedSuiteEnvironments({ environmentIds: ["a"] }, undefined),
    ).toBeNull();
  });
});

describe("defaults", () => {
  const attached = [
    env("a", { hostId: "host-1", modelId: "m1" }),
    env("b", { hostId: "host-2" }),
    env("c", { hostId: "host-1" }),
  ];

  it("offers the environments' clients in order", () => {
    expect(quickRunClientIds(attached)).toEqual(["host-1", "host-2"]);
  });

  it("starts on the shared group, or none when groups differ", () => {
    expect(defaultQuickRunServerGroup(attached)).toBe("group-1");
    expect(
      defaultQuickRunServerGroup([
        ...attached,
        env("d", { serverAttachmentId: "group-2" }),
      ]),
    ).toBeNull();
  });

  it("starts on the models a client's environments run", () => {
    expect(
      defaultQuickRunModelIds(attached, "host-1", () => "client-model"),
    ).toEqual(["m1", "client-model"]);
  });
});

describe("planQuickRunTargets", () => {
  it("reuses the suite's own environment for the client, model and group", () => {
    const plans = planQuickRunTargets({
      attached: [
        env("a", { modelId: "m1" }),
        env("b", { modelId: "m2", skillSelection: null }),
      ],
      serverAttachmentId: "group-1",
      targets: [{ key: "v", hostId: "host-1", modelId: "m2" }],
    });
    expect(plans).toEqual([{ kind: "reuse", key: "v", environmentId: "b" }]);
  });

  it("matches an environment that inherits the model from its client", () => {
    const plans = planQuickRunTargets({
      attached: [env("a")],
      serverAttachmentId: "group-1",
      targets: [{ key: "v", hostId: "host-1", modelId: "client-model" }],
      clientModelId: () => "client-model",
    });
    expect(plans[0]).toMatchObject({ kind: "reuse", environmentId: "a" });
  });

  it("refuses two matching environments instead of guessing", () => {
    const plans = planQuickRunTargets({
      attached: [
        env("a", { modelId: "m1" }),
        env("b", {
          modelId: "m1",
          skillSelection: { mode: "explicit", skillIds: ["s"] },
        }),
      ],
      serverAttachmentId: "group-1",
      targets: [{ key: "v", hostId: "host-1", modelId: "m1" }],
    });
    expect(plans[0]?.kind).toBe("blocked");
  });

  it("derives a new model from the one setup the client's environments share", () => {
    const source = env("a", {
      modelId: "m1",
      pluginVersionIds: ["pv-1"],
      revision: 7,
    });
    const plans = planQuickRunTargets({
      attached: [source],
      serverAttachmentId: "group-2",
      targets: [{ key: "v", hostId: "host-1", modelId: "m9" }],
    });
    // Plugin pins survive: the backend derives from the stored row.
    expect(plans).toEqual([
      {
        kind: "derive",
        key: "v",
        source,
        overrides: {
          hostId: "host-1",
          modelId: "m9",
          serverAttachmentId: "group-2",
        },
      },
    ]);
  });

  it("refuses a new combination when the setups to copy differ", () => {
    const plans = planQuickRunTargets({
      attached: [
        env("a", { modelId: "m1" }),
        env("b", {
          modelId: "m2",
          skillSelection: { mode: "explicit", skillIds: ["s"] },
        }),
      ],
      serverAttachmentId: "group-1",
      targets: [{ key: "v", hostId: "host-1", modelId: "m3" }],
    });
    expect(plans[0]?.kind).toBe("blocked");
  });

  it("refuses without a server group rather than running no servers", () => {
    const plans = planQuickRunTargets({
      attached: [env("a", { modelId: "m1" })],
      serverAttachmentId: null,
      targets: [{ key: "v", hostId: "host-1", modelId: "m9" }],
    });
    expect(plans[0]).toMatchObject({
      kind: "blocked",
      reason: "Pick a server group to run this case.",
    });
  });
});

describe("resolveQuickRunEnvironments", () => {
  const reuse = { kind: "reuse" as const, key: "a", environmentId: "env-a" };
  const derive = {
    kind: "derive" as const,
    key: "b",
    source: env("src", { revision: 3 }),
    overrides: { hostId: "h", modelId: "m", serverAttachmentId: "g" },
  };

  it("derives every new target in one call and keeps reused ones", async () => {
    const convex = {
      query: vi.fn(async () => ({
        environmentQuickRuns: true,
        environmentDerivation: true,
      })),
      mutation: vi.fn(async () => [
        { environment: { environmentId: "env-b" } },
      ]),
    };
    const resolved = await resolveQuickRunEnvironments(convex, {
      projectId: "p",
      plans: [reuse, derive],
    });
    expect([...resolved.entries()]).toEqual([
      ["a", "env-a"],
      ["b", "env-b"],
    ]);
    expect(convex.mutation).toHaveBeenCalledTimes(1);
    expect(convex.mutation).toHaveBeenCalledWith(
      "projectEnvironments:deriveEnvironments",
      {
        projectId: "p",
        derivations: [
          {
            sourceEnvironmentId: "src",
            expectedRevision: 3,
            overrides: derive.overrides,
          },
        ],
      },
    );
  });

  it("refuses a blocked target before touching the backend", async () => {
    const convex = { query: vi.fn(), mutation: vi.fn() };
    await expect(
      resolveQuickRunEnvironments(convex, {
        projectId: "p",
        plans: [reuse, { kind: "blocked", key: "c", reason: "No." }],
      }),
    ).rejects.toThrow("No.");
    expect(convex.query).not.toHaveBeenCalled();
  });

  it("refuses on a deployment without environment quick runs", async () => {
    const convex = {
      query: vi.fn(async () => {
        throw new Error("Could not find public function");
      }),
      mutation: vi.fn(),
    };
    await expect(
      resolveQuickRunEnvironments(convex, { projectId: "p", plans: [reuse] }),
    ).rejects.toThrow(/can't run a single case/);
  });

  it("refuses to derive without lossless derivation", async () => {
    const convex = {
      query: vi.fn(async () => ({ environmentQuickRuns: true })),
      mutation: vi.fn(),
    };
    await expect(
      resolveQuickRunEnvironments(convex, { projectId: "p", plans: [derive] }),
    ).rejects.toThrow(/can't copy an environment/);
    expect(convex.mutation).not.toHaveBeenCalled();
  });
});

describe("ensureLocalEnvironmentServers", () => {
  const ready: EnsureServersReadyResult = {
    readyServerNames: [],
    missingServerNames: [],
    failedServerNames: [],
    reauthServerNames: [],
  };

  function convexResolving(byEnvironment: Record<string, unknown>) {
    return {
      query: vi.fn(async (_name: string, args: { environmentId: string }) => {
        const resolved = byEnvironment[args.environmentId];
        if (resolved instanceof Error) throw resolved;
        return resolved ?? null;
      }),
      mutation: vi.fn(),
    };
  }

  it("connects each environment's servers once, by name, ids for a backend without names", async () => {
    const convex = convexResolving({
      "env-a": { servers: [{ serverId: "srv-1", name: "billing" }] },
      "env-b": {
        servers: [
          { serverId: "srv-1", name: "billing" },
          { serverId: "srv-2", name: "" },
        ],
      },
      "env-c": { effectiveServerIds: ["srv-3"], selectedServerIds: [] },
      // Refused here, reported precisely by the run route: not a blocker.
      "env-d": new Error("ENV_NO_SERVERS"),
    });
    const ensureServersReady = vi.fn(async () => ready);
    await expect(
      ensureLocalEnvironmentServers({
        convex,
        projectId: "p",
        environmentIds: ["env-a", "env-b", "env-a", "env-c", "env-d"],
        ensureServersReady,
      }),
    ).resolves.toBeNull();
    expect(convex.query).toHaveBeenCalledTimes(4);
    expect(convex.query).toHaveBeenCalledWith(
      "projectEnvironments:resolveEnvironmentForLaunch",
      {
        projectId: "p",
        environmentId: "env-a",
        serverSource: "environment_only",
      },
    );
    expect(ensureServersReady).toHaveBeenCalledWith([
      "billing",
      "srv-2",
      "srv-3",
    ]);
  });

  it("blocks on a failed or unauthorized server, not on one the pool does not know", async () => {
    const convex = convexResolving({
      "env-a": { servers: [{ serverId: "srv-1", name: "billing" }] },
    });
    const run = (readiness: EnsureServersReadyResult) =>
      ensureLocalEnvironmentServers({
        convex,
        projectId: "p",
        environmentIds: ["env-a"],
        ensureServersReady: async () => readiness,
      });
    await expect(
      run({ ...ready, missingServerNames: ["billing"] }),
    ).resolves.toBeNull();
    await expect(
      run({
        ...ready,
        missingServerNames: ["plugin"],
        reauthServerNames: ["billing"],
      }),
    ).resolves.toMatchObject({
      missingServerNames: [],
      reauthServerNames: ["billing"],
    });
  });

  it("connects nothing when no environment names a server", async () => {
    const ensureServersReady = vi.fn(async () => ready);
    await expect(
      ensureLocalEnvironmentServers({
        convex: convexResolving({}),
        projectId: "p",
        environmentIds: ["env-a"],
        ensureServersReady,
      }),
    ).resolves.toBeNull();
    expect(ensureServersReady).not.toHaveBeenCalled();
  });
});
