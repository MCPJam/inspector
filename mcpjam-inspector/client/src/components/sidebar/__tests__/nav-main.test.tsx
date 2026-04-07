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
  LearnMoreHoverCard: ({ tabId, children, disabledMessage }: any) => (
    <div data-testid={`learn-more-${tabId}`}>
      {disabledMessage && (
        <span data-testid="disabled-message">{disabledMessage}</span>
      )}
      {children}
    </div>
  ),
}));

import { NavMain } from "../nav-main";

const FakeIcon = () => null;

describe("NavMain", () => {
  beforeEach(() => {
    mockSidebarOpen = true;
  });

  it("shows learn-more hover card for disabled items with learn-more content", () => {
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
        learnMore={{ onExpand: vi.fn() }}
      />,
    );

    // Should show learn-more hover card with disabled message
    expect(screen.getByTestId("learn-more-skills")).toBeInTheDocument();
    expect(screen.getByTestId("disabled-message")).toHaveTextContent(
      HOSTED_LOCAL_ONLY_TOOLTIP,
    );
    // No native title attribute (double tooltip fix)
    expect(
      screen.queryByTitle(HOSTED_LOCAL_ONLY_TOOLTIP),
    ).not.toBeInTheDocument();

    const button = screen.getByRole("button", { name: "Skills" });
    expect(button).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(button);
    expect(onItemClick).not.toHaveBeenCalled();
  });

  it("shows plain tooltip for disabled items without learn-more content", () => {
    render(
      <NavMain
        items={[
          {
            title: "SomeDisabled",
            url: "#no-learn-more",
            icon: FakeIcon,
            disabled: true,
            disabledTooltip: "Not available",
          },
        ]}
        learnMore={{ onExpand: vi.fn() }}
      />,
    );

    expect(
      screen.queryByTestId("learn-more-no-learn-more"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(screen.queryByTitle("Not available")).not.toBeInTheDocument();
  });

  it("falls back to tooltip for disabled items when learnMore is not provided", () => {
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
      />,
    );

    expect(screen.queryByTestId("learn-more-skills")).not.toBeInTheDocument();
    expect(screen.getByText(HOSTED_LOCAL_ONLY_TOOLTIP)).toBeInTheDocument();
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
    expect(screen.queryByText("Plan upgrade required")).not.toBeInTheDocument();
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
