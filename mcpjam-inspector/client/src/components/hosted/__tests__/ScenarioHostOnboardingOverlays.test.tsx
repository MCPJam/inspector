import { describe, expect, it, vi, afterEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { ScenarioHostOnboardingOverlays } from "../ScenarioHostOnboardingOverlays";
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

function renderOverlays(
  props: Partial<
    React.ComponentProps<typeof ScenarioHostOnboardingOverlays>
  > = {},
) {
  return render(
    <ScenarioHostOnboardingOverlays
      showConsent={false}
      hasTasks={false}
      onAcceptConsent={vi.fn()}
      onDeclineConsent={vi.fn()}
      showAuthPanel={false}
      pendingOAuthServers={[]}
      authorizeServer={vi.fn()}
      isFinishingOAuth={false}
      {...props}
    />,
  );
}

describe("ScenarioHostOnboardingOverlays", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("recording consent dialog", () => {
    it("states that the session is recorded, with both answers offered", () => {
      renderOverlays({ showConsent: true });

      expect(
        screen.getByText("This session will be recorded"),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/team conducting the study will be able to read it/i),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Continue" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Leave" })).toBeInTheDocument();
    });

    it("renders nothing when consent is not being asked", () => {
      renderOverlays({ showConsent: false });

      expect(
        screen.queryByText("This session will be recorded"),
      ).not.toBeInTheDocument();
    });

    it("points at the task control only when the study has tasks", () => {
      // Naming a header button that is not rendered sends the tester looking
      // for a control that does not exist.
      const withoutTasks = renderOverlays({ showConsent: true });
      expect(screen.queryByText(/top right/i)).not.toBeInTheDocument();
      withoutTasks.unmount();

      renderOverlays({ showConsent: true, hasTasks: true });
      expect(screen.getByText(/top right/i)).toBeInTheDocument();
    });

    it("Continue accepts and Leave declines", () => {
      const onAcceptConsent = vi.fn();
      const onDeclineConsent = vi.fn();
      renderOverlays({ showConsent: true, onAcceptConsent, onDeclineConsent });

      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect(onAcceptConsent).toHaveBeenCalledTimes(1);
      expect(onDeclineConsent).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Leave" }));
      expect(onDeclineConsent).toHaveBeenCalledTimes(1);
    });

    it("has no close affordance, and neither Escape nor the backdrop answers for the tester", () => {
      // The overlay this replaces dismissed itself on a backdrop click, so "I
      // read the notice" and "I clicked past something" were one gesture.
      const onAcceptConsent = vi.fn();
      const onDeclineConsent = vi.fn();
      renderOverlays({ showConsent: true, onAcceptConsent, onDeclineConsent });

      const dialog = screen.getByRole("alertdialog");
      expect(
        screen.queryByRole("button", { name: /close/i }),
      ).not.toBeInTheDocument();

      fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
      fireEvent.click(dialog);
      fireEvent.pointerDown(document.body);

      expect(onAcceptConsent).not.toHaveBeenCalled();
      expect(onDeclineConsent).not.toHaveBeenCalled();
      expect(
        screen.getByText("This session will be recorded"),
      ).toBeInTheDocument();
    });
  });

  describe("finishing OAuth timeout UI", () => {
    it("clears finishing timeout UI when pending OAuth servers change while still finishing", async () => {
      vi.useFakeTimers();

      const authorizeServer = vi.fn();

      const { rerender } = render(
        <ScenarioHostOnboardingOverlays
          showConsent={false}
          hasTasks={false}
          onAcceptConsent={vi.fn()}
          onDeclineConsent={vi.fn()}
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
          <ScenarioHostOnboardingOverlays
            showConsent={false}
            hasTasks={false}
            onAcceptConsent={vi.fn()}
            onDeclineConsent={vi.fn()}
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
