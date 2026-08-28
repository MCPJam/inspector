/**
 * ProjectEnvironmentsRoute — Connect "Save as environment" seed consumption.
 *
 * The contract under test: the seed is consumed one-shot from sessionStorage
 * ONLY once the flag has settled `true` (surviving the route's flag-hydration
 * null render), enters create mode with the seeded initialDraft, and never
 * re-enters create mode on a later visit. A project switch drops it.
 */
import { render, screen, waitFor } from "@testing-library/react";
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
    // Mirrors the REAL editor's contract: `initialDraft` feeds a useState
    // initializer, so it is read ONCE PER MOUNTED INSTANCE and later prop
    // changes are ignored. Recording the captured value (not the live prop) is
    // what makes a missing remount key observable — a reused instance keeps the
    // previous project's seed.
    ProjectEnvironmentEditor: (props: Record<string, unknown>) => {
      const [captured] = useState(() => props.initialDraft);
      mockEditorProps({ ...props, capturedInitialDraft: captured });
      return <div data-testid="editor" />;
    },
  };
});
vi.mock("../use-project-environment-consumers", () => ({
  useProjectEnvironmentConsumers: () => ({ consumers: [], loading: false }),
}));
// Hygiene: keeps xyflow's module graph out of a suite that mocks react-router
// down to `{ Navigate }`.
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
import { saveEnvironmentDraftSeed } from "@/lib/environment-draft-seed";

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  mockFlagValue.value = true;
});

describe("ProjectEnvironmentsRoute — seed consumption", () => {
  it("consumes a seed into create mode with the seeded initialDraft", async () => {
    saveEnvironmentDraftSeed("proj_1", {
      name: "Claude Code",
      hostId: "host_1",
      serverAttachmentId: null,
      skillSelection: null,
    });
    render(
      <ProjectEnvironmentsRoute isAuthenticated projectId="proj_1" canManage />,
    );

    await waitFor(() => expect(screen.getByTestId("editor")).toBeVisible());
    expect(screen.getByText("New environment")).toBeInTheDocument();
    const props = mockEditorProps.mock.calls.at(-1)![0] as {
      environment: unknown;
      capturedInitialDraft?: { hostId: string | null; name?: string };
    };
    expect(props.environment).toBeNull();
    expect(props.capturedInitialDraft).toMatchObject({
      name: "Claude Code",
      hostId: "host_1",
    });
    // One-shot: consumed from storage.
    expect(sessionStorage.getItem("mcp-environment-draft-seed")).toBe("{}");
  });

  it("waits out flag hydration: seed survives the null render and is consumed on settle", async () => {
    saveEnvironmentDraftSeed("proj_1", {
      hostId: "host_1",
      serverAttachmentId: null,
      skillSelection: null,
    });
    mockFlagValue.value = undefined;
    const { rerender, container } = render(
      <ProjectEnvironmentsRoute isAuthenticated projectId="proj_1" canManage />,
    );
    // Hydrating: route renders nothing, seed untouched.
    expect(container).toBeEmptyDOMElement();
    expect(sessionStorage.getItem("mcp-environment-draft-seed")).toContain(
      "host_1",
    );

    mockFlagValue.value = true;
    rerender(
      <ProjectEnvironmentsRoute isAuthenticated projectId="proj_1" canManage />,
    );
    await waitFor(() => expect(screen.getByTestId("editor")).toBeVisible());
    expect(screen.getByText("New environment")).toBeInTheDocument();
  });

  it("switching from a seeded form in A to a seeded form in B applies B's seed (review regression)", async () => {
    saveEnvironmentDraftSeed("proj_a", {
      name: "Client A",
      hostId: "host_a",
      serverAttachmentId: null,
      skillSelection: null,
    });
    saveEnvironmentDraftSeed("proj_b", {
      name: "Client B",
      hostId: "host_b",
      serverAttachmentId: null,
      skillSelection: null,
    });

    const { rerender } = render(
      <ProjectEnvironmentsRoute isAuthenticated projectId="proj_a" canManage />,
    );
    await waitFor(() => expect(screen.getByTestId("editor")).toBeVisible());
    expect(
      (
        mockEditorProps.mock.calls.at(-1)![0] as {
          capturedInitialDraft?: { hostId: string };
        }
      ).capturedInitialDraft?.hostId,
    ).toBe("host_a");

    // Straight from one seeded create form to another: the remount key must
    // change, or React reuses the instance and B's already-deleted seed is lost.
    rerender(
      <ProjectEnvironmentsRoute isAuthenticated projectId="proj_b" canManage />,
    );
    await waitFor(() => {
      const props = mockEditorProps.mock.calls.at(-1)![0] as {
        capturedInitialDraft?: { hostId: string };
      };
      // The value the editor actually INITIALIZED with — stale (host_a) if the
      // instance was reused instead of remounted.
      expect(props.capturedInitialDraft?.hostId).toBe("host_b");
    });
  });

  it("a whitespace-padded active project id still reads the seed (review regression)", async () => {
    // Connect writes under the TRIMMED id; the route holds the raw one.
    saveEnvironmentDraftSeed("proj_1", {
      hostId: "host_1",
      serverAttachmentId: null,
      skillSelection: null,
    });
    render(
      <ProjectEnvironmentsRoute
        isAuthenticated
        projectId="  proj_1  "
        canManage
      />,
    );
    await waitFor(() => expect(screen.getByTestId("editor")).toBeVisible());
    expect(
      (
        mockEditorProps.mock.calls.at(-1)![0] as {
          capturedInitialDraft?: { hostId: string };
        }
      ).capturedInitialDraft?.hostId,
    ).toBe("host_1");
  });

  it("no seed ⇒ lands on the list, not create mode", () => {
    render(
      <ProjectEnvironmentsRoute isAuthenticated projectId="proj_1" canManage />,
    );
    // The list ALSO renders a "New environment" button — the editor testid is
    // the unambiguous create-mode signal.
    expect(screen.queryByTestId("editor")).not.toBeInTheDocument();
  });

  it("a seed for a DIFFERENT project is not consumed", () => {
    saveEnvironmentDraftSeed("proj_other", {
      hostId: "host_1",
      serverAttachmentId: null,
      skillSelection: null,
    });
    render(
      <ProjectEnvironmentsRoute isAuthenticated projectId="proj_1" canManage />,
    );
    expect(screen.queryByTestId("editor")).not.toBeInTheDocument();
    // The other project's seed stays for its own route visit.
    expect(sessionStorage.getItem("mcp-environment-draft-seed")).toContain(
      "proj_other",
    );
  });
});
