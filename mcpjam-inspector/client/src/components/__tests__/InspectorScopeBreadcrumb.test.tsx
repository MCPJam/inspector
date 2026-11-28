import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { InspectorScopeBreadcrumb } from "../InspectorScopeBreadcrumb";

describe("InspectorScopeBreadcrumb", () => {
  it("shows project, current page and target in order and switches projects", async () => {
    const user = userEvent.setup();
    const onSwitchProject = vi.fn();
    render(
      <InspectorScopeBreadcrumb
        page="events"
        activeProjectId="demo"
        projects={[
          { id: "demo", name: "Demo" },
          { id: "sandbox", name: "Sandbox" },
        ]}
        onSwitchProject={onSwitchProject}
        serverPicker={<button type="button">stateless</button>}
      />,
    );

    const breadcrumb = within(screen.getByRole("navigation", { name: "Inspector context" }));
    expect(breadcrumb.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Demo",
      "Events",
      "stateless",
    ]);
    expect(breadcrumb.getByText("Events")).toHaveAttribute("aria-current", "page");

    await user.click(breadcrumb.getByRole("button", { name: "Switch project: Demo" }));
    expect(screen.getByRole("menuitemradio", { name: "Demo" })).toBeChecked();
    await user.click(screen.getByRole("menuitemradio", { name: "Sandbox" }));
    expect(onSwitchProject).toHaveBeenCalledWith("sandbox");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
