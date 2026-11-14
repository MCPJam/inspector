import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { NavMain } from "../nav-main";
const sidebar = vi.hoisted(() => ({
  open: true,
  isMobile: true,
  setOpenMobile: vi.fn(),
}));
vi.mock("@/components/ui/sidebar", () => ({
  useSidebar: () => sidebar,
  SidebarGroup: ({ children }: React.PropsWithChildren) => (
    <div>{children}</div>
  ),
  SidebarGroupContent: ({ children }: React.PropsWithChildren) => (
    <div>{children}</div>
  ),
  SidebarGroupLabel: ({ children }: React.PropsWithChildren) => (
    <div>{children}</div>
  ),
  SidebarMenu: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  SidebarMenuItem: ({ children }: React.PropsWithChildren) => (
    <div>{children}</div>
  ),
  SidebarMenuButton: ({
    children,
    onClick,
    "aria-disabled": disabled,
  }: React.PropsWithChildren<{
    onClick?: () => void;
    "aria-disabled"?: boolean;
  }>) => (
    <button onClick={onClick} aria-disabled={disabled}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/learn-more/LearnMoreHoverCard", () => ({
  LearnMoreHoverCard: ({ children }: React.PropsWithChildren) => (
    <div>{children}</div>
  ),
}));
describe("mobile navigation", () => {
  beforeEach(() => {
    sidebar.isMobile = true;
    vi.clearAllMocks();
  });
  it("navigates then closes the phone menu", () => {
    const navigate = vi.fn();
    render(
      <NavMain
        items={[{ title: "Tools", url: "/tools" }]}
        onItemClick={navigate}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    expect(navigate).toHaveBeenCalledWith("/tools");
    expect(sidebar.setOpenMobile).toHaveBeenCalledWith(false);
    expect(navigate.mock.invocationCallOrder[0]).toBeLessThan(
      sidebar.setOpenMobile.mock.invocationCallOrder[0],
    );
  });
  it("keeps the desktop menu open", () => {
    sidebar.isMobile = false;
    render(
      <NavMain
        items={[{ title: "Tools", url: "/tools" }]}
        onItemClick={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    expect(sidebar.setOpenMobile).not.toHaveBeenCalled();
  });
  it("does not navigate or close for a disabled item", () => {
    const navigate = vi.fn();
    render(
      <NavMain
        items={[{ title: "Unavailable", url: "/unavailable", disabled: true }]}
        onItemClick={navigate}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Unavailable" }));
    expect(navigate).not.toHaveBeenCalled();
    expect(sidebar.setOpenMobile).not.toHaveBeenCalled();
  });
});
