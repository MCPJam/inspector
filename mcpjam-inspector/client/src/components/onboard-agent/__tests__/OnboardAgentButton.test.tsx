import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const trackMock = vi.fn();
const copyMock = vi.fn();

vi.mock("@/lib/analytics", () => ({
  track: (...args: unknown[]) => trackMock(...args),
}));
vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: (text: string) => copyMock(text),
}));

import { OnboardAgentButton } from "../OnboardAgentButton";

describe("OnboardAgentButton", () => {
  beforeEach(() => {
    trackMock.mockReset();
    copyMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the Claude, Codex and Cursor logos on the trigger", () => {
    render(<OnboardAgentButton />);
    const trigger = screen.getByRole("button", {
      name: /Onboard your agent to MCPJam/,
    });
    const logos = Array.from(trigger.querySelectorAll("img")).map((img) =>
      img.getAttribute("alt"),
    );
    expect(logos).toEqual(["Claude", "Codex", "Cursor"]);
    expect(trigger).not.toHaveClass("hidden");
  });

  it("shows the short label at 2xl and the full name in a tooltip", async () => {
    const user = userEvent.setup();
    render(<OnboardAgentButton />);
    const trigger = screen.getByRole("button", {
      name: "Onboard your agent to MCPJam",
    });
    const label = Array.from(trigger.querySelectorAll("span")).find(
      (span) => span.textContent === "Connect your agent",
    );
    expect(label).toHaveClass("hidden", "2xl:inline");

    await user.hover(trigger);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("Onboard your agent to MCPJam");
  });

  it("opens a single CLI panel with the install and sign-in commands", async () => {
    const user = userEvent.setup();
    render(<OnboardAgentButton />);
    await user.click(
      screen.getByRole("button", { name: /Onboard your agent to MCPJam/ }),
    );

    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByText("MCPJam CLI")).toBeNull();
    expect(screen.getByText("npm i -g @mcpjam/cli")).toBeInTheDocument();
    expect(screen.getByText("mcpjam cloud login")).toBeInTheDocument();
    expect(
      screen.getByText("Have your coding agent drive everything in MCPJam."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Tunnel a local server/)).toBeNull();
    expect(screen.getByRole("link", { name: /All commands/ })).toHaveAttribute(
      "href",
      "https://docs.mcpjam.com/cli/reference",
    );
    expect(trackMock).toHaveBeenCalledWith("onboard_agent_opened", {
      location: "header",
    });
  });

  it("copies a command and confirms it", async () => {
    copyMock.mockResolvedValue(true);
    const user = userEvent.setup();
    render(<OnboardAgentButton />);
    await user.click(
      screen.getByRole("button", { name: /Onboard your agent to MCPJam/ }),
    );
    await user.click(
      screen.getByRole("button", { name: "Copy npm i -g @mcpjam/cli" }),
    );

    expect(copyMock).toHaveBeenCalledWith("npm i -g @mcpjam/cli");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Copy npm i -g @mcpjam/cli" }),
      ).toHaveTextContent("Copied"),
    );
    expect(trackMock).toHaveBeenCalledWith("onboard_agent_command_copied", {
      location: "header",
      command: "install",
      copied: true,
    });
  });

  it("keeps the Copy label when the clipboard refuses", async () => {
    copyMock.mockResolvedValue(false);
    const user = userEvent.setup();
    render(<OnboardAgentButton />);
    await user.click(
      screen.getByRole("button", { name: /Onboard your agent to MCPJam/ }),
    );
    const copy = screen.getByRole("button", {
      name: "Copy mcpjam cloud login",
    });
    await user.click(copy);

    await waitFor(() =>
      expect(trackMock).toHaveBeenCalledWith("onboard_agent_command_copied", {
        location: "header",
        command: "login",
        copied: false,
      }),
    );
    expect(copy).toHaveTextContent("Copy");
  });

  it("restarts the Copied timer on a repeat copy", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    copyMock.mockResolvedValue(true);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<OnboardAgentButton />);
    await user.click(
      screen.getByRole("button", { name: /Onboard your agent to MCPJam/ }),
    );
    const copy = screen.getByRole("button", {
      name: "Copy npm i -g @mcpjam/cli",
    });
    await user.click(copy);
    await waitFor(() => expect(copy).toHaveTextContent("Copied"));
    act(() => vi.advanceTimersByTime(1000));
    await user.click(copy);
    act(() => vi.advanceTimersByTime(600));
    expect(copy).toHaveTextContent("Copied");
    act(() => vi.advanceTimersByTime(1000));
    expect(copy).toHaveTextContent("Copy");
  });
});
