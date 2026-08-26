/**
 * ProjectEnvironmentsRoute — `/environments/:environmentId` permalinks.
 *
 * Selection on this screen has always been component state, which is why
 * `/environments` alone could never be a permalink: it opens whichever row
 * the viewer last clicked. The route param drives selection instead — and the
 * two ways that can go wrong are what this file pins.
 *
 * The cross-project case is the important one. An agent-minted permalink
 * carries `?project=`, so arriving on it CHANGES the active project, and the
 * project-switch reset clears the selection while the route keeps its id. A
 * route effect that did not depend on `projectId` therefore left the target
 * in the URL, resolving as found, while the screen rendered the collection —
 * the wrong-resource landing, on the one journey permalinks exist for.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFlagValue, mockEnvironments } = vi.hoisted(() => ({
  mockFlagValue: { value: true as boolean | undefined },
  mockEnvironments: {
    value: [] as Array<Record<string, unknown>>,
  },
}));

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => mockFlagValue.value,
}));
vi.mock("@/hooks/useProjectEnvironments", () => ({
  useProjectEnvironments: () => mockEnvironments.value,
  useArchiveProjectEnvironment: () => vi.fn(),
  useRestoreProjectEnvironment: () => vi.fn(),
}));
vi.mock("../ProjectEnvironmentEditor", () => ({
  ProjectEnvironmentEditor: () => <div data-testid="editor" />,
}));
vi.mock("../use-project-environment-consumers", () => ({
  useProjectEnvironmentConsumers: () => ({ consumers: [], loading: false }),
}));
vi.mock("../EnvironmentCanvasPanel", () => ({
  EnvironmentCanvasPanel: () => <div data-testid="stub-env-canvas" />,
}));
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("react-router", () => ({
  Navigate: () => <div data-testid="redirect" />,
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("@/hooks/useScenarios", () => ({
  useEnvironmentScenario: () => ({ scenario: null, isLoading: false }),
}));

import { ProjectEnvironmentsRoute } from "../ProjectEnvironmentsRoute";

function environment(id: string, name: string, projectId: string) {
  return {
    environmentId: id,
    name,
    projectId,
    hostId: "host_1",
    revision: 1,
    archivedAt: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFlagValue.value = true;
  mockEnvironments.value = [];
});

describe("ProjectEnvironmentsRoute — permalink targets", () => {
  it("opens the environment the route names", async () => {
    mockEnvironments.value = [environment("env_1", "Staging", "proj_1")];
    render(
      <ProjectEnvironmentsRoute
        isAuthenticated
        projectId="proj_1"
        canManage
        routeEnvironmentId="env_1"
      />
    );
    await waitFor(() => expect(screen.getByTestId("editor")).toBeVisible());
  });

  it("re-applies the target after a cross-project switch", async () => {
    // What a `?project=` permalink does: the route id is unchanged while the
    // active project moves under it. The project-switch reset clears the
    // selection, so the route effect has to run again on `projectId` alone.
    mockEnvironments.value = [environment("env_1", "Staging", "proj_1")];
    const { rerender } = render(
      <ProjectEnvironmentsRoute
        isAuthenticated
        projectId="proj_1"
        canManage
        routeEnvironmentId="env_1"
      />
    );
    await waitFor(() => expect(screen.getByTestId("editor")).toBeVisible());

    mockEnvironments.value = [environment("env_1", "Staging", "proj_2")];
    rerender(
      <ProjectEnvironmentsRoute
        isAuthenticated
        projectId="proj_2"
        canManage
        routeEnvironmentId="env_1"
      />
    );
    await waitFor(() => expect(screen.getByTestId("editor")).toBeVisible());
  });

  it("says so, once, when the target is not in the loaded list", async () => {
    // Deleted or not-authorized — deliberately indistinguishable. It must NOT
    // fall through to the collection: rendering a different environment is
    // the silent wrong-resource landing this whole contract exists to end.
    mockEnvironments.value = [environment("env_9", "Other", "proj_1")];
    render(
      <ProjectEnvironmentsRoute
        isAuthenticated
        projectId="proj_1"
        canManage
        routeEnvironmentId="env_1"
      />
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("environment-permalink-unavailable")
      ).toBeVisible()
    );
    expect(screen.queryByTestId("editor")).not.toBeInTheDocument();
    expect(screen.queryByText("Other")).not.toBeInTheDocument();
  });

  it("waits instead of deciding while the list is still loading", async () => {
    // `undefined` is "not here yet". Calling it unavailable would flash the
    // deleted-or-forbidden message at someone whose link is about to work.
    mockEnvironments.value = undefined as never;
    render(
      <ProjectEnvironmentsRoute
        isAuthenticated
        projectId="proj_1"
        canManage
        routeEnvironmentId="env_1"
      />
    );
    expect(
      screen.queryByTestId("environment-permalink-unavailable")
    ).not.toBeInTheDocument();
  });
});
