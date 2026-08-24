import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HOSTED_LOCAL_ONLY_TOOLTIP } from "@/lib/hosted-ui";

let mockSidebarOpen = true;

vi.mock("@/components/ui/sidebar", () => ({
  useSidebar: () => ({ open: mockSidebarOpen }),
  SidebarGroup: ({ children }: any) => <div>{children}</div>,
  SidebarGroupContent: ({ children }: any) => <div>{children}</div>,
  // Forwards className: what NavMain passes IS the thing under test.
  SidebarGroupLabel: ({ children, className }: any) => (
    <div data-slot="sidebar-group-label" className={className}>
      {children}
    </div>
  ),
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

vi.mock("@mcpjam/design-system/tooltip", () => ({
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
            // Any nav item whose url maps to a learn-more entry with a preview
            // video works here; Playground is one (Skills used to be, before it
            // moved out of the sidebar into the Servers tab switcher).
            title: "Playground",
            url: "#playground",
            icon: FakeIcon,
            disabled: true,
            disabledTooltip: HOSTED_LOCAL_ONLY_TOOLTIP,
          },
        ]}
        onItemClick={onItemClick}
        learnMore={{ onExpand: vi.fn() }}
      />
    );

    // Should show learn-more hover card with disabled message
    expect(screen.getByTestId("learn-more-playground")).toBeInTheDocument();
    expect(screen.getByTestId("disabled-message")).toHaveTextContent(
      HOSTED_LOCAL_ONLY_TOOLTIP
    );
    // No native title attribute (double tooltip fix)
    expect(
      screen.queryByTitle(HOSTED_LOCAL_ONLY_TOOLTIP)
    ).not.toBeInTheDocument();

    const button = screen.getByRole("button", { name: "Playground" });
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
      />
    );

    expect(
      screen.queryByTestId("learn-more-no-learn-more")
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
      />
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
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Servers" }));
    expect(onItemClick).toHaveBeenCalledWith("#servers");
  });

  it("does not render a plan-upgrade lock hint for enabled billed items", () => {
    render(
      <NavMain
        items={[
          {
            title: "Scenarios",
            url: "#scenarios",
            icon: FakeIcon,
          },
        ]}
      />
    );

    expect(
      screen.getByRole("button", { name: "Scenarios" })
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
            title: "Scenarios",
            url: "#scenarios",
            icon: FakeIcon,
          },
        ]}
        learnMore={{ onExpand: vi.fn() }}
      />
    );

    expect(screen.getByTestId("learn-more-servers")).toBeInTheDocument();
    expect(
      screen.queryByTestId("learn-more-scenarios")
    ).not.toBeInTheDocument();
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
      />
    );

    expect(screen.getByRole("button", { name: "Servers" })).not.toHaveAttribute(
      "data-tooltip"
    );
    expect(screen.getByTestId("learn-more-servers")).toBeInTheDocument();
  });
});

describe("NavMain — section heading inset", () => {
  const ITEMS = [{ title: "Home", url: "/home", icon: FakeIcon }];

  /**
   * jsdom has no layout, so the class NavMain passes is the only observable.
   * The measured intent: `px-0` cancels the primitive's own px-2 so the heading
   * text sits at the group's 8px inset while its rows start at 16px. Sharing
   * 16px with the row icons aligned the two exactly and left nothing to read
   * the grouping by — reported twice as looking off.
   */
  it("cancels the primitive's px-2 so the heading sits left of its rows", () => {
    render(<NavMain label="Explore" items={ITEMS} />);

    const label = document.querySelector(
      '[data-slot="sidebar-group-label"]'
    ) as HTMLElement;
    expect(label).toBeTruthy();
    expect(label.textContent).toBe("Explore");
    expect(label.className).toContain("px-0");
  });

  it("renders no heading at all for a section with no label", () => {
    render(<NavMain items={ITEMS} />);

    expect(
      document.querySelector('[data-slot="sidebar-group-label"]')
    ).toBeNull();
    expect(screen.getByText("Home")).toBeVisible();
  });
});
