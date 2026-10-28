import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { HOSTED_LOCAL_ONLY_TOOLTIP } from "@/lib/hosted-ui";

let mockSidebarOpen = true;
let mockIsMobile = false;

vi.mock("@/components/ui/sidebar", () => ({
  useSidebar: () => ({ open: mockSidebarOpen, isMobile: mockIsMobile }),
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

// The card's own behavior is covered in sidebar-item-hover-card.test.tsx;
// here only what NavMain hands it matters.
vi.mock("../sidebar-item-hover-card", () => ({
  SidebarItemHoverCard: ({
    title,
    badge,
    tabId,
    onExpand,
    disabledMessage,
    labelVisible,
    children,
  }: {
    title: string;
    badge?: string;
    tabId?: string;
    onExpand?: unknown;
    disabledMessage?: string;
    labelVisible?: boolean;
    children: ReactNode;
  }) => (
    <div
      data-testid={`hover-card-${title}`}
      data-tab-id={tabId}
      data-badge={badge}
      data-has-expand={String(!!onExpand)}
      data-label-visible={String(!!labelVisible)}
    >
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
    mockIsMobile = false;
  });

  it("wraps a disabled item in its hover card with the disabled message", () => {
    const onItemClick = vi.fn();

    render(
      <NavMain
        items={[
          {
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

    expect(screen.getByTestId("hover-card-Playground")).toHaveAttribute(
      "data-tab-id",
      "playground"
    );
    expect(screen.getByTestId("disabled-message")).toHaveTextContent(
      HOSTED_LOCAL_ONLY_TOOLTIP
    );
    // No native title attribute: it would be a second tooltip.
    expect(
      screen.queryByTitle(HOSTED_LOCAL_ONLY_TOOLTIP)
    ).not.toBeInTheDocument();

    const button = screen.getByRole("button", { name: "Playground" });
    expect(button).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(button);
    expect(onItemClick).not.toHaveBeenCalled();
  });

  it("wraps every item, with or without learn-more content", () => {
    render(
      <NavMain
        items={[
          { title: "Servers", url: "#servers", icon: FakeIcon },
          { title: "Scenarios", url: "#scenarios", icon: FakeIcon },
          {
            title: "SomeDisabled",
            url: "#no-learn-more",
            icon: FakeIcon,
            disabled: true,
            disabledTooltip: "Not available",
          },
        ]}
      />
    );

    expect(screen.getByTestId("hover-card-Servers")).toBeInTheDocument();
    expect(screen.getByTestId("hover-card-Scenarios")).toBeInTheDocument();
    expect(screen.getByTestId("hover-card-SomeDisabled")).toContainElement(
      screen.getByText("Not available")
    );
  });

  it("gives the button no tooltip of its own, collapsed or expanded", () => {
    for (const open of [true, false]) {
      mockSidebarOpen = open;
      const { unmount } = render(
        <NavMain
          items={[
            { title: "Servers", url: "#servers", icon: FakeIcon },
            {
              title: "Locked",
              url: "#locked",
              icon: FakeIcon,
              disabled: true,
              disabledTooltip: "Not available",
            },
          ]}
          learnMore={{ onExpand: vi.fn() }}
        />
      );

      for (const name of ["Servers", "Locked"]) {
        expect(screen.getByRole("button", { name })).not.toHaveAttribute(
          "data-tooltip"
        );
      }
      unmount();
    }
  });

  it("tells the card the label is visible only when the rail shows it", () => {
    const items = [{ title: "Servers", url: "#servers", icon: FakeIcon }];

    mockSidebarOpen = false;
    const { rerender } = render(<NavMain items={items} />);
    expect(screen.getByTestId("hover-card-Servers")).toHaveAttribute(
      "data-label-visible",
      "false"
    );

    mockSidebarOpen = true;
    rerender(<NavMain items={[...items]} />);
    expect(screen.getByTestId("hover-card-Servers")).toHaveAttribute(
      "data-label-visible",
      "true"
    );

    // The mobile sheet shows labels whatever the desktop rail's state.
    mockSidebarOpen = false;
    mockIsMobile = true;
    rerender(<NavMain items={[...items]} />);
    expect(screen.getByTestId("hover-card-Servers")).toHaveAttribute(
      "data-label-visible",
      "true"
    );
  });

  it("passes the badge and, only with learn more on, the expand handler", () => {
    const items = [
      { title: "Swarms", url: "#swarms", icon: FakeIcon, badge: "New" },
    ];

    const { rerender } = render(<NavMain items={items} />);
    const card = screen.getByTestId("hover-card-Swarms");
    expect(card).toHaveAttribute("data-badge", "New");
    expect(card).toHaveAttribute("data-has-expand", "false");

    rerender(<NavMain items={items} learnMore={{ onExpand: vi.fn() }} />);
    expect(screen.getByTestId("hover-card-Swarms")).toHaveAttribute(
      "data-has-expand",
      "true"
    );
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
});

describe("NavMain — the active pill", () => {
  /**
   * Both halves of the pill are pinned, and for the same reason: the
   * primitive's own `data-[active=true]:*` utilities tie these on specificity,
   * so the winner would otherwise be whichever one Tailwind ordered last.
   *
   * The label matters as much as the fill. `sidebarMenuButtonVariants` sets
   * `text-sidebar-accent-foreground`, a per-preset value — the brutalist light
   * preset makes it white, and that preset's --background is white too, so the
   * active label vanished into its own pill.
   */
  it("pins the fill and the label so neither depends on preset tokens", () => {
    render(
      <NavMain
        items={[
          { title: "Home", url: "/home", icon: FakeIcon, isActive: true },
          { title: "Connect", url: "/connect", icon: FakeIcon },
        ]}
      />
    );

    const active = screen.getByRole("button", { name: "Home" });
    expect(active.className).toContain("[&[data-active=true]]:bg-background!");
    expect(active.className).toContain("[&[data-active=true]]:text-foreground!");

    // The idle sibling carries neither — it reads off the linen ground.
    const idle = screen.getByRole("button", { name: "Connect" });
    expect(idle.className).not.toContain("bg-background");
    expect(idle.className).not.toContain("text-foreground");
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
