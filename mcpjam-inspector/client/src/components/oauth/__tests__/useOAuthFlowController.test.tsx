import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthStateMachineFactoryConfig } from "@/lib/oauth/state-machines/factory";
import { useOAuthFlowController } from "../useOAuthFlowController";
import type { OAuthTestProfile } from "@/lib/oauth/profile";

const {
  mockCreateOAuthStateMachine,
  mockProceedToNextStep,
  mockBroadcastChannels,
} = vi.hoisted(() => ({
  mockCreateOAuthStateMachine: vi.fn(),
  mockProceedToNextStep: vi.fn(),
  mockBroadcastChannels: [] as any[],
}));

class MockBroadcastChannel {
  public onmessage:
    | ((event: { data: unknown }) => void)
    | null = null;

  constructor(public readonly name: string) {
    mockBroadcastChannels.push(this);
  }

  close = vi.fn();

  emit(data: unknown) {
    this.onmessage?.({ data });
  }
}

vi.mock("@/lib/oauth/state-machines/factory", () => ({
  createOAuthStateMachine: mockCreateOAuthStateMachine,
}));

const baseProfile: OAuthTestProfile = {
  serverUrl: "https://example.com/mcp",
  clientId: "client-id",
  clientSecret: "",
  scopes: "openid profile",
  customHeaders: [{ key: "x-test-header", value: "debug" }],
  protocolVersion: "2025-11-25",
  registrationStrategy: "cimd",
};

const setupStateMachineMock = () => {
  mockCreateOAuthStateMachine.mockImplementation(
    (config: OAuthStateMachineFactoryConfig) => ({
      state: config.state,
      updateState: config.updateState,
      proceedToNextStep: mockProceedToNextStep.mockImplementation(async () => {
        const state = config.getState?.() ?? config.state;

        switch (state.currentStep) {
          case "idle":
            config.updateState({ currentStep: "generate_pkce_parameters" });
            break;
          case "generate_pkce_parameters":
            config.updateState({
              currentStep: "authorization_request",
              authorizationUrl: "https://auth.example.com/authorize",
              state: "expected-state",
            });
            break;
          case "authorization_request":
            config.updateState({
              currentStep: "complete",
              accessToken: "access-token",
              refreshToken: "refresh-token",
              tokenType: "Bearer",
              expiresIn: 3600,
            });
            break;
          default:
            break;
        }
      }),
      startGuidedFlow: vi.fn(),
      resetFlow: vi.fn(),
    }),
  );
};

