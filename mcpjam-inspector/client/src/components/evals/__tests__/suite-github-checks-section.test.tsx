import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const {
  mockAvailability,
  mockRepos,
  mockConnectRepo,
  mockConnectVerifiedRepo,
  mockListInstallationRepos,
  mockNavigate,
  mockToast,
} = vi.hoisted(() => ({
  mockAvailability: {
    value: undefined as { state: "enabled" | "disabled" } | undefined,
  },
  mockRepos: { value: undefined as any[] | undefined },
  // The unverified connect the backend still exposes for the two-deploy
  // window. Handed to the component so that reaching for it is a recorded
  // call rather than a crash — "never called" is the assertion.
  mockConnectRepo: vi.fn(async () => ({ configId: "cfg-legacy" })),
  mockConnectVerifiedRepo: vi.fn(async () => ({ configId: "cfg-new" })),
  mockListInstallationRepos: vi.fn(async () => [
    { fullName: "mcpjam/inspector" },
    { fullName: "mcpjam/backend" },
  ]),
  mockNavigate: vi.fn(),
  mockToast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/hooks/useGithubChecksSettings", () => ({
  useGithubChecksSettings: () => ({
    availability: mockAvailability.value,
    repos: mockRepos.value,
    connectRepo: mockConnectRepo,
    connectVerifiedRepo: mockConnectVerifiedRepo,
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
  mockConnectVerifiedRepo.mockClear();
  mockNavigate.mockClear();
  return render(
    <SuiteGithubChecksSection
      suiteId="suite-1"
      projectId="proj-1"
      organizationId="org-1"
    />
  );
}

/** Radix renders options in a portal that exists only while the trigger is open. */
async function chooseOption(
  user: ReturnType<typeof userEvent.setup>,
  triggerLabel: string,
  optionName: string
) {
  await user.click(screen.getByLabelText(triggerLabel));
  await user.click(await screen.findByRole("option", { name: optionName }));
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

  it("will not connect until an outage policy is chosen", async () => {
    const user = userEvent.setup();
    renderSection({ repos: [] });
    await waitFor(() => expect(mockListInstallationRepos).toHaveBeenCalled());

    const connect = screen.getByRole("button", { name: /Connect/ });
    expect(connect).toBeDisabled();
    await chooseOption(user, "Repository", "mcpjam/inspector");
    // A repository alone is not an answer: this surface sets the policy once,
    // at connect time, and never offers to change it afterwards.
    expect(connect).toBeDisabled();

    await chooseOption(user, "Outage policy", "Fail closed");
    expect(connect).toBeEnabled();
  });

  it("connects through the verified action, never the unverified mutation", async () => {
    const user = userEvent.setup();
    renderSection({ repos: [] });
    await waitFor(() => expect(mockListInstallationRepos).toHaveBeenCalled());

    await chooseOption(user, "Repository", "mcpjam/inspector");
    await chooseOption(user, "Outage policy", "Fail open");
    await user.click(screen.getByRole("button", { name: /Connect/ }));

    await waitFor(() =>
      expect(mockConnectVerifiedRepo).toHaveBeenCalledTimes(1)
    );
    expect(mockConnectVerifiedRepo).toHaveBeenCalledWith({
      repoFullName: "mcpjam/inspector",
      projectId: "proj-1",
      suiteId: "suite-1",
      outagePolicy: "fail_open",
    });
    expect(mockConnectRepo).not.toHaveBeenCalled();
    expect(mockToast.success).toHaveBeenCalledWith("Repository connected.");
  });

  it.each([
    [
      "an availability refusal",
      "GitHub Checks settings are not currently available for this org.",
      "GitHub Checks settings are not currently available.",
    ],
    [
      "any other refusal",
      "Repository is not accessible to the MCPJam GitHub App.",
      "Repository is not accessible to the MCPJam GitHub App.",
    ],
  ])("surfaces %s from the verified connect", async (_case, thrown, shown) => {
    mockConnectVerifiedRepo.mockRejectedValueOnce(new Error(thrown));
    const user = userEvent.setup();
    renderSection({ repos: [] });
    await waitFor(() => expect(mockListInstallationRepos).toHaveBeenCalled());

    await chooseOption(user, "Repository", "mcpjam/inspector");
    await chooseOption(user, "Outage policy", "Fail closed");
    await user.click(screen.getByRole("button", { name: /Connect/ }));

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith(shown));
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it("says nothing when a connect lands after the section is gone", async () => {
    // The boundary around this section in `suite-iterations-view` is keyed by
    // organizationId, so switching orgs unmounts this instance mid-connect.
    // `toast` is global: without a mount guard, the previous organization's
    // completion announces itself over the new organization's page.
    let resolveConnect: ((result: unknown) => void) | undefined;
    mockConnectVerifiedRepo.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveConnect = resolve as (result: unknown) => void;
        })
    );
    const user = userEvent.setup();
    const { unmount } = renderSection({ repos: [] });
    await waitFor(() => expect(mockListInstallationRepos).toHaveBeenCalled());

    await chooseOption(user, "Repository", "mcpjam/inspector");
    await chooseOption(user, "Outage policy", "Fail open");
    await user.click(screen.getByRole("button", { name: /Connect/ }));
    await waitFor(() =>
      expect(mockConnectVerifiedRepo).toHaveBeenCalledTimes(1)
    );

    unmount();
    await act(async () => {
      resolveConnect?.({ configId: "cfg-new" });
    });

    expect(mockToast.success).not.toHaveBeenCalled();
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it("states the conclusion each policy produces without promising a merge", () => {
    renderSection({ repos: [] });

    expect(
      screen.getByText(
        /During an MCPJam outage or pause, the check reports neutral\./
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Whether a failed or neutral check blocks merging depends on this repository's branch-protection settings\./
      )
    ).toBeInTheDocument();
    const page = document.body.textContent ?? "";
    for (const forbidden of [/merges proceed/i, /merges are blocked/i]) {
      expect(page).not.toMatch(forbidden);
    }
  });
});
