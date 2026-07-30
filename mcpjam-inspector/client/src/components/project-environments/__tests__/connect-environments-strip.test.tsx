/**
 * Connect-canvas Environments strip (Project Environments — Phase 2.6).
 *
 * The two things worth pinning: the flag gate (fail-closed, like every other
 * client exposure of this feature) and the ONE action — "Open in Playground"
 * must both set the previewed environment AND navigate, because either half
 * alone lands the user on a Playground running something else.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockFlagValue,
  mockEnvironments,
  mockHosts,
  mockNavigateApp,
  mockUseHostList,
  mockPreviewedHostId,
  mockCanManage,
  mockSaveSeed,
  mockComputersEnabled,
  mockSandboxImages,
  mockMembersQueryProjectId,
} = vi.hoisted(() => ({
  mockFlagValue: { value: true as boolean | undefined },
  mockEnvironments: { value: undefined as unknown },
  mockHosts: { value: [] as Array<{ hostId: string; name: string }> },
  mockNavigateApp: vi.fn(),
  mockUseHostList: vi.fn(),
  mockPreviewedHostId: { value: null as string | null },
  mockCanManage: { value: true },
  mockSaveSeed: vi.fn(),
  mockComputersEnabled: { value: true },
  mockSandboxImages: vi.fn(),
  mockMembersQueryProjectId: vi.fn(),
}));

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => mockFlagValue.value,
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));
vi.mock("@/hooks/useProjectEnvironments", () => ({
  // Mirrors the real hook: it trims before querying, so a padded id still
  // returns rows. That asymmetry is exactly what the normalization test below
  // guards against.
  useProjectEnvironments: (projectId: string | null) =>
    projectId?.trim() ? mockEnvironments.value : undefined,
}));
vi.mock("@/hooks/useClients", () => ({
  useHostList: (args: { projectId: string | null }) => {
    mockUseHostList(args);
    return { hosts: mockHosts.value, isLoading: false };
  },
}));
vi.mock("@/lib/app-navigation", () => ({
  navigateApp: mockNavigateApp,
  routePaths: { environments: "/environments", playground: "/playground" },
}));
vi.mock("@/hooks/use-previewed-client-id", () => ({
  usePreviewedHostId: () => [mockPreviewedHostId.value, vi.fn()] as const,
}));
vi.mock("@/hooks/useProjects", () => ({
  useProjectMembers: (args: { projectId: string | null }) => {
    mockMembersQueryProjectId(args.projectId);
    return { canManageMembers: mockCanManage.value };
  },
  // Real guard: rejects ids that aren't valid Convex ids (transient/local).
  shouldQueryProjectId: (id: string | null | undefined) =>
    typeof id === "string" && /^[a-z0-9]{20,}$/i.test(id),
}));
vi.mock("@/lib/environment-draft-seed", () => ({
  saveEnvironmentDraftSeed: mockSaveSeed,
}));
vi.mock("@/hooks/useComputersEnabled", () => ({
  useComputersEnabled: () => mockComputersEnabled.value,
}));
vi.mock("@/hooks/useSandboxImages", () => ({
  useSandboxImages: (projectId: string | null) => {
    mockSandboxImages(projectId);
    return projectId
      ? [{ environmentId: "img_1", name: "Node 20" }]
      : undefined;
  },
}));

import { ConnectEnvironmentsStrip } from "../ConnectEnvironmentsStrip";

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockFlagValue.value = true;
  mockPreviewedHostId.value = null;
  mockCanManage.value = true;
  mockComputersEnabled.value = true;
  mockHosts.value = [{ hostId: "host_1", name: "Claude Code" }];
  mockEnvironments.value = [
    {
      environmentId: "env_1",
      projectId: "kd7abc123def456ghi789",
      name: "Staging",
      hostId: "host_1",
      serverAttachmentId: "grp_1",
      skillSelection: { mode: "explicit", skillIds: ["sk_a", "sk_b"] },
      pluginVersionIds: ["pv_1"],
      revision: 3,
      createdAt: 1,
      updatedAt: 1,
    },
  ];
});

describe("ConnectEnvironmentsStrip", () => {
  it("renders nothing when the feature flag is off", () => {
    mockFlagValue.value = false;
    const { container } = render(
      <ConnectEnvironmentsStrip projectId="kd7abc123def456ghi789" />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("zero environments: admins get the capture empty-state, members nothing", () => {
    mockEnvironments.value = [];
    render(<ConnectEnvironmentsStrip projectId="kd7abc123def456ghi789" />);
    expect(
      screen.getByTestId("connect-environments-strip-empty")
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("connect-environments-save-as")
    ).toBeInTheDocument();
  });

  it("zero environments + non-admin renders nothing (the old behavior)", () => {
    mockEnvironments.value = [];
    mockCanManage.value = false;
    const { container } = render(
      <ConnectEnvironmentsStrip projectId="kd7abc123def456ghi789" />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing while environments are still loading", () => {
    mockEnvironments.value = undefined;
    const { container } = render(
      <ConnectEnvironmentsStrip projectId="kd7abc123def456ghi789" />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("Save as environment seeds the previewed host + honest nulls, then navigates", () => {
    mockEnvironments.value = [];
    mockPreviewedHostId.value = "host_1";
    render(<ConnectEnvironmentsStrip projectId="kd7abc123def456ghi789" />);
    fireEvent.click(screen.getByTestId("connect-environments-save-as"));
    expect(mockSaveSeed).toHaveBeenCalledWith("kd7abc123def456ghi789", {
      hostId: "host_1",
      name: "Claude Code",
      serverAttachmentId: null,
      skillSelection: null,
    });
    expect(mockNavigateApp).toHaveBeenCalledWith("/environments");
  });

  it("Save as environment with no previewed host still seeds (hostId null, no name)", () => {
    mockEnvironments.value = [];
    render(<ConnectEnvironmentsStrip projectId="kd7abc123def456ghi789" />);
    fireEvent.click(screen.getByTestId("connect-environments-save-as"));
    expect(mockSaveSeed).toHaveBeenCalledWith("kd7abc123def456ghi789", {
      hostId: null,
      serverAttachmentId: null,
      skillSelection: null,
    });
    expect(mockNavigateApp).toHaveBeenCalledWith("/environments");
  });

  it("populated strip: header CTA present for admins, hidden for members", () => {
    render(<ConnectEnvironmentsStrip projectId="kd7abc123def456ghi789" />);
    expect(
      screen.getByTestId("connect-environments-save-as")
    ).toBeInTheDocument();
  });

  it("shows the sandbox-image name on a pinned card (single list query)", () => {
    mockEnvironments.value = [
      {
        environmentId: "env_1",
        projectId: "kd7abc123def456ghi789",
        name: "Staging",
        hostId: "host_1",
        computerEnvironmentId: "img_1",
        revision: 3,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    render(<ConnectEnvironmentsStrip projectId="kd7abc123def456ghi789" />);
    expect(
      screen.getByTestId("connect-environment-image-env_1")
    ).toHaveTextContent("Node 20");
    expect(mockSandboxImages).toHaveBeenCalledWith("kd7abc123def456ghi789");
  });

  it("falls back to a truncated raw id when the pinned image was deleted", () => {
    mockEnvironments.value = [
      {
        environmentId: "env_1",
        projectId: "kd7abc123def456ghi789",
        name: "Staging",
        hostId: "host_1",
        computerEnvironmentId: "img_gone_123456789",
        revision: 3,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    render(<ConnectEnvironmentsStrip projectId="kd7abc123def456ghi789" />);
    expect(
      screen.getByTestId("connect-environment-image-env_1")
    ).toHaveTextContent("image img_gone…");
  });

  it("unpinned card shows no image chip; computers flag off shows none and skips the query", () => {
    render(<ConnectEnvironmentsStrip projectId="kd7abc123def456ghi789" />);
    expect(
      screen.queryByTestId("connect-environment-image-env_1")
    ).not.toBeInTheDocument();

    mockComputersEnabled.value = false;
    mockSandboxImages.mockClear();
    mockEnvironments.value = [
      {
        environmentId: "env_2",
        projectId: "kd7abc123def456ghi789",
        name: "Pinned",
        hostId: "host_1",
        computerEnvironmentId: "img_1",
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    render(<ConnectEnvironmentsStrip projectId="kd7abc123def456ghi789" />);
    expect(
      screen.queryByTestId("connect-environment-image-env_2")
    ).not.toBeInTheDocument();
    expect(mockSandboxImages).toHaveBeenCalledWith(null);
  });

  it("skips the image query entirely when no loaded row is pinned (review regression)", () => {
    // Default fixture has no `computerEnvironmentId`, so the chip has nothing to
    // resolve — the project-wide list request must not fire at all.
    render(<ConnectEnvironmentsStrip projectId="kd7abc123def456ghi789" />);
    expect(mockSandboxImages).toHaveBeenCalledWith(null);

    // Empty strip: also nothing to resolve.
    mockSandboxImages.mockClear();
    mockEnvironments.value = [];
    render(<ConnectEnvironmentsStrip projectId="kd7abc123def456ghi789" />);
    expect(mockSandboxImages).toHaveBeenCalledWith(null);
  });

  it("skips the members query for a transient/non-Convex project id (review regression)", () => {
    render(<ConnectEnvironmentsStrip projectId="local" />);
    // An invalid id must not reach `projects:getProjectMembers` — it would fail
    // Convex arg validation while Connect resolves its shared project.
    expect(mockMembersQueryProjectId).toHaveBeenCalledWith(null);
  });

  it("populated strip hides the CTA for non-admins but keeps the cards", () => {
    mockCanManage.value = false;
    render(<ConnectEnvironmentsStrip projectId="kd7abc123def456ghi789" />);
    expect(
      screen.queryByTestId("connect-environments-save-as")
    ).not.toBeInTheDocument();
    expect(screen.getByText("Staging")).toBeInTheDocument();
  });

  it("shows only row-available data — never a resolved server count", () => {
    render(<ConnectEnvironmentsStrip projectId="kd7abc123def456ghi789" />);

    expect(screen.getByText("Staging")).toBeTruthy();
    // Client name comes from the hosts query Connect already runs.
    expect(screen.getByText("Claude Code")).toBeTruthy();
    // Server GROUP presence (a stored scope), pinned skill count and plugin-pin
    // count are all exact row data. A resolved server count is deliberately
    // absent: it would need one runtime resolve per row (an N+1) and would still
    // be a guess, because host and plugin contributions are live.
    const card = screen.getByTestId("connect-environment-card-env_1");
    expect(card.textContent).toContain("Server group attached");
    expect(card.textContent).toContain("2 skill pins");
    expect(card.textContent).toContain("1 plugin pin");
  });

  it("opens the selected environment in the Playground", () => {
    render(<ConnectEnvironmentsStrip projectId="kd7abc123def456ghi789" />);
    fireEvent.click(screen.getByTestId("connect-environment-open-env_1"));

    // Both halves, in this order: the Playground reads the previewed
    // environment on mount, so navigating without setting it lands on the
    // previous target.
    expect(
      JSON.parse(localStorage.getItem("mcp-previewed-environment-id") ?? "{}")
    ).toEqual({ kd7abc123def456ghi789: "env_1" });
    expect(mockNavigateApp).toHaveBeenCalledWith("/playground");
  });

  it("normalizes a padded project id for EVERY hook, not just the rows query", () => {
    // `useProjectEnvironments` trims internally, so a padded id renders cards
    // regardless. `useHostList` and the previewed-environment storage do not —
    // untrimmed they would label every card "Unknown client" and write the
    // selection under a scope the Playground never reads back.
    render(<ConnectEnvironmentsStrip projectId="  kd7abc123def456ghi789  " />);

    expect(mockUseHostList).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "kd7abc123def456ghi789" })
    );
    expect(screen.getByText("Claude Code")).toBeTruthy();

    fireEvent.click(screen.getByTestId("connect-environment-open-env_1"));
    expect(
      JSON.parse(localStorage.getItem("mcp-previewed-environment-id") ?? "{}")
    ).toEqual({ kd7abc123def456ghi789: "env_1" });
  });

  it("sends editing to /environments, not to an inline editor", () => {
    render(<ConnectEnvironmentsStrip projectId="kd7abc123def456ghi789" />);
    fireEvent.click(screen.getByTestId("connect-environments-manage"));
    expect(mockNavigateApp).toHaveBeenCalledWith("/environments");
  });
});