describe("useOAuthFlowController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockCreateOAuthStateMachine.mockReset();
    mockProceedToNextStep.mockReset();
    mockBroadcastChannels.length = 0;
    setupStateMachineMock();
    vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("initializes the state machine from the provided profile", () => {
    const { result } = renderHook(() =>
      useOAuthFlowController({
        profile: baseProfile,
        serverIdentifier: "Example Server",
        resetKey: "server-one",
        experienceConfig: {
          initialFocusedStep: "authorization_request",
        },
      }),
    );

    expect(result.current.oauthFlowState.serverUrl).toBe(baseProfile.serverUrl);
    expect(result.current.focusedStep).toBe("authorization_request");
    expect(mockCreateOAuthStateMachine).toHaveBeenCalledWith(
      expect.objectContaining({
        protocolVersion: "2025-11-25",
        registrationStrategy: "cimd",
        serverName: "Example Server",
        serverUrl: "https://example.com/mcp",
        customScopes: "openid profile",
        customHeaders: { "x-test-header": "debug" },
      }),
    );
  });

  it("advances through setup and opens the auth modal when authorization is reached", async () => {
    const { result } = renderHook(() =>
      useOAuthFlowController({
        profile: baseProfile,
        serverIdentifier: "Example Server",
        resetKey: "server-one",
      }),
    );

    await act(async () => {
      await result.current.handleAdvance();
    });

    expect(result.current.oauthFlowState.currentStep).toBe(
      "generate_pkce_parameters",
    );
    expect(result.current.isAuthModalOpen).toBe(false);

    await act(async () => {
      await result.current.handleAdvance();
    });

    expect(result.current.oauthFlowState.currentStep).toBe(
      "authorization_request",
    );
    expect(result.current.oauthFlowState.authorizationUrl).toBe(
      "https://auth.example.com/authorize",
    );
    expect(result.current.isAuthModalOpen).toBe(true);
  });

  it("processes a window message callback and auto-advances the flow", async () => {
    const { result } = renderHook(() =>
      useOAuthFlowController({
        profile: baseProfile,
        serverIdentifier: "Example Server",
        resetKey: "server-one",
      }),
    );

    await act(async () => {
      await result.current.handleAdvance();
    });

    await act(async () => {
      await result.current.handleAdvance();
    });

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          data: {
            type: "OAUTH_CALLBACK",
            code: "oauth-code",
            state: "expected-state",
          },
        }),
      );
      vi.advanceTimersByTime(500);
    });

    expect(result.current.isAuthModalOpen).toBe(false);
    expect(result.current.oauthFlowState.authorizationCode).toBe("oauth-code");
    expect(result.current.oauthFlowState.currentStep).toBe("complete");
    expect(result.current.extractTokensFromFlowState()).toEqual({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      tokenType: "Bearer",
      expiresIn: 3600,
      clientId: undefined,
      clientSecret: undefined,
    });
  });

  it("processes a BroadcastChannel callback and rejects stale state mismatches", async () => {
    const { result } = renderHook(() =>
      useOAuthFlowController({
        profile: baseProfile,
        serverIdentifier: "Example Server",
        resetKey: "server-one",
      }),
    );

    await act(async () => {
      await result.current.handleAdvance();
    });

    await act(async () => {
      await result.current.handleAdvance();
    });

    act(() => {
      mockBroadcastChannels[0]?.emit({
        type: "OAUTH_CALLBACK",
        code: "stale-code",
        state: "wrong-state",
      });
    });

    expect(result.current.oauthFlowState.currentStep).toBe(
      "authorization_request",
    );
    expect(result.current.oauthFlowState.error).toContain(
      "Invalid state parameter",
    );

    act(() => {
      mockBroadcastChannels[0]?.emit({
        type: "OAUTH_CALLBACK",
        code: "fresh-code",
        state: "expected-state",
      });
      vi.advanceTimersByTime(500);
    });

    expect(result.current.oauthFlowState.authorizationCode).toBe("fresh-code");
    expect(result.current.oauthFlowState.currentStep).toBe("complete");
  });

  it("resets flow state when requested directly or when the target key changes", async () => {
    const { result, rerender } = renderHook(
      ({
        profile,
        resetKey,
      }: {
        profile: OAuthTestProfile;
        resetKey: string;
      }) =>
        useOAuthFlowController({
          profile,
          serverIdentifier: "Example Server",
          resetKey,
          experienceConfig: {
            initialFocusedStep: "authorization_request",
          },
        }),
      {
        initialProps: {
          profile: baseProfile,
          resetKey: "server-one",
        },
      },
    );

    await act(async () => {
      await result.current.handleAdvance();
      await result.current.handleAdvance();
    });

    act(() => {
      result.current.resetOAuthFlow("https://override.example.com/mcp");
    });

    expect(result.current.oauthFlowState.currentStep).toBe("idle");
    expect(result.current.oauthFlowState.serverUrl).toBe(
      "https://override.example.com/mcp",
    );
    expect(result.current.oauthFlowState.accessToken).toBeUndefined();
    expect(result.current.oauthFlowState.authorizationCode).toBeUndefined();
    expect(result.current.focusedStep).toBe("authorization_request");
    expect(result.current.isAuthModalOpen).toBe(false);

    rerender({
      profile: {
        ...baseProfile,
        serverUrl: "https://second.example.com/mcp",
      },
      resetKey: "server-two",
    });

    expect(result.current.oauthFlowState.currentStep).toBe("idle");
    expect(result.current.oauthFlowState.serverUrl).toBe(
      "https://second.example.com/mcp",
    );
    expect(result.current.focusedStep).toBe("authorization_request");
  });
});
