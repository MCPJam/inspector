import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

const { mockNavigate, mockAvailability } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockAvailability: {
    value: undefined as { state: "enabled" | "disabled" } | undefined,
  },
}));

vi.mock("@/lib/app-navigation", () => ({
  useAppNavigate: () => mockNavigate,
  buildOrganizationPath: (id: string) => `/organizations/${id}`,
}));

// The nav asks the backend itself so every settings page agrees; the answer is
// stubbed here.
vi.mock("@/hooks/useGithubChecksSettings", () => ({
  useGithubChecksAvailability: () => mockAvailability.value,
}));

import { SettingsNav } from "../SettingsNav";

function renderNav(
  props: Parameters<typeof SettingsNav>[0],
  availability?: { state: "enabled" | "disabled" }
) {
  mockAvailability.value = availability;
  return render(
    <MemoryRouter>
      <SettingsNav {...props} />
    </MemoryRouter>
  );
}

describe("SettingsNav — GitHub Checks tab", () => {
  it("omits the tab while availability is still unknown", () => {
    renderNav({ active: "general" }, undefined);
    // Omitted, not disabled: a disabled tab advertises a surface the viewer
    // cannot reach, which is the thing a gate is meant to avoid.
    expect(screen.queryByText("GitHub Checks")).not.toBeInTheDocument();
  });

  it("omits the tab when the backend says disabled", () => {
    renderNav({ active: "general" }, { state: "disabled" });
    expect(screen.queryByText("GitHub Checks")).not.toBeInTheDocument();
  });

  it("shows the tab when available", () => {
    renderNav({ active: "general" }, { state: "enabled" });
    expect(screen.getByText("GitHub Checks")).toBeInTheDocument();
  });

  it("shows the tab from OTHER settings pages, not just its own", () => {
    // The reachability property: the nav resolves availability itself, so a
    // page that never heard of GitHub Checks still offers the way in. A prop
    // threaded per-caller would silently drop the tab here.
    renderNav({ active: "api-keys" }, { state: "enabled" });
    expect(screen.getByText("GitHub Checks")).toBeInTheDocument();
  });

  it("keeps the always-present tabs regardless of availability", () => {
    renderNav({ active: "general" }, undefined);
    expect(screen.getByText("General")).toBeInTheDocument();
    expect(screen.getByText("API Keys")).toBeInTheDocument();
  });

  it("marks the GitHub Checks tab current when it is the active section", () => {
    renderNav({ active: "github-checks" }, { state: "enabled" });
    expect(screen.getByText("GitHub Checks")).toHaveAttribute(
      "aria-current",
      "page"
    );
  });
});
