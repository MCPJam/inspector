import { useState } from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createMemoryRouter,
  RouterProvider,
  useLocation,
  useNavigate,
} from "react-router";
import { describe, expect, it, vi } from "vitest";
import { SettingsRail } from "../SettingsRail";
import {
  SettingsDraftProvider,
  useSettingsDraft,
} from "../SettingsDraftProvider";

const projectA = "projectaaaaaaaaa";
function Draft({ pending = false }: { pending?: boolean }) {
  const [value, setValue] = useState("");
  useSettingsDraft(!!value, () => setValue(""), pending);
  return (
    <input
      aria-label="Draft"
      value={value}
      onChange={(e) => setValue(e.target.value)}
    />
  );
}
function Harness({ pending = false }: { pending?: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <SettingsDraftProvider>
      <SettingsRail
        enabled={!location.pathname.endsWith("/sessions")}
        context={{
          organizationId: "org-a",
          projectId: projectA,
          authenticated: true,
          remoteProject: true,
        }}
        organizations={[
          { _id: "org-a", name: "Team A" },
          { _id: "org-b", name: "Team B" },
        ]}
        projects={[
          { id: projectA, name: "Project A", organizationId: "org-a" },
          {
            id: "projectbbbbbbbbb",
            name: "Project B",
            organizationId: "org-b",
          },
        ]}
        defaultHub="home"
      />
      <main id="settings-content" tabIndex={-1}>
        <Draft pending={pending} />
        <div id="setting-spend-budget">Budget content</div>
      </main>
      <button onClick={() => navigate("/settings")}>Open settings</button>
      <output aria-label="Location">
        {location.pathname + location.search}
      </output>
    </SettingsDraftProvider>
  );
}
function setup(path = "/settings", pending = false) {
  const router = createMemoryRouter(
    [{ path: "*", element: <Harness pending={pending} /> }],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}
describe("full-screen settings navigation", () => {
  it("opens Support from the app footer and marks it current", async () => {
    setup();
    const footer = screen.getByRole("navigation", { name: "App information" });
    fireEvent.click(within(footer).getByRole("button", { name: "Support" }));
    await waitFor(() => expect(screen.getByLabelText("Location")).toHaveTextContent("/settings/support"));
    expect(within(footer).getByRole("button", { name: "Support" })).toHaveAttribute("aria-current", "page");
  });
  it("keeps About in the app footer and available through search", async () => {
    setup("/settings/about");
    const footer = screen.getByRole("navigation", { name: "App information" });
    expect(
      within(footer).getByRole("button", { name: "About MCPJam" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      within(
        screen.getByRole("navigation", { name: "Settings sections" }),
      ).queryByRole("button", { name: "About MCPJam" }),
    ).not.toBeInTheDocument();
    await userEvent.type(
      screen.getByRole("combobox", { name: "Search settings" }),
      "version",
    );
    expect(
      screen.getByRole("option", { name: /About MCPJam/ }),
    ).toBeInTheDocument();
  });

  it("groups destinations and filters projects to the selected organization", () => {
    setup();
    expect(
      screen.getByRole("heading", { name: "Personal" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "AI providers" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Usage & billing" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Project B" }),
    ).not.toBeInTheDocument();
  });
  it("searches aliases with keyboard controls, preserves query state and focuses the section", async () => {
    const user = userEvent.setup();
    setup("/settings?checkout=ok");
    await waitFor(() =>
      expect(document.activeElement?.id).toBe("settings-content"),
    );
    const search = screen.getByRole("combobox", { name: "Search settings" });
    await user.type(search, "spend limit");
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() =>
      expect(screen.getByLabelText("Location")).toHaveTextContent(
        "/organizations/org-a/billing?checkout=ok&setting=spend-budget",
      ),
    );
    await waitFor(() =>
      expect(document.activeElement?.id).toBe("setting-spend-budget"),
    );
    await user.type(search, "unfindable");
    expect(screen.getByText("No settings found.")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(search).toHaveValue("");
  });
  it("Back keeps the last app location across multiple settings destinations", async () => {
    const user = userEvent.setup();
    setup(`/p/${projectA}/sessions?session=123`);
    await user.click(screen.getByRole("button", { name: "Open settings" }));
    await user.click(screen.getByRole("button", { name: "About MCPJam" }));
    await user.click(screen.getByRole("button", { name: "Back to app" }));
    expect(screen.getByLabelText("Location")).toHaveTextContent(
      `/p/${projectA}/sessions?session=123`,
    );
  });
  it("cancel preserves draft and organization; confirm discards on context change", async () => {
    setup("/organizations/org-a/models");
    fireEvent.change(screen.getByLabelText("Draft"), {
      target: { value: "edited" },
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await userEvent.click(screen.getByRole("button", { name: "Organization" }));
    await userEvent.click(
      screen.getByRole("menuitemradio", { name: /Team B/i }),
    );
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(screen.getByLabelText("Location")).toHaveTextContent(
      "/organizations/org-a/models",
    );
    expect(screen.getByLabelText("Draft")).toHaveValue("edited");
    confirm.mockReturnValue(true);
    await userEvent.click(screen.getByRole("button", { name: "Organization" }));
    await userEvent.click(
      screen.getByRole("menuitemradio", { name: /Team B/i }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Location")).toHaveTextContent(
        "/organizations/org-b/models",
      ),
    );
    expect(screen.getByLabelText("Draft")).toHaveValue("");
    confirm.mockRestore();
  });
  it("guards query-only navigation and waits for pending saves", async () => {
    const router = setup("/settings", true);
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    await router.navigate("/settings?setting=theme");
    await waitFor(() => expect(alert).toHaveBeenCalled());
    expect(screen.getByLabelText("Location").textContent).toBe("/settings");
    alert.mockRestore();
  });
  it("keeps navigation visible with Profile first and no menu toggle", async () => {
    setup();
    expect(
      screen.queryByRole("button", { name: "Open settings menu" }),
    ).not.toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(nav.querySelector("button")).toHaveTextContent("Profile");
    expect(screen.getByRole("button", { name: "Profile" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await userEvent.click(screen.getByRole("button", { name: "About MCPJam" }));
    expect(nav).toBeInTheDocument();
  });
  it("redirects legacy budgets to the spend section with checkout state intact", async () => {
    setup("/organizations/org-a/budget?checkout=ok");
    await waitFor(() =>
      expect(screen.getByLabelText("Location")).toHaveTextContent(
        "/organizations/org-a/billing?checkout=ok&setting=spend-budget",
      ),
    );
  });
});
