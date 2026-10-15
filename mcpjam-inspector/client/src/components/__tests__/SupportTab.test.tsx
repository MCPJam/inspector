import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SupportTab } from "../SupportTab";

const { isMemberMock, signInMock } = vi.hoisted(() => ({
  isMemberMock: vi.fn<() => boolean | undefined>(),
  signInMock: vi.fn(),
}));

vi.mock("@/hooks/use-is-member-actor", () => ({
  useIsMemberActor: () => isMemberMock(),
}));
vi.mock("@/hooks/useSendPlatformFeedback", () => ({
  useSendPlatformFeedback: () => vi.fn(),
}));
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ signIn: signInMock }),
}));

function feedbackRow() {
  return within(screen.getByTestId("support-send-feedback"));
}

describe("Support settings", () => {
  beforeEach(() => {
    isMemberMock.mockReset();
    signInMock.mockReset();
    isMemberMock.mockReturnValue(true);
  });

  it("provides help destinations within the settings content frame", () => {
    render(<SupportTab />);
    expect(
      screen.getByRole("heading", { name: "Support", level: 1 }),
    ).toBeInTheDocument();
    expect(document.getElementById("settings-content")).toBeInTheDocument();
    for (const [name, href] of [
      ["Join Discord", "https://discord.gg/JEnDtz8X6z"],
      ["Open Docs", "https://docs.mcpjam.com/"],
      ["Open Issue", "https://github.com/MCPJam/inspector/issues/new"],
    ]) {
      const link = screen.getByRole("link", {
        name: (accessibleName) =>
          accessibleName.replace(/\s*\(opens in a new tab\)$/, "") === name,
      });
      expect(link).toHaveAttribute("href", href);
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
    expect(
      screen.getByRole("link", { name: "founders@mcpjam.com" }),
    ).toHaveAttribute("href", "mailto:founders@mcpjam.com");
  });

  it("lets a signed-in member open the Send feedback form", () => {
    render(<SupportTab />);
    fireEvent.click(
      feedbackRow().getByRole("button", { name: "Send feedback" }),
    );
    expect(screen.getByTestId("send-feedback-dialog")).toBeInTheDocument();
  });

  it("asks a guest to sign in instead", () => {
    isMemberMock.mockReturnValue(false);
    render(<SupportTab />);
    expect(
      feedbackRow().queryByRole("button", { name: "Send feedback" }),
    ).toBeNull();
    fireEvent.click(feedbackRow().getByRole("button", { name: "Sign in" }));
    expect(signInMock).toHaveBeenCalledTimes(1);
  });

  it("waits while the identity is still settling", () => {
    isMemberMock.mockReturnValue(undefined);
    render(<SupportTab />);
    expect(
      feedbackRow().getByRole("button", { name: "Send feedback" }),
    ).toBeDisabled();
  });
});
