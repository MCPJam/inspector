import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

const mockNavigate = vi.fn();

vi.mock("@/lib/app-navigation", () => ({
  useAppNavigate: () => mockNavigate,
  buildOrganizationPath: (id: string) => `/organizations/${id}`,
}));

import { SettingsNav } from "../SettingsNav";

function renderNav(props: Parameters<typeof SettingsNav>[0]) {
  return render(
    <MemoryRouter>
      <SettingsNav {...props} />
    </MemoryRouter>
  );
}

describe("SettingsNav — GitHub Checks tab", () => {
  it("omits the tab when the backend has not said it is available", () => {
    renderNav({ active: "general" });
    // Omitted, not disabled: a disabled tab advertises a surface the viewer
    // cannot reach, which is the thing a flag gate is meant to avoid.
    expect(screen.queryByText("GitHub Checks")).not.toBeInTheDocument();
  });

  it("omits the tab when availability is explicitly false", () => {
    renderNav({ active: "general", githubChecksAvailable: false });
    expect(screen.queryByText("GitHub Checks")).not.toBeInTheDocument();
  });

  it("shows the tab when available", () => {
    renderNav({ active: "general", githubChecksAvailable: true });
    expect(screen.getByText("GitHub Checks")).toBeInTheDocument();
  });

  it("keeps the always-present tabs regardless of availability", () => {
    renderNav({ active: "general" });
    expect(screen.getByText("General")).toBeInTheDocument();
    expect(screen.getByText("API Keys")).toBeInTheDocument();
  });

  it("marks the GitHub Checks tab current when it is the active section", () => {
    renderNav({ active: "github-checks", githubChecksAvailable: true });
    expect(screen.getByText("GitHub Checks")).toHaveAttribute(
      "aria-current",
      "page"
    );
  });
});
