import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HOSTED_LOCAL_ONLY_TOOLTIP } from "@/lib/hosted-ui";

vi.mock("@/components/ui/sidebar", () => ({
  SidebarGroup: ({ children }: any) => <div>{children}</div>,
  SidebarGroupContent: ({ children }: any) => <div>{children}</div>,
  SidebarMenu: ({ children }: any) => <div>{children}</div>,
  SidebarMenuItem: ({ children }: any) => <div>{children}</div>,
  SidebarMenuButton: ({ children, isActive, tooltip, ...props }: any) => {
    void isActive;
    void tooltip;
    return <button {...props}>{children}</button>;
  },
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: any) => <div>{children}</div>,
  TooltipTrigger: ({ children }: any) => <>{children}</>,
  TooltipContent: ({ children }: any) => <div>{children}</div>,
}));

import { NavMain } from "../nav-main";

const FakeIcon = () => null;

describe("NavMain", () => {
  it("keeps disabled items visible without allowing navigation", () => {
    const onItemClick = vi.fn();

    render(
      <NavMain
        items={[
          {
            title: "Skills",
            url: "#skills",
            icon: FakeIcon,
            disabled: true,
            disabledTooltip: HOSTED_LOCAL_ONLY_TOOLTIP,
          },
        ]}
        onItemClick={onItemClick}
      />,
    );

    expect(screen.getByTitle(HOSTED_LOCAL_ONLY_TOOLTIP)).toBeInTheDocument();
    expect(screen.getByText(HOSTED_LOCAL_ONLY_TOOLTIP)).toBeInTheDocument();

    const button = screen.getByRole("button", { name: "Skills" });
    expect(button).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(button);
    expect(onItemClick).not.toHaveBeenCalled();
  });

  it("still handles clicks for enabled items", () => {
    const onItemClick = vi.fn();

    render(
      <NavMain
        items={[
          {
            title: "Servers",
            url: "#servers",
            icon: FakeIcon,
          },
        ]}
        onItemClick={onItemClick}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Servers" }));
    expect(onItemClick).toHaveBeenCalledWith("#servers");
  });

  it("does not render a plan-upgrade lock hint for enabled billed items", () => {
    render(
      <NavMain
        items={[
          {
            title: "Sandboxes",
            url: "#sandboxes",
            icon: FakeIcon,
          },
        ]}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Sandboxes" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Plan upgrade required"),
    ).not.toBeInTheDocument();
  });
});
