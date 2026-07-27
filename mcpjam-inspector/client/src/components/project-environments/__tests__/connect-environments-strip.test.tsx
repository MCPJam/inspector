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
} = vi.hoisted(() => ({
  mockFlagValue: { value: true as boolean | undefined },
  mockEnvironments: { value: undefined as unknown },
  mockHosts: { value: [] as Array<{ hostId: string; name: string }> },
  mockNavigateApp: vi.fn(),
  mockUseHostList: vi.fn(),
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

import { ConnectEnvironmentsStrip } from "../ConnectEnvironmentsStrip";

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockFlagValue.value = true;
  mockHosts.value = [{ hostId: "host_1", name: "Claude Code" }];
  mockEnvironments.value = [
    {
      environmentId: "env_1",
      projectId: "proj_1",
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
      <ConnectEnvironmentsStrip projectId="proj_1" />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the project has no environments", () => {
    mockEnvironments.value = [];
    const { container } = render(
      <ConnectEnvironmentsStrip projectId="proj_1" />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows only row-available data — never a resolved server count", () => {
    render(<ConnectEnvironmentsStrip projectId="proj_1" />);

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
    render(<ConnectEnvironmentsStrip projectId="proj_1" />);
    fireEvent.click(screen.getByTestId("connect-environment-open-env_1"));

    // Both halves, in this order: the Playground reads the previewed
    // environment on mount, so navigating without setting it lands on the
    // previous target.
    expect(
      JSON.parse(localStorage.getItem("mcp-previewed-environment-id") ?? "{}")
    ).toEqual({ proj_1: "env_1" });
    expect(mockNavigateApp).toHaveBeenCalledWith("/playground");
  });

  it("normalizes a padded project id for EVERY hook, not just the rows query", () => {
    // `useProjectEnvironments` trims internally, so a padded id renders cards
    // regardless. `useHostList` and the previewed-environment storage do not —
    // untrimmed they would label every card "Unknown client" and write the
    // selection under a scope the Playground never reads back.
    render(<ConnectEnvironmentsStrip projectId="  proj_1  " />);

    expect(mockUseHostList).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj_1" })
    );
    expect(screen.getByText("Claude Code")).toBeTruthy();

    fireEvent.click(screen.getByTestId("connect-environment-open-env_1"));
    expect(
      JSON.parse(localStorage.getItem("mcp-previewed-environment-id") ?? "{}")
    ).toEqual({ proj_1: "env_1" });
  });

  it("sends editing to /environments, not to an inline editor", () => {
    render(<ConnectEnvironmentsStrip projectId="proj_1" />);
    fireEvent.click(screen.getByTestId("connect-environments-manage"));
    expect(mockNavigateApp).toHaveBeenCalledWith("/environments");
  });
});
