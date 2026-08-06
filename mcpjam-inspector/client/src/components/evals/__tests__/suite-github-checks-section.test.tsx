import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const {
  mockAvailability,
  mockRepos,
  mockConnectRepo,
  mockListInstallationRepos,
  mockNavigate,
  mockToast,
} = vi.hoisted(() => ({
  mockAvailability: {
    value: undefined as { state: "enabled" | "disabled" } | undefined,
  },
  mockRepos: { value: undefined as any[] | undefined },
  mockConnectRepo: vi.fn(async () => ({ configId: "cfg-new" })),
  mockListInstallationRepos: vi.fn(async () => [
    { fullName: "mcpjam/inspector" },
    { fullName: "mcpjam/backend" },
  ]),
  mockNavigate: vi.fn(),
  mockToast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/hooks/useGithubChecksSettings", () => ({
  GITHUB_CHECKS_UNAVAILABLE_MESSAGE:
    "GitHub Checks settings are not currently available.",
  useGithubChecksSettings: () => ({
    availability: mockAvailability.value,
    repos: mockRepos.value,
    connectRepo: mockConnectRepo,
    listInstallationRepos: mockListInstallationRepos,
  }),
}));

vi.mock("@/lib/app-navigation", () => ({
  useAppNavigate: () => mockNavigate,
}));

vi.mock("@/lib/toast", () => ({ toast: mockToast }));

import { SuiteGithubChecksSection } from "../suite-github-checks-section";

const CONNECTED_HERE = {
  _id: "cfg-1",
  repoFullName: "mcpjam/mcp-check-fixture",
  enabled: true,
  suiteId: "suite-1",
};
const CONNECTED_ELSEWHERE = {
  _id: "cfg-2",
  repoFullName: "mcpjam/inspector",
  enabled: true,
  suiteId: "suite-OTHER",
};

function renderSection(
  opts: {
    availability?: { state: "enabled" | "disabled" } | undefined;
    repos?: any[] | undefined;
  } = {}
) {
  // Read the key's PRESENCE, not its value: a destructuring default fires on an
  // explicit `undefined` too, which would silently turn the "still loading"
  // case into "enabled" and pass a test that never ran what it claims.
  mockAvailability.value =
    "availability" in opts ? opts.availability : { state: "enabled" };
  mockRepos.value = "repos" in opts ? opts.repos : [];
  mockConnectRepo.mockClear();
  mockNavigate.mockClear();
  return render(
    <SuiteGithubChecksSection
      suiteId="suite-1"
      projectId="proj-1"
      organizationId="org-1"
    />
  );
}

describe("SuiteGithubChecksSection", () => {
  it("renders nothing when the org does not have the surface", () => {
    const { container } = renderSection({
      availability: { state: "disabled" },
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing while availability is still unknown", () => {
    const { container } = renderSection({ availability: undefined });
    expect(container).toBeEmptyDOMElement();
  });

  it("lists only the repositories running THIS suite", async () => {
    renderSection({ repos: [CONNECTED_HERE, CONNECTED_ELSEWHERE] });
    expect(
      await screen.findByTestId("suite-github-repo-mcpjam/mcp-check-fixture")
    ).toBeInTheDocument();
    // Connected to a different suite — showing it here would imply this suite
    // runs on it.
    expect(
      screen.queryByTestId("suite-github-repo-mcpjam/inspector")
    ).not.toBeInTheDocument();
  });

  it("says so when no repository runs this suite", () => {
    renderSection({ repos: [CONNECTED_ELSEWHERE] });
    expect(
      screen.getByText("No repositories run this suite yet.")
    ).toBeInTheDocument();
  });

  it("marks a paused repository rather than implying it runs", () => {
    renderSection({ repos: [{ ...CONNECTED_HERE, enabled: false }] });
    expect(screen.getByText("(paused)")).toBeInTheDocument();
  });

  it("does not offer a repository that already runs another suite", async () => {
    renderSection({ repos: [CONNECTED_ELSEWHERE] });
    await waitFor(() => expect(mockListInstallationRepos).toHaveBeenCalled());
    // `mcpjam/inspector` is taken by suite-OTHER; only `mcpjam/backend` is free.
    // Offering a taken repo would either be rejected or silently retarget it.
    const trigger = screen.getByLabelText("Repository");
    expect(trigger).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByText("No repositories available to connect.")
      ).not.toBeInTheDocument()
    );
  });

  it("links to the full management surface", () => {
    renderSection({ repos: [CONNECTED_HERE] });
    screen.getByText("Manage in Settings → Integrations").click();
    expect(mockNavigate).toHaveBeenCalledWith("/settings/integrations/github");
  });
});
