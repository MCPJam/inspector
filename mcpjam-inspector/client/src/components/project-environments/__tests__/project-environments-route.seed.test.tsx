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
vi.mock("../ProjectEnvironmentEditor", () => ({
  ProjectEnvironmentEditor: (props: Record<string, unknown>) => {
    mockEditorProps(props);
    return <div data-testid="editor" />;
  },
}));
vi.mock("../environment-chatbox-section", () => ({
  EnvironmentChatboxSection: () => null,
}));
vi.mock("../use-project-environment-consumers", () => ({
  useProjectEnvironmentConsumers: () => ({ consumers: [], loading: false }),
}));
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("react-router", () => ({
  Navigate: () => <div data-testid="redirect" />,
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
    render(<ProjectEnvironmentsRoute projectId="proj_1" canManage />);

    await waitFor(() => expect(screen.getByTestId("editor")).toBeVisible());
    expect(screen.getByText("New environment")).toBeInTheDocument();
    const props = mockEditorProps.mock.calls.at(-1)![0] as {
      environment: unknown;
      initialDraft?: { hostId: string | null; name?: string };
    };
    expect(props.environment).toBeNull();
    expect(props.initialDraft).toMatchObject({
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
      <ProjectEnvironmentsRoute projectId="proj_1" canManage />
    );
    // Hydrating: route renders nothing, seed untouched.
    expect(container).toBeEmptyDOMElement();
    expect(sessionStorage.getItem("mcp-environment-draft-seed")).toContain(
      "host_1"
    );

    mockFlagValue.value = true;
    rerender(<ProjectEnvironmentsRoute projectId="proj_1" canManage />);
    await waitFor(() => expect(screen.getByTestId("editor")).toBeVisible());
    expect(screen.getByText("New environment")).toBeInTheDocument();
  });

  it("no seed ⇒ lands on the list, not create mode", () => {
    render(<ProjectEnvironmentsRoute projectId="proj_1" canManage />);
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
    render(<ProjectEnvironmentsRoute projectId="proj_1" canManage />);
    expect(screen.queryByTestId("editor")).not.toBeInTheDocument();
    // The other project's seed stays for its own route visit.
    expect(sessionStorage.getItem("mcp-environment-draft-seed")).toContain(
      "proj_other"
    );
  });
});
