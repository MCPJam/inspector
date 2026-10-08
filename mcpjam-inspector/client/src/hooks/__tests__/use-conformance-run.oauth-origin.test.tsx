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

vi.mock("@/lib/apis/mcp-conformance-api", () => api);

vi.mock("@/components/oauth/utils", () => ({
  deriveOAuthProfileFromServer: () => ({
    serverUrl: "https://server.example/mcp",
    protocolVersion: undefined,
    registrationStrategy: undefined,
    clientId: "",
    clientSecret: "",
    scopes: "",
    customHeaders: [],
  }),
}));

const server = {
  name: "target",
  config: { url: new URL("https://server.example/mcp") },
} as unknown as ServerWithName;

/** Drive a run to the parked authorization step and open the popup. */
async function armOAuthListener() {
  const view = renderHook(() =>
    useConformanceRun({ server, deferOAuthAuthorization: true }),
  );

  await act(async () => {
    await view.result.current.runAll();
  });
  await waitFor(() =>
    expect(view.result.current.oauth.status).toBe("needs-authorization"),
  );

  act(() => view.result.current.authorizeOAuth());
  return view;
}

function postCallback(origin: string) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin,
        data: { type: "OAUTH_CALLBACK", code: "injected-code", state: "s" },
      }),
    );
  });
}

describe("useConformanceRun OAuth callback listener", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, "open").mockReturnValue(null);
    api.startOAuthConformance.mockResolvedValue({
      phase: "authorization_needed",
      sessionId: "session-1",
      authorizationUrl: "https://idp.example/authorize",
    });
    api.submitOAuthConformanceCode.mockResolvedValue({ phase: "pending" });
    api.completeOAuthConformance.mockResolvedValue({ phase: "pending" });
    for (const suite of [
      api.runProtocolConformance,
      api.runAppsConformance,
      api.runTasksConformance,
    ]) {
      suite.mockResolvedValue({ summary: {} });
    }
  });

  it("ignores an authorization code posted from another origin", async () => {
    await armOAuthListener();

    postCallback("https://evil.example");

    expect(api.submitOAuthConformanceCode).not.toHaveBeenCalled();
  });

  it("accepts the code the same-origin callback page posts", async () => {
    await armOAuthListener();

    postCallback(window.location.origin);

    await waitFor(() =>
      expect(api.submitOAuthConformanceCode).toHaveBeenCalledWith(
        expect.objectContaining({ code: "injected-code" }),
      ),
    );
  });
});
