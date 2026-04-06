import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";

function OpenProbe() {
  const { open } = useSidebar();
  return (
    <span data-testid="sidebar-open-probe">{open ? "open" : "closed"}</span>
  );
}

describe("SidebarProvider (uncontrolled)", () => {
  it("applies a single toggle when the trigger is clicked once", () => {
    render(
      <SidebarProvider defaultOpen={true}>
        <OpenProbe />
        <SidebarTrigger />
      </SidebarProvider>,
    );

    expect(screen.getByTestId("sidebar-open-probe")).toHaveTextContent("open");

    fireEvent.click(
      screen.getByRole("button", { name: /toggle sidebar/i }),
    );

    expect(screen.getByTestId("sidebar-open-probe")).toHaveTextContent(
      "closed",
    );
  });
});
