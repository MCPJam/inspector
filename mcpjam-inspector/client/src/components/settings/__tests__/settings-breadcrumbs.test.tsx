import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsPageShell } from "../SettingsPageShell";
import { settingsBreadcrumbs } from "../SettingsBreadcrumbs";
const state = vi.hoisted(() => ({
  location: { pathname: "/settings/about", search: "", hash: "" },
  navigate: vi.fn(),
}));
vi.mock("@/lib/app-navigation", () => ({
  useCurrentLocationParts: () => state.location,
  useAppNavigate: () => state.navigate,
}));
describe("Settings breadcrumbs", () => {
  it("links BYOK usage back to provider settings", () => {
    expect(settingsBreadcrumbs("/organizations/org-a/models/usage")).toEqual([
      { label: "AI providers", icon: "org-byok", href: "/organizations/org-a/models" },
      { label: "Usage" },
    ]);
  });
  it("shows a page icon and retains its content heading without duplicating nested frames", () => {
    render(
      <SettingsPageShell>
        <SettingsPageShell>
          <h1>About</h1>
        </SettingsPageShell>
      </SettingsPageShell>,
    );
    const breadcrumb = screen.getByRole("navigation", {
      name: "Settings breadcrumb",
    });
    expect(within(breadcrumb).getByText("About MCPJam")).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(breadcrumb.querySelector("svg")).not.toBeNull();
    expect(screen.getAllByRole("navigation")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "About" })).toBeInTheDocument();
  });
  it("navigates to the parent through both the breadcrumb and Back link", () => {
    state.location = {
      pathname: "/settings/integrations/github",
      search: "?orgId=org&setting=github",
      hash: "",
    };
    render(
      <SettingsPageShell>
        <h1>GitHub Checks</h1>
      </SettingsPageShell>,
    );
    const parent = screen.getByRole("link", { name: "Integrations" });
    expect(parent).toHaveAttribute("href", "/settings/integrations?orgId=org");
    fireEvent.click(parent);
    expect(state.navigate).toHaveBeenLastCalledWith(
      "/settings/integrations?orgId=org",
    );
    fireEvent.click(screen.getByRole("link", { name: "Back to Integrations" }));
    expect(state.navigate).toHaveBeenLastCalledWith(
      "/settings/integrations?orgId=org",
    );
  });
  it("uses the immediate parent for deeper installation pages", () => {
    expect(
      settingsBreadcrumbs("/settings/integrations/github/callback"),
    ).toEqual([
      {
        label: "Integrations",
        icon: "org-integrations",
        href: "/settings/integrations",
      },
      { label: "GitHub Checks", href: "/settings/integrations/github" },
      { label: "Installation" },
    ]);
  });
  it("keeps organization parents scoped and query targets at the page level", () => {
    expect(settingsBreadcrumbs("/organizations/org/slack")[0].href).toBe(
      "/organizations/org/integrations",
    );
    expect(
      settingsBreadcrumbs(
        "/organizations/org/billing",
        "?setting=spend-budget",
      ),
    ).toEqual([{ label: "Usage & billing", icon: "org-billing" }]);
    expect(settingsBreadcrumbs("/settings")[0].label).toBe("Profile");
    expect(settingsBreadcrumbs("/not-settings")).toEqual([]);
  });
});
