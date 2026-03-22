import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  useAuthMock,
  createClientMock,
  getWorkosClientIdMock,
  getWorkosClientOptionsMock,
  getWorkosDevModeMock,
  getWorkosRedirectUriMock,
} = vi.hoisted(() => ({
  useAuthMock: vi.fn(),
  createClientMock: vi.fn(),
  getWorkosClientIdMock: vi.fn(),
  getWorkosClientOptionsMock: vi.fn(),
  getWorkosDevModeMock: vi.fn(),
  getWorkosRedirectUriMock: vi.fn(),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: useAuthMock,
}));

vi.mock("@workos-inc/authkit-js", () => ({
  createClient: createClientMock,
}));

vi.mock("@/lib/workos-config", () => ({
  getWorkosClientId: getWorkosClientIdMock,
  getWorkosClientOptions: getWorkosClientOptionsMock,
  getWorkosDevMode: getWorkosDevModeMock,
  getWorkosRedirectUri: getWorkosRedirectUriMock,
}));

import { useElectronHostedAuth } from "../useElectronHostedAuth";

describe("useElectronHostedAuth", () => {
  const defaultSignIn = vi.fn();
  const defaultSignUp = vi.fn();
  const defaultSignOut = vi.fn();
  const openExternal = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    window.isElectron = false;
    window.electronAPI = {
      app: {
        openExternal,
      },
    } as any;

    useAuthMock.mockReturnValue({
      signIn: defaultSignIn,
      signUp: defaultSignUp,
      signOut: defaultSignOut,
      user: null,
      isLoading: false,
    });

    getWorkosClientIdMock.mockReturnValue("workos-client-id");
    getWorkosClientOptionsMock.mockReturnValue({
      apiHostname: "api.workos.test",
    });
    getWorkosDevModeMock.mockReturnValue(true);
    getWorkosRedirectUriMock.mockReturnValue("mcpjam://oauth/callback");
  });

  it("falls back to the default AuthKit signIn outside Electron", async () => {
    const { result } = renderHook(() => useElectronHostedAuth());

    await act(async () => {
      await result.current.signIn({ screenHint: "sign-in" } as any);
    });

    expect(defaultSignIn).toHaveBeenCalledWith({ screenHint: "sign-in" });
    expect(createClientMock).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("opens hosted sign-in in the system browser in Electron", async () => {
    const dispose = vi.fn();
    const getSignInUrl = vi.fn().mockResolvedValue("https://auth.example.com");
    createClientMock.mockResolvedValue({
      getSignInUrl,
      getSignUpUrl: vi.fn(),
      dispose,
    });
    window.isElectron = true;

    const { result } = renderHook(() => useElectronHostedAuth());

    await act(async () => {
      await result.current.signIn({ screenHint: "sign-in" } as any);
    });

    expect(createClientMock).toHaveBeenCalledWith("workos-client-id", {
      redirectUri: "mcpjam://oauth/callback",
      devMode: true,
      apiHostname: "api.workos.test",
    });
    expect(getSignInUrl).toHaveBeenCalledWith({ screenHint: "sign-in" });
    expect(openExternal).toHaveBeenCalledWith("https://auth.example.com");
    expect(dispose).toHaveBeenCalled();
    expect(defaultSignIn).not.toHaveBeenCalled();
  });

  it("falls back to default AuthKit navigation when the client ID is missing", async () => {
    getWorkosClientIdMock.mockReturnValue("");
    window.isElectron = true;

    const { result } = renderHook(() => useElectronHostedAuth());

    await act(async () => {
      await result.current.signUp({ screenHint: "sign-up" } as any);
    });

    expect(defaultSignUp).toHaveBeenCalledWith({ screenHint: "sign-up" });
    expect(createClientMock).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("signs out in the background and returns Electron to a safe in-app path", async () => {
    const dispose = vi.fn();
    const clientSignOut = vi.fn().mockResolvedValue(undefined);
    const authResetListener = vi.fn();
    createClientMock.mockResolvedValue({
      getSignInUrl: vi.fn(),
      getSignUpUrl: vi.fn(),
      signOut: clientSignOut,
      dispose,
    });
    window.isElectron = true;
    window.history.replaceState({}, "", "/profile?tab=account#settings");
    window.addEventListener("electron-auth-reset", authResetListener);

    try {
      const { result } = renderHook(() => useElectronHostedAuth());

      await act(async () => {
        await result.current.signOut({
          returnTo: "http://localhost:8080/callback",
        } as any);
      });

      expect(createClientMock).toHaveBeenCalledWith("workos-client-id", {
        redirectUri: "mcpjam://oauth/callback",
        devMode: true,
        apiHostname: "api.workos.test",
      });
      expect(clientSignOut).toHaveBeenCalledWith({
        returnTo: window.location.origin,
        navigate: false,
      });
      expect(window.location.pathname).toBe("/");
      expect(window.location.search).toBe("");
      expect(window.location.hash).toBe("");
      expect(authResetListener).toHaveBeenCalledTimes(1);
      expect(defaultSignOut).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalled();
    } finally {
      window.removeEventListener("electron-auth-reset", authResetListener);
    }
  });
});
