import { StrictMode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformLaunchAnnouncement as Announcement } from "../platform-launch-announcement";

const { engagement } = vi.hoisted(() => ({ engagement: vi.fn() }));
vi.mock("@/lib/launch-analytics", () => ({
  trackLaunchEngagement: engagement,
}));

const onNavigate = vi.fn();
function PlatformLaunchAnnouncement(props: { sandboxesEnabled?: boolean }) {
  return <Announcement sandboxesEnabled {...props} onNavigate={onNavigate} />;
}

beforeEach(() => {
  localStorage.clear();
  onNavigate.mockClear();
  engagement.mockClear();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(
        private callback: (entries: { isIntersecting: boolean }[]) => void,
      ) {}
      observe() {
        this.callback([{ isIntersecting: true }]);
      }
      disconnect() {}
    },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PlatformLaunchAnnouncement", () => {
  it("stays non-blocking until opened, then restores focus on Escape", async () => {
    const user = userEvent.setup();
    render(<PlatformLaunchAnnouncement />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull();
    const trigger = screen.getByRole("button", {
      name: "Learn more about the new MCPJam",
    });
    await user.click(trigger);
    expect(
      screen.getByRole("dialog", { name: "Our new platform" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Our new platform" }),
    ).toHaveFocus();
    expect(document.querySelector("iframe")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Play launch video" }));
    expect(screen.getByTitle("Our new platform video")).toHaveAttribute(
      "src",
      expect.stringContaining("/embed/vD06SWzNx0Y"),
    );
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("remembers dismissal across remounts", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<PlatformLaunchAnnouncement />);
    await user.click(
      screen.getByRole("button", { name: "Dismiss launch announcement" }),
    );
    expect(
      screen.queryByRole("region", { name: "Platform launch" }),
    ).not.toBeInTheDocument();
    unmount();
    render(<PlatformLaunchAnnouncement />);
    expect(
      screen.queryByRole("button", { name: "Learn more about the new MCPJam" }),
    ).not.toBeInTheDocument();
  });

  it("records seen on open and keeps the announcement visible until explicitly dismissed", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<PlatformLaunchAnnouncement />);
    expect(
      localStorage.getItem("mcpjam:platform-launch-2026-09:status"),
    ).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Learn more about the new MCPJam" }),
    );
    expect(localStorage.getItem("mcpjam:platform-launch-2026-09:status")).toBe(
      "seen",
    );
    unmount();
    render(<PlatformLaunchAnnouncement />);
    expect(
      screen.queryByRole("region", { name: "Platform launch" }),
    ).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Learn more about the new MCPJam" }),
    );
    expect(screen.getByRole("dialog")).toBeVisible();
  });

  it("supports keyboard feature navigation and returns to work without permanent dismissal", async () => {
    const user = userEvent.setup();
    render(<PlatformLaunchAnnouncement />);
    await user.click(
      screen.getByRole("button", { name: "Learn more about the new MCPJam" }),
    );
    await user.click(screen.getByRole("tab", { name: "Swarm" }));
    for (const name of ["User Testing", "Evaluate", "CI/CD"]) {
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
      screen.getByRole("button", { name: "Learn more about the new MCPJam" }),
    ).toBeVisible();
  });

  it("shows the character graphic and four feature tiles as one clear launch trigger", () => {
    render(<PlatformLaunchAnnouncement />);
    const trigger = screen.getByRole("button", {
      name: "Learn more about the new MCPJam",
    });
    for (const label of ["Swarm", "User Testing", "Evaluate", "CI/CD"])
      expect(trigger).toHaveTextContent(label);
    expect(screen.getByTestId("swarm-hero-characters")).toBeInTheDocument();
  });

  it.each([
    [
      "Swarm",
      "Explore Swarm",
      "/swarms",
      "Swarm insights showing user goals, behavior, outcomes, and sentiment",
    ],
    [
      "User Testing",
      "Explore User Testing",
      "/user-testing",
      "User testing findings with tester feedback and root causes",
    ],
    [
      "Evaluate",
      "Explore Evaluate",
      "/evaluate",
      "Evaluate dashboard with suite health and cross-client run results",
    ],
    [
      "CI/CD",
      "Open Evaluate for CI/CD",
      "/evaluate",
      "MCPJam release checks and readiness across clients",
    ],
  ])(
    "shows a representative visual and navigates inside the app for %s",
    async (name, action, path, visual) => {
      const user = userEvent.setup();
      render(<PlatformLaunchAnnouncement />);
      await user.click(
        screen.getByRole("button", { name: "Learn more about the new MCPJam" }),
      );
      await user.click(screen.getByRole("tab", { name, exact: true }));
      expect(screen.getByRole("img", { name: visual })).toBeVisible();
      expect(screen.getByRole("img", { name: visual })).toHaveAttribute(
        "src",
        expect.stringContaining(".png"),
      );
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: action }));
      expect(onNavigate).toHaveBeenCalledWith(path);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    },
  );

  it("tracks the funnel once per action without counting rerenders as impressions", async () => {
    const user = userEvent.setup();
    const view = render(
      <StrictMode>
        <PlatformLaunchAnnouncement />
      </StrictMode>,
    );
    expect(
      engagement.mock.calls.filter(([e]) => e.action === "shown"),
    ).toHaveLength(1);
    view.rerender(
      <StrictMode>
        <PlatformLaunchAnnouncement />
      </StrictMode>,
    );
    await user.click(
      screen.getByRole("button", { name: "Learn more about the new MCPJam" }),
    );
    expect(screen.getAllByRole("tab")[0]).toHaveTextContent("Launch video");
    expect(screen.getByRole("tab", { name: "Launch video" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Play launch video" }));
    await user.click(
      screen.getByRole("tab", { name: "Evaluate", exact: true }),
    );
    expect(document.querySelector("iframe")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Explore Evaluate" }));
    expect(engagement.mock.calls.map(([e]) => e.action)).toEqual([
      "shown",
      "opened",
      "video_requested",
      "feature_selected",
      "feature_navigated",
      "closed",
    ]);
    expect(engagement).toHaveBeenLastCalledWith(
      expect.objectContaining({
        feature: "evals",
        close_reason: "navigate",
        duration_ms: expect.any(Number),
      }),
    );
  });

  it("waits for the launcher to become visible before counting an impression", () => {
    let notify!: (entries: { isIntersecting: boolean }[]) => void;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: typeof notify) {
          notify = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    render(<PlatformLaunchAnnouncement />);
    expect(engagement).not.toHaveBeenCalled();
    act(() => notify([{ isIntersecting: false }]));
    expect(engagement).not.toHaveBeenCalled();
    act(() => notify([{ isIntersecting: true }]));
    act(() => notify([{ isIntersecting: true }]));
    expect(engagement).toHaveBeenCalledTimes(1);
  });

  it("does not report an impression for an already dismissed announcement", () => {
    localStorage.setItem("mcpjam:platform-launch-2026-09:status", "dismissed");
    render(<PlatformLaunchAnnouncement />);
    expect(engagement).not.toHaveBeenCalled();
  });

  it("distinguishes closing the modal from dismissing the announcement", async () => {
    const user = userEvent.setup();
    render(<PlatformLaunchAnnouncement />);
    await user.click(
      screen.getByRole("button", { name: "Learn more about the new MCPJam" }),
    );
    await user.keyboard("{Escape}");
    await user.click(
      screen.getByRole("button", { name: "Dismiss launch announcement" }),
    );
    expect(engagement.mock.calls.map(([e]) => e.action)).toEqual([
      "shown",
      "opened",
      "closed",
      "dismissed",
    ]);
  });

  it.each(["Swarm", "User Testing"])("disables navigation to unavailable %s", async (name) => {
    const user = userEvent.setup();
    render(<PlatformLaunchAnnouncement sandboxesEnabled={false} />);
    await user.click(screen.getByRole("button", { name: "Learn more about the new MCPJam" }));
    await user.click(screen.getByRole("tab", { name, exact: true }));
    const action = screen.getByRole("button", { name: "Not available in this workspace" });
    expect(action).toBeDisabled();
    await user.click(action);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeVisible();
  });

  it("opens independently of sidebar state", async () => {
    const user = userEvent.setup();
    render(<PlatformLaunchAnnouncement />);
    await user.click(
      screen.getByRole("button", { name: "Learn more about the new MCPJam" }),
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
    render(<PlatformLaunchAnnouncement />);
    await user.click(
      screen.getByRole("button", { name: "Learn more about the new MCPJam" }),
    );
    expect(screen.getByRole("dialog")).toBeVisible();
    await user.keyboard("{Escape}");
    await user.click(
      screen.getByRole("button", { name: "Dismiss launch announcement" }),
    );
    expect(
      screen.queryByRole("button", { name: "Learn more about the new MCPJam" }),
    ).not.toBeInTheDocument();
  });
});
