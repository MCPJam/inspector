import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@mcpjam/design-system/tooltip";
import { AnnouncementDialog } from "@/components/announcement-popups";
import { AnnouncementQueueProvider } from "@/components/announcement-slot";
import {
  GITHUB_STAR_PROMPT_STORAGE_KEY,
  closeGitHubStarPrompt,
  requestGitHubStarPrompt,
} from "@/lib/github-star-prompt";
import { GitHubStarButton } from "../github-star-button";

const { track } = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("@/lib/analytics", () => ({ track }));

const PASSED = "Your conformance run is complete";

function renderButton(location: "header" | "settings" = "header") {
  return render(
    <TooltipProvider delayDuration={0}>
      <GitHubStarButton location={location} prompt={location === "header"} />
    </TooltipProvider>,
  );
}

function requestConformance(hasAdvice = false) {
  act(() =>
    requestGitHubStarPrompt({
      trigger: "conformance",
      reason: "completed",
      hasAdvice,
    }),
  );
}

beforeEach(() => {
  act(() => closeGitHubStarPrompt());
  localStorage.clear();
  track.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }),
  );
});

describe("GitHubStarButton prompt", () => {
  it("stays closed until a flow asks", () => {
    renderButton();
    expect(screen.queryByText(PASSED)).not.toBeInTheDocument();
  });

  it("shows once a passing run asks, and remembers it was shown", async () => {
    renderButton();
    requestConformance(true);
    expect(await screen.findByText(PASSED)).toBeInTheDocument();
    expect(localStorage.getItem(GITHUB_STAR_PROMPT_STORAGE_KEY)).toBe("asked");
    expect(track).toHaveBeenCalledWith("github_star_prompt_shown", {
      location: "header",
      trigger: "conformance",
      reason: "completed",
      has_advice: true,
    });
  });

  it("does not come back after the header unmounts and remounts", async () => {
    const { unmount } = renderButton();
    requestConformance();
    expect(await screen.findByText(PASSED)).toBeInTheDocument();
    unmount();
    renderButton();
    expect(screen.queryByText(PASSED)).not.toBeInTheDocument();
  });

  it("stays open when focus moves to another page control", async () => {
    render(
      <TooltipProvider delayDuration={0}>
        <GitHubStarButton location="header" prompt />
        <button type="button">Elsewhere</button>
      </TooltipProvider>,
    );
    requestConformance();
    expect(await screen.findByText(PASSED)).toBeInTheDocument();
    act(() => screen.getByRole("button", { name: "Elsewhere" }).focus());
    expect(screen.getByText(PASSED)).toBeInTheDocument();
  });

  it("waits while another dialog is open", async () => {
    const { rerender } = render(
      <TooltipProvider delayDuration={0}>
        <GitHubStarButton location="header" prompt />
        <div data-slot="dialog-content" data-state="open" />
      </TooltipProvider>,
    );
    requestConformance();
    expect(screen.queryByText(PASSED)).not.toBeInTheDocument();
    expect(localStorage.getItem(GITHUB_STAR_PROMPT_STORAGE_KEY)).toBeNull();
    rerender(
      <TooltipProvider delayDuration={0}>
        <GitHubStarButton location="header" prompt />
      </TooltipProvider>,
    );
    expect(await screen.findByText(PASSED)).toBeInTheDocument();
  });

  it("closes on Not now and records why", async () => {
    renderButton();
    requestConformance();
    await userEvent.click(
      await screen.findByRole("button", { name: "Not now" }),
    );
    expect(screen.queryByText(PASSED)).not.toBeInTheDocument();
    expect(track).toHaveBeenCalledWith(
      "github_star_prompt_dismissed",
      expect.objectContaining({ close_reason: "not_now" }),
    );
  });

  it("tracks a click on Star on GitHub and closes", async () => {
    renderButton();
    requestConformance();
    await userEvent.click(
      await screen.findByRole("link", { name: "Star on GitHub" }),
    );
    expect(track).toHaveBeenCalledWith(
      "github_star_prompt_clicked",
      expect.objectContaining({ cta: "primary", trigger: "conformance" }),
    );
    expect(screen.queryByText(PASSED)).not.toBeInTheDocument();
  });

  it("names the debugger on a return visit, without has_advice", async () => {
    renderButton();
    act(() =>
      requestGitHubStarPrompt({ trigger: "oauth", reason: "return_visit" }),
    );
    expect(
      await screen.findByText("Enjoying the OAuth debugger?"),
    ).toBeInTheDocument();
    expect(track).toHaveBeenCalledWith("github_star_prompt_shown", {
      location: "header",
      trigger: "oauth",
      reason: "return_visit",
    });
  });

  it("never opens from the settings button", () => {
    renderButton("settings");
    requestConformance();
    expect(screen.queryByText(PASSED)).not.toBeInTheDocument();
  });

  it("waits behind an announcement that is already open", async () => {
    function Shell({ other }: { other: boolean }) {
      return (
        <AnnouncementQueueProvider enabled>
          <AnnouncementDialog eligible={other} onDismiss={() => {}}>
            <p>Other announcement</p>
          </AnnouncementDialog>
          <TooltipProvider delayDuration={0}>
            <GitHubStarButton location="header" prompt />
          </TooltipProvider>
        </AnnouncementQueueProvider>
      );
    }
    const { rerender } = render(<Shell other />);
    requestConformance();
    expect(screen.queryByText(PASSED)).not.toBeInTheDocument();
    expect(localStorage.getItem(GITHUB_STAR_PROMPT_STORAGE_KEY)).toBeNull();
    rerender(<Shell other={false} />);
    expect(await screen.findByText(PASSED)).toBeInTheDocument();
  });
});
