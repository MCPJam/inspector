import { describe, expect, it, vi, afterEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { ChatboxHostOnboardingOverlays } from "../ChatboxHostOnboardingOverlays";
import type { HostedOAuthServerDescriptor } from "@/hooks/hosted/use-hosted-oauth-gate";

const FINISHING_TIMEOUT_MS = 10_000;

function server(
  id: string,
  overrides: Partial<HostedOAuthServerDescriptor> = {},
): HostedOAuthServerDescriptor {
  return {
    serverId: id,
    serverName: `Server ${id}`,
    useOAuth: true,
    serverUrl: null,
    clientId: null,
    oauthScopes: null,
    ...overrides,
  };
}

describe("ChatboxHostOnboardingOverlays", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("welcome dialog", () => {
    it("renders welcome body text when showWelcome=true and body is present", () => {
      render(
        <ChatboxHostOnboardingOverlays
          showWelcome
          onGetStarted={vi.fn()}
          welcomeBody="Welcome — thanks for trying this out."
          showAuthPanel={false}
          pendingOAuthServers={[]}
          authorizeServer={vi.fn()}
          isFinishingOAuth={false}
        />,
      );

      expect(
        screen.getByText("Welcome — thanks for trying this out."),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Get Started" }),
      ).toBeInTheDocument();
    });

    it("does not render welcome when showWelcome=true but body is empty", () => {
      render(
        <ChatboxHostOnboardingOverlays
          showWelcome
          onGetStarted={vi.fn()}
          welcomeBody=""
          showAuthPanel={false}
          pendingOAuthServers={[]}
          authorizeServer={vi.fn()}
          isFinishingOAuth={false}
        />,
      );

      expect(
        screen.queryByRole("button", { name: "Get Started" }),
      ).not.toBeInTheDocument();
    });

    it("does not render welcome when showWelcome=true but body is whitespace only", () => {
      render(
        <ChatboxHostOnboardingOverlays
          showWelcome
          onGetStarted={vi.fn()}
          welcomeBody="   "
          showAuthPanel={false}
          pendingOAuthServers={[]}
          authorizeServer={vi.fn()}
          isFinishingOAuth={false}
        />,
      );

      expect(
        screen.queryByRole("button", { name: "Get Started" }),
      ).not.toBeInTheDocument();
    });

    it("does not render welcome when showWelcome=false even with body present", () => {
      render(
        <ChatboxHostOnboardingOverlays
          showWelcome={false}
          onGetStarted={vi.fn()}
          welcomeBody="Hello"
          showAuthPanel={false}
          pendingOAuthServers={[]}
          authorizeServer={vi.fn()}
          isFinishingOAuth={false}
        />,
      );

      expect(
        screen.queryByRole("button", { name: "Get Started" }),
      ).not.toBeInTheDocument();
    });

    it("calls onGetStarted when Get Started button is clicked", () => {
      const onGetStarted = vi.fn();
      render(
        <ChatboxHostOnboardingOverlays
          showWelcome
          onGetStarted={onGetStarted}
          welcomeBody="Hello"
          showAuthPanel={false}
          pendingOAuthServers={[]}
          authorizeServer={vi.fn()}
          isFinishingOAuth={false}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Get Started" }));
      expect(onGetStarted).toHaveBeenCalledTimes(1);
    });

    it("calls onGetStarted when backdrop is clicked", () => {
      const onGetStarted = vi.fn();
      render(
        <ChatboxHostOnboardingOverlays
          showWelcome
          onGetStarted={onGetStarted}
          welcomeBody="Hello"
          showAuthPanel={false}
          pendingOAuthServers={[]}
          authorizeServer={vi.fn()}
          isFinishingOAuth={false}
        />,
      );

      fireEvent.click(screen.getByRole("dialog"));
      expect(onGetStarted).toHaveBeenCalledTimes(1);
    });

    it("does not call onGetStarted when the card itself is clicked (stopPropagation)", () => {
      const onGetStarted = vi.fn();
      render(
        <ChatboxHostOnboardingOverlays
          showWelcome
          onGetStarted={onGetStarted}
          welcomeBody="Hello"
          showAuthPanel={false}
          pendingOAuthServers={[]}
          authorizeServer={vi.fn()}
          isFinishingOAuth={false}
        />,
      );

      // Click the text node inside the card (not the backdrop, not the button)
      fireEvent.click(screen.getByText("Hello"));
      expect(onGetStarted).not.toHaveBeenCalled();
    });
  });

  describe("finishing OAuth timeout UI", () => {
    it("clears finishing timeout UI when pending OAuth servers change while still finishing", async () => {
      vi.useFakeTimers();

      const authorizeServer = vi.fn();

      const { rerender } = render(
        <ChatboxHostOnboardingOverlays
          showWelcome={false}
          onGetStarted={vi.fn()}
          showAuthPanel
          pendingOAuthServers={[
            {
              server: server("a"),
              state: {
                status: "verifying",
                errorMessage: null,
                serverUrl: null,
              },
            },
          ]}
          authorizeServer={authorizeServer}
          isFinishingOAuth
        />,
      );

      expect(screen.getByText("Finishing authorization")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Retry" }),
      ).not.toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(FINISHING_TIMEOUT_MS);
      });

      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();

      await act(async () => {
        rerender(
          <ChatboxHostOnboardingOverlays
            showWelcome={false}
            onGetStarted={vi.fn()}
            showAuthPanel
            pendingOAuthServers={[
              {
                server: server("b"),
                state: {
                  status: "verifying",
                  errorMessage: null,
                  serverUrl: null,
                },
              },
            ]}
            authorizeServer={authorizeServer}
            isFinishingOAuth
          />,
        );
      });

      expect(
        screen.queryByRole("button", { name: "Retry" }),
      ).not.toBeInTheDocument();
      expect(screen.getByText("Finishing authorization")).toBeInTheDocument();
    });
  });
});
