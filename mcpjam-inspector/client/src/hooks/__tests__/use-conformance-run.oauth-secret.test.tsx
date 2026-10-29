import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConformanceRun } from "../use-conformance-run";
import type { ServerWithName } from "@/hooks/use-app-state";

const api = vi.hoisted(() => ({
  startOAuthConformance: vi.fn(),
  submitOAuthConformanceCode: vi.fn(),
  completeOAuthConformance: vi.fn(),
  runProtocolConformance: vi.fn(),
  runAppsConformance: vi.fn(),
  runTasksConformance: vi.fn(),
}));

const secrets = vi.hoisted(() => ({
  fetchOAuthClientSecret: vi.fn(),
  tryResolveProjectServer: vi.fn(),
}));

const profile = vi.hoisted(() => ({
  clientId: "prereg-client",
  clientSecret: "",
}));

vi.mock("@/lib/apis/mcp-conformance-api", () => api);
vi.mock("@/lib/apis/hosted-oauth-client-secret-api", () => ({
  fetchOAuthClientSecret: secrets.fetchOAuthClientSecret,
}));
vi.mock("@/lib/apis/web/context", () => ({
  tryResolveProjectServer: secrets.tryResolveProjectServer,
}));

// A hosted server's profile never carries its saved secret — only the
// `hasClientSecret` flag on the server says one exists in Convex.
vi.mock("@/components/oauth/utils", () => ({
  deriveOAuthProfileFromServer: () => ({
    serverUrl: "https://server.example/mcp",
    protocolVersion: "2025-11-25",
    registrationStrategy: "preregistered",
    clientId: profile.clientId,
    clientSecret: profile.clientSecret,
    scopes: "",
    customHeaders: [],
  }),
}));

function makeServer(hasClientSecret: boolean): ServerWithName {
  return {
    name: "asana",
    config: { url: new URL("https://server.example/mcp") },
    hasClientSecret,
  } as unknown as ServerWithName;
}

async function sentClientSecret(server: ServerWithName) {
  const view = renderHook(() =>
    useConformanceRun({ server, deferOAuthAuthorization: true }),
  );

  await act(async () => {
    await view.result.current.runAll();
  });
  await waitFor(() => expect(api.startOAuthConformance).toHaveBeenCalled());

  return api.startOAuthConformance.mock.calls[0][0].oauthProfile.clientSecret;
}

describe("useConformanceRun OAuth client secret", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    profile.clientId = "prereg-client";
    profile.clientSecret = "";
    secrets.tryResolveProjectServer.mockReturnValue({
      projectId: "project-1",
      serverId: "server-1",
    });
    secrets.fetchOAuthClientSecret.mockResolvedValue({
      clientSecret: "saved-secret",
    });
    api.startOAuthConformance.mockResolvedValue({
      phase: "authorization_needed",
      sessionId: "session-1",
      authorizationUrl: "https://idp.example/authorize",
    });
    for (const suite of [
      api.runProtocolConformance,
      api.runAppsConformance,
      api.runTasksConformance,
    ]) {
      suite.mockResolvedValue({ summary: {} });
    }
  });

  it("sends the secret saved in server settings", async () => {
    expect(await sentClientSecret(makeServer(true))).toBe("saved-secret");
    expect(secrets.fetchOAuthClientSecret).toHaveBeenCalledWith(
      { projectId: "project-1", serverId: "server-1" },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("prefers a secret already on the profile", async () => {
    profile.clientSecret = "typed-secret";
    expect(await sentClientSecret(makeServer(true))).toBe("typed-secret");
    expect(secrets.fetchOAuthClientSecret).not.toHaveBeenCalled();
  });

  it("fetches nothing when the server has no saved secret", async () => {
    expect(await sentClientSecret(makeServer(false))).toBeUndefined();
    expect(secrets.fetchOAuthClientSecret).not.toHaveBeenCalled();
  });

  it("fetches nothing without a client ID", async () => {
    profile.clientId = "";
    expect(await sentClientSecret(makeServer(true))).toBeUndefined();
    expect(secrets.fetchOAuthClientSecret).not.toHaveBeenCalled();
  });

  it("stops the OAuth suite when the saved secret can't be loaded", async () => {
    secrets.fetchOAuthClientSecret.mockRejectedValue(new Error("forbidden"));
    const view = renderHook(() =>
      useConformanceRun({ server: makeServer(true), deferOAuthAuthorization: true }),
    );

    await act(async () => {
      await view.result.current.runAll();
    });

    await waitFor(() =>
      expect(view.result.current.oauth).toMatchObject({
        status: "error",
        error: "Couldn't load the saved client secret. Run the checks again.",
      }),
    );
    expect(api.startOAuthConformance).not.toHaveBeenCalled();
  });

  it("stops the OAuth suite when a flagged server isn't in the project", async () => {
    secrets.tryResolveProjectServer.mockReturnValue(null);
    const view = renderHook(() =>
      useConformanceRun({ server: makeServer(true), deferOAuthAuthorization: true }),
    );

    await act(async () => {
      await view.result.current.runAll();
    });

    await waitFor(() =>
      expect(view.result.current.oauth).toMatchObject({
        status: "error",
        error: "Couldn't load the saved client secret. Run the checks again.",
      }),
    );
    expect(secrets.fetchOAuthClientSecret).not.toHaveBeenCalled();
    expect(api.startOAuthConformance).not.toHaveBeenCalled();
  });

  it("stops instead of sending the secret when the project changed during the fetch", async () => {
    secrets.tryResolveProjectServer
      .mockReturnValueOnce({ projectId: "project-1", serverId: "server-1" })
      .mockReturnValue({ projectId: "project-2", serverId: "server-9" });
    const view = renderHook(() =>
      useConformanceRun({ server: makeServer(true), deferOAuthAuthorization: true }),
    );

    await act(async () => {
      await view.result.current.runAll();
    });

    await waitFor(() =>
      expect(view.result.current.oauth.status).toBe("error"),
    );
    expect(api.startOAuthConformance).not.toHaveBeenCalled();
  });
});
