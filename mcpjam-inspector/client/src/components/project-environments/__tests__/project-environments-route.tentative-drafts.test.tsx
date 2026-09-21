/**
 * ProjectEnvironmentsRoute — Swarm tentative castle draft handoff.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFlagValue, mockEditorProps } = vi.hoisted(() => ({
  mockFlagValue: { value: true as boolean | undefined },
  mockEditorProps: vi.fn(),
}));

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => mockFlagValue.value,
}));
vi.mock("@/hooks/useProjectEnvironments", () => ({
  useProjectEnvironments: () => [],
  useArchiveProjectEnvironment: () => vi.fn(),
  useRestoreProjectEnvironment: () => vi.fn(),
}));
vi.mock("../ProjectEnvironmentEditor", async () => {
  const { useState } = await import("react");
  return {
    ProjectEnvironmentEditor: (props: Record<string, unknown>) => {
      const [captured] = useState(() => props.initialDraft);
      mockEditorProps({ ...props, capturedInitialDraft: captured });
      return (
        <div data-testid="editor">
          <button
            type="button"
            data-testid="fake-save"
            onClick={() =>
              (props.onCreated as ((env: unknown) => void) | undefined)?.({
                environmentId: "env_new",
                name: "Saved",
              })
            }
          >
            Save
          </button>
        </div>
      );
    },
  };
});
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

// The detail pane links back to a published scenario, reading the shared
// scenario list. Unpublished here — the link's own behavior is covered in the
// User Testing suites.
vi.mock("@/hooks/useScenarios", () => ({
  useEnvironmentScenario: () => ({ scenario: null, isLoading: false }),
}));

import { ProjectEnvironmentsRoute } from "../ProjectEnvironmentsRoute";
import {
  listTentativeCastles,
  saveTentativeCastle,
} from "@/lib/tentative-castle-drafts";

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  mockFlagValue.value = true;
});

describe("ProjectEnvironmentsRoute — tentative castle drafts", () => {
  it("lists drafts and opens create with the draft as initialDraft", async () => {
    saveTentativeCastle("proj_1", {
      name: "Swarm setup",
      hostIds: ["host_1"],
      serverAttachmentId: "sg_1",
      skillSelection: null,
      computerEnvironmentId: null,
    });

    render(
      <ProjectEnvironmentsRoute isAuthenticated projectId="proj_1" canManage />
    );

    expect(screen.getByTestId("environment-tentative-drafts")).toBeVisible();
    const draftId = listTentativeCastles("proj_1")[0]!.id;
    fireEvent.click(
      screen.getByTestId(`environment-tentative-draft-${draftId}`)
    );

    await waitFor(() => expect(screen.getByTestId("editor")).toBeVisible());
    const props = mockEditorProps.mock.calls.at(-1)![0] as {
      capturedInitialDraft?: {
        name?: string;
        hostId: string | null;
        serverAttachmentId: string | null;
      };
    };
    expect(props.capturedInitialDraft).toMatchObject({
      name: "Swarm setup",
      hostId: "host_1",
      serverAttachmentId: "sg_1",
    });
    // Draft remains until save — not one-shot.
    expect(listTentativeCastles("proj_1")).toHaveLength(1);
  });

  it("clears the draft after a successful create", async () => {
    const saved = saveTentativeCastle("proj_1", {
      name: "Clear me",
      hostIds: ["host_1"],
      serverAttachmentId: null,
      skillSelection: null,
      computerEnvironmentId: null,
    })!;

    render(
      <ProjectEnvironmentsRoute isAuthenticated projectId="proj_1" canManage />
    );
    fireEvent.click(
      screen.getByTestId(`environment-tentative-draft-${saved.id}`)
    );
    await waitFor(() => expect(screen.getByTestId("editor")).toBeVisible());
    fireEvent.click(screen.getByTestId("fake-save"));

    await waitFor(() =>
      expect(listTentativeCastles("proj_1")).toHaveLength(0)
    );
  });
});
