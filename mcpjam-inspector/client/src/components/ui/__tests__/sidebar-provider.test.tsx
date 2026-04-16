import * as React from "react";
import { describe, it, expect, vi } from "vitest";
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

function SetOpenEffectProbe({
  onEffect,
}: {
  onEffect: () => void;
}) {
  const { setOpen } = useSidebar();

  React.useEffect(() => {
    onEffect();
  }, [onEffect, setOpen]);

  return null;
}

function FunctionalToggleButton() {
  const { setOpen } = useSidebar();

  return (
    <button type="button" onClick={() => setOpen((open) => !open)}>
      Toggle With Setter
    </button>
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

    fireEvent.click(screen.getByRole("button", { name: /toggle sidebar/i }));

    expect(screen.getByTestId("sidebar-open-probe")).toHaveTextContent(
      "closed",
    );
  });

  it("keeps setOpen stable when toggling the sidebar", () => {
    const onEffect = vi.fn();

    render(
      <SidebarProvider defaultOpen={true}>
        <OpenProbe />
        <SetOpenEffectProbe onEffect={onEffect} />
        <SidebarTrigger />
      </SidebarProvider>,
    );

    expect(onEffect).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /toggle sidebar/i }));

    expect(screen.getByTestId("sidebar-open-probe")).toHaveTextContent(
      "closed",
    );
    expect(onEffect).toHaveBeenCalledTimes(1);
  });
});

describe("SidebarProvider (controlled)", () => {
  it("resolves functional updates against the latest effective open state", () => {
    function ControlledSidebarHarness() {
      const [open, setOpen] = React.useState(true);

      return (
        <SidebarProvider open={open} onOpenChange={setOpen}>
          <OpenProbe />
          <FunctionalToggleButton />
        </SidebarProvider>
      );
    }

    render(<ControlledSidebarHarness />);

    expect(screen.getByTestId("sidebar-open-probe")).toHaveTextContent("open");

    fireEvent.click(
      screen.getByRole("button", { name: /toggle with setter/i }),
    );
    expect(screen.getByTestId("sidebar-open-probe")).toHaveTextContent(
      "closed",
    );

    fireEvent.click(
      screen.getByRole("button", { name: /toggle with setter/i }),
    );
    expect(screen.getByTestId("sidebar-open-probe")).toHaveTextContent("open");
  });
});
