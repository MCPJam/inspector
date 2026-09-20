import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformLaunchAnnouncement } from "../platform-launch-announcement";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("PlatformLaunchAnnouncement", () => {
  it("stays non-blocking until opened, then restores focus on Escape", async () => {
    const user = userEvent.setup();
    render(<PlatformLaunchAnnouncement userId="one" />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull();
    const trigger = screen.getByRole("button", { name: "See what’s new" });
    await user.click(trigger);
    expect(
      screen.getByRole("dialog", { name: "Meet the new MCPJam" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Meet the new MCPJam" }),
    ).toHaveFocus();
    expect(document.querySelector("iframe")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Play launch video" }));
    expect(screen.getByTitle("Meet the new MCPJam video")).toHaveAttribute(
      "src",
      expect.stringContaining("/embed/vD06SWzNx0Y"),
    );
    expect(
      screen.getByRole("link", { name: "Explore the launch" }),
    ).toHaveAttribute("href", "https://www.mcpjam.com/blog/our-new-platform");
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("remembers dismissal across remounts without dismissing another account", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<PlatformLaunchAnnouncement userId="one" />);
    await user.click(
      screen.getByRole("button", { name: "Dismiss launch announcement" }),
    );
    expect(
      screen.queryByRole("region", { name: "Platform launch" }),
    ).not.toBeInTheDocument();
    unmount();
    const next = render(<PlatformLaunchAnnouncement userId="one" />);
    expect(
      screen.queryByRole("button", { name: "See what’s new" }),
    ).not.toBeInTheDocument();
    next.unmount();
    render(<PlatformLaunchAnnouncement userId="two" />);
    expect(
      screen.getByRole("button", { name: "See what’s new" }),
    ).toBeInTheDocument();
  });

  it("supports keyboard feature navigation and returns to work without permanent dismissal", async () => {
    const user = userEvent.setup();
    render(<PlatformLaunchAnnouncement userId="one" />);
    await user.click(screen.getByRole("button", { name: "See what’s new" }));
    await user.click(screen.getByRole("tab", { name: "Swarms" }));
    for (const name of ["User Testing", "Evals", "CI/CD"]) {
      await user.keyboard("{ArrowRight}");
      expect(screen.getByRole("tab", { name })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(screen.getByRole("tabpanel", { name })).toBeVisible();
    }
    await user.click(screen.getByRole("button", { name: "Back to work" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "See what’s new" }),
    ).toBeVisible();
  });

  it("opens from the collapsed sidebar", async () => {
    const user = userEvent.setup();
    render(<PlatformLaunchAnnouncement userId="one" collapsed />);
    await user.click(
      screen.getByRole("button", { name: "Discover the new MCPJam" }),
    );
    expect(screen.getByRole("dialog")).toBeVisible();
  });

  it("still opens and dismisses when storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Blocked");
    });
    const user = userEvent.setup();
    render(<PlatformLaunchAnnouncement userId="one" />);
    await user.click(screen.getByRole("button", { name: "See what’s new" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    await user.keyboard("{Escape}");
    await user.click(
      screen.getByRole("button", { name: "Dismiss launch announcement" }),
    );
    expect(
      screen.queryByRole("button", { name: "See what’s new" }),
    ).not.toBeInTheDocument();
  });
});
