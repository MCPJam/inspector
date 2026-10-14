import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyComposerState } from "@/components/environment-composer/environment-stack";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";

const data = vi.hoisted(() => ({
  attachmentsLoading: true,
  environmentsEnabled: true,
  usageRows: undefined as ProjectEnvironmentView[] | undefined,
  query: vi.fn(),
}));
const first: ProjectEnvironmentView = {
  environmentId: "first",
  projectId: "project",
  hostId: "client",
  name: "First",
  serverAttachmentId: "valid",
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
};
const chosen = { ...first, environmentId: "chosen", name: "Chosen" };
const environments = [first, chosen];
const hosts = [{ hostId: "client" }];

vi.mock("convex/react", () => ({
  useConvex: () => ({ query: data.query }),
  useConvexAuth: () => ({ isAuthenticated: true }),
}));
vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => true,
}));
vi.mock("@/hooks/useProjects", () => ({ shouldQueryProjectId: () => true }));
vi.mock("@/hooks/useProjectEnvironments", () => ({
  useProjectEnvironments: () => data.usageRows,
}));
vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => data.environmentsEnabled,
}));
vi.mock("@/hooks/useViews", () => ({
  useProjectServerAttachments: () => ({
    isLoading: data.attachmentsLoading,
    serverAttachments: [
      { _id: "empty", name: "Empty", serverIds: [] },
      { _id: "valid", name: "Valid", serverIds: ["server"] },
    ],
  }),
  useProjectServers: () => ({ servers: [] }),
}));
vi.mock("@/state/app-state-context", () => ({
  useOptionalSharedAppState: () => null,
}));
vi.mock("@/components/environment-composer/use-cloud-server-readiness", () => ({
  useCloudServerReadiness: () => ({ status: "ok" }),
}));
vi.mock("@/components/environment-composer/use-composer-resolver", () => ({
  useComposerResolver: () => vi.fn(),
}));

import { useSwarmDefaultTarget } from "../use-swarm-default-target";

function useTarget() {
  return useSwarmDefaultTarget({
    projectId: "project",
    active: true,
    environments,
    hosts,
  });
}

beforeEach(() => {
  data.attachmentsLoading = true;
  data.environmentsEnabled = true;
  data.usageRows = undefined;
});

describe("swarm default target seeding", () => {
  it("preserves a saved selection made before attachment and usage data arrive", () => {
    const { result, rerender } = renderHook(useTarget);
    act(() =>
      result.current.setState({
        ...emptyComposerState(),
        environmentIds: ["chosen"],
      }),
    );
    data.attachmentsLoading = false;
    data.usageRows = environments;
    rerender();
    expect(result.current.state.environmentIds).toEqual(["chosen"]);
    expect(result.current.state.customized).toBe(false);
  });

  it("preserves composed edits while the default is waiting for data", () => {
    const { result, rerender } = renderHook(useTarget);
    const edited = emptyComposerState();
    edited.customized = true;
    edited.stack.hostIds = ["client"];
    edited.stack.serverAttachmentId = "chosen-group";
    act(() => result.current.setState(edited));
    data.attachmentsLoading = false;
    data.usageRows = environments;
    rerender();
    expect(result.current.state).toEqual(edited);
  });

  it("skips an empty group when seeding a composed default", () => {
    data.attachmentsLoading = false;
    data.environmentsEnabled = false;
    data.usageRows = [];
    const { result } = renderHook(useTarget);
    expect(result.current.state.stack.serverAttachmentId).toBe("valid");
  });
});
