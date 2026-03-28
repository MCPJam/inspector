import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HOSTED_LOCAL_ONLY_TOOLTIP } from "@/lib/hosted-ui";

let mockSidebarOpen = true;

vi.mock("@/components/ui/sidebar", () => ({
  useSidebar: () => ({ open: mockSidebarOpen }),
  SidebarGroup: ({ children }: any) => <div>{children}</div>,
  SidebarGroupContent: ({ children }: any) => <div>{children}</div>,
  SidebarMenu: ({ children }: any) => <div>{children}</div>,
  SidebarMenuItem: ({ children }: any) => <div>{children}</div>,
  SidebarMenuButton: ({ children, isActive, tooltip, ...props }: any) => {
    void isActive;
    return (
      <button data-tooltip={tooltip} {...props}>
        {children}
      </button>
    );
  },
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: any) => <div>{children}</div>,
  TooltipTrigger: ({ children }: any) => <>{children}</>,
  TooltipContent: ({ children }: any) => <div>{children}</div>,
}));

vi.mock("@/components/learn-more/LearnMoreHoverCard", () => ({
  LearnMoreHoverCard: ({ tabId, children }: any) => (
    <div data-testid={`learn-more-${tabId}`}>{children}</div>
  ),
}));

import { NavMain } from "../nav-main";

const FakeIcon = () => null;

describe("NavMain", () => {
  beforeEach(() => {
    mockSidebarOpen = true;
  });

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

  it("only wraps tabs that have preview videos", () => {
    render(
      <NavMain
        items={[
          {
            title: "Servers",
            url: "#servers",
            icon: FakeIcon,
          },
          {
            title: "Chat",
            url: "#chat-v2",
            icon: FakeIcon,
          },
        ]}
        learnMore={{ onExpand: vi.fn() }}
      />,
    );

    expect(screen.getByTestId("learn-more-servers")).toBeInTheDocument();
    expect(screen.queryByTestId("learn-more-chat-v2")).not.toBeInTheDocument();
  });

  it("suppresses the built-in collapsed tooltip when learn more is handling it", () => {
    mockSidebarOpen = false;

    render(
      <NavMain
        items={[
          {
            title: "Servers",
            url: "#servers",
            icon: FakeIcon,
          },
        ]}
        learnMore={{ onExpand: vi.fn() }}
      />,
    );

    expect(screen.getByRole("button", { name: "Servers" })).not.toHaveAttribute(
      "data-tooltip",
    );
    expect(screen.getByTestId("learn-more-servers")).toBeInTheDocument();
  });
});
