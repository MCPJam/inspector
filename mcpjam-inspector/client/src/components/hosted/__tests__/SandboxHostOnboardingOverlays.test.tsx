import { describe, expect, it, vi, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { SandboxHostOnboardingOverlays } from "../SandboxHostOnboardingOverlays";
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

describe("SandboxHostOnboardingOverlays", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears finishing timeout UI when pending OAuth servers change while still finishing", async () => {
    vi.useFakeTimers();

    const authorizeServer = vi.fn();

    const { rerender } = render(
      <SandboxHostOnboardingOverlays
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
        <SandboxHostOnboardingOverlays
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
