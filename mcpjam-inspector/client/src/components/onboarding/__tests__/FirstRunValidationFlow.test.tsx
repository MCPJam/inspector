import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FirstRunOnboardingOverlay } from "../FirstRunOnboardingOverlay";
import { copyToClipboard } from "@/lib/clipboard";

vi.mock("@/lib/clipboard", () => ({ copyToClipboard: vi.fn() }));
vi.mock("@/lib/first-run-onboarding-analytics", () => ({
  trackFirstRunConnectionFailed: vi.fn(),
  trackFirstRunOnboardingEntered: vi.fn(),
  trackFirstRunOnboardingScreenViewed: vi.fn(),
  trackFirstRunSetupLater: vi.fn(),
}));
import { trackFirstRunConnectionFailed } from "@/lib/first-run-onboarding-analytics";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it.each(["failed", "authorization-required"] as const)(
  "renders typed guidance in %s without Copy retrying the connection",
  async (status) => {
    const connect = vi.fn();
    const authorize = vi.fn();
    vi.mocked(copyToClipboard).mockResolvedValue(true);
    render(
      <FirstRunOnboardingOverlay
        open
        skipWelcome
        connectionState={{
          status,
          serverName: "Example",
          serverKind: "personal",
          error: "Updated guidance",
          validationKind: "hosted-stdio",
        }}
        recoveryServerDraft={{
          name: "Example",
          transport: "stdio",
          urlOrCommand: "npx server-example",
          authentication: "none",
        }}
        onConnectOwnServer={connect}
        onAuthorizeConnection={authorize}
        onConnectDemo={vi.fn()}
        onCancelConnection={vi.fn()}
        onReturnToChoice={vi.fn()}
        onOpenPlayground={vi.fn()}
        onWelcomeShown={vi.fn()}
        onSkip={vi.fn()}
      />,
    );
    await screen.findByRole("button", { name: "Copy MCPJam command" });
    expect(screen.getByRole("alert")).toHaveTextContent("Updated guidance");
    fireEvent.click(
      screen.getByRole("button", { name: "Copy MCPJam command" }),
    );
    await waitFor(() =>
      expect(copyToClipboard).toHaveBeenCalledWith(
        "npx @mcpjam/inspector@latest",
      ),
    );
    expect(connect).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(trackFirstRunConnectionFailed).not.toHaveBeenCalled();
  },
);
