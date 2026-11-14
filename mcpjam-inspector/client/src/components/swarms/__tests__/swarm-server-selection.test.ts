import { describe, expect, it, vi } from "vitest";
import { emptyComposerState } from "@/components/environment-composer/environment-stack";
import {
  lacksServerSource,
  resolveComposerEnvironments,
} from "@/components/environment-composer/resolve-stacks";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";

const environment: ProjectEnvironmentView = {
  environmentId: "env",
  projectId: "project",
  hostId: "client",
  name: "Saved target",
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
};

describe("swarm server selection", () => {
  it("refuses a restored empty composition before creating an environment", async () => {
    const state = emptyComposerState();
    state.stack.hostIds = ["client"];
    state.customized = true;
    const ensureAdhocEnvironments = vi.fn();
    await expect(
      resolveComposerEnvironments({
        projectId: "project",
        state,
        liveEnvironments: [],
        ensureAdhocEnvironments,
        skillsEnabled: false,
        computersEnabled: false,
        max: 1,
        requireServerAttachment: true,
        allowEmptyServerSelection: false,
      }),
    ).rejects.toMatchObject({ code: "NO_SERVER_GROUP" });
    expect(ensureAdhocEnvironments).not.toHaveBeenCalled();
  });

  it.each(["none", "local"] as const)(
    "blocks a saved %s target without changing eval selection rules",
    async (mode) => {
      const target: ProjectEnvironmentView = {
        ...environment,
        serverSelection:
          mode === "none" ? { mode } : { mode, names: ["local-server"] },
      };
      const state = emptyComposerState();
      state.environmentIds = [target.environmentId];
      const ensureAdhocEnvironments = vi.fn();
      await expect(
        resolveComposerEnvironments({
          projectId: "project",
          state,
          liveEnvironments: [target],
          ensureAdhocEnvironments,
          skillsEnabled: false,
          computersEnabled: false,
          max: 1,
          requireServerAttachment: true,
          allowEmptyServerSelection: false,
        }),
      ).rejects.toMatchObject({ code: "NO_SERVER_GROUP" });
      expect(lacksServerSource(target)).toBe(false);
      expect(ensureAdhocEnvironments).not.toHaveBeenCalled();
    },
  );

  it("allows selected groups and pinned plugins as explicit sources", () => {
    expect(
      lacksServerSource({ ...environment, serverAttachmentId: "group" }, false),
    ).toBe(false);
    expect(
      lacksServerSource(
        { ...environment, pluginVersionIds: ["plugin"] },
        false,
      ),
    ).toBe(false);
    expect(lacksServerSource(environment, false)).toBe(true);
  });
});
