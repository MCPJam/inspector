import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }));

vi.mock("@/lib/app-navigation", () => ({
  useAppNavigate: () => mockNavigate,
  buildOrganizationPath: (id: string) => `/organizations/${id}`,
}));

import { SettingsNav } from "../SettingsNav";

function renderNav(props: Parameters<typeof SettingsNav>[0]) {
  mockNavigate.mockClear();
  return render(
    <MemoryRouter>
      <SettingsNav {...props} />
    </MemoryRouter>
  );
}

describe("SettingsNav", () => {
  it("renders the always-present tabs", () => {
    renderNav({ active: "general" });
    expect(screen.getByText("General")).toBeInTheDocument();
    expect(screen.getByText("API Keys")).toBeInTheDocument();
    expect(screen.getByText("Integrations")).toBeInTheDocument();
  });

  /**
   * The regression this pins: Integrations used to be a GitHub Checks tab
   * gated on a backend availability query. Slack is an integration every org
   * has, so gating the tab on GitHub's beta would hide Slack from everyone
   * outside it. The page decides which CARDS it can show; the nav does not ask.
   */
  it("shows Integrations without asking the backend anything", () => {
    // `@/hooks/useGithubChecksSettings` is deliberately NOT mocked in this
    // file. If the nav still called it, this render would blow up on the
    // unmocked Convex hook instead of passing.
    renderNav({ active: "general" });
    expect(screen.getByText("Integrations")).toBeInTheDocument();
  });

  it("navigates to the Integrations page", () => {
    renderNav({ active: "general" });
    screen.getByText("Integrations").click();
    expect(mockNavigate).toHaveBeenCalledWith("/settings/integrations");
  });

  it("marks Integrations current when it is the active section", () => {
    renderNav({ active: "integrations" });
    expect(screen.getByText("Integrations")).toHaveAttribute(
      "aria-current",
      "page"
    );
  });

  it("does not navigate when the active tab is clicked", () => {
    renderNav({ active: "integrations" });
    screen.getByText("Integrations").click();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("omits the Organization tab without an active org", () => {
    renderNav({ active: "general" });
    expect(screen.queryByText("Organization")).not.toBeInTheDocument();
  });

  it("shows the Organization tab when there is an active org", () => {
    renderNav({ active: "general", activeOrganizationId: "org-1" });
    expect(screen.getByText("Organization")).toBeInTheDocument();
  });
});
