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

// The profile helper always reports the 2025-11-25 default, the value a
// 2026-only server rejects; Auto must not use it.
vi.mock("@/components/oauth/utils", () => ({
  deriveOAuthProfileFromServer: () => ({
    serverUrl: "https://server.example/mcp",
    protocolVersion: "2025-11-25",
    registrationStrategy: "dcr",
    clientId: "",
    clientSecret: "",
    scopes: "",
    customHeaders: [],
  }),
}));

function makeServer(negotiated?: string): ServerWithName {
  return {
    name: "target",
    config: { url: new URL("https://server.example/mcp") },
    ...(negotiated
      ? { initializationInfo: { protocolVersion: negotiated } }
      : {}),
  } as unknown as ServerWithName;
}

async function sentOAuthVersion(server: ServerWithName, pin?: "2025-06-18") {
  const view = renderHook(() =>
    useConformanceRun({ server, deferOAuthAuthorization: true }),
  );
  if (pin) {
    act(() => view.result.current.setVersionPin(pin));
  }

  await act(async () => {
    await view.result.current.runAll();
  });
  await waitFor(() => expect(api.startOAuthConformance).toHaveBeenCalled());

  return api.startOAuthConformance.mock.calls[0][0].oauthProfile
    .protocolVersion;
}

describe("useConformanceRun OAuth protocol version", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
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

  it("on Auto, uses the version the server negotiated at connect", async () => {
    expect(await sentOAuthVersion(makeServer("2026-07-28"))).toBe("2026-07-28");
  });

  it("on Auto, falls back to 2025-11-25 when nothing was negotiated", async () => {
    expect(await sentOAuthVersion(makeServer())).toBe("2025-11-25");
  });

  it("a pinned version beats the negotiated one", async () => {
    expect(await sentOAuthVersion(makeServer("2026-07-28"), "2025-06-18")).toBe(
      "2025-06-18",
    );
  });
});
