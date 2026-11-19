import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConformanceRun } from "../use-conformance-run";
import type { ServerWithName } from "@/hooks/use-app-state";

const api = vi.hoisted(() => ({
  startOAuthConformance: vi.fn(),
  submitOAuthConformanceCode: vi.fn(),
  completeOAuthConformance: vi.fn(),
  cancelOAuthConformance: vi.fn(async () => ({ success: true })),
  runProtocolConformance: vi.fn(),
  runAppsConformance: vi.fn(),
  runTasksConformance: vi.fn(),
}));

const toast = vi.hoisted(() => ({ warning: vi.fn(), dismiss: vi.fn() }));

vi.mock("@/lib/toast", () => ({ toast }));

vi.mock("@/lib/apis/conformance-connection-api", () => ({
  checkConformanceConnection: vi.fn(async (_name: string, version: string) => ({
    status: "ready",
    protocolVersion: version === "auto" ? "2026-07-28" : version,
  })),
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

let popup: { closed: boolean };

/** Drive a run to the parked authorization step. */
async function parkOAuth(runTimeoutSeconds?: number) {
  const view = renderHook(() =>
    useConformanceRun({
      server,
      deferOAuthAuthorization: true,
      runTimeoutSeconds,
    }),
  );
  await act(async () => {
    await view.result.current.runAll();
  });
  await waitFor(() =>
    expect(view.result.current.oauth.status).toBe("needs-authorization"),
  );
  return view;
}

/** Drive a run to the open sign-in popup. */
async function openPopup(runTimeoutSeconds?: number) {
  const view = await parkOAuth(runTimeoutSeconds);
  act(() => view.result.current.authorizeOAuth());
  return view;
}

function postCode() {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        data: { type: "OAUTH_CALLBACK", code: "code", state: "s" },
      }),
    );
  });
}

function closePopup() {
  popup.closed = true;
  act(() => {
    vi.advanceTimersByTime(2_000);
  });
}

describe("useConformanceRun OAuth callback hint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    popup = { closed: false };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the hint once when the popup closes with no code back", async () => {
    await openPopup();

    closePopup();

    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(
      "OAuth sign-in didn't finish. Check your OAuth app's redirect URLs.",
      expect.objectContaining({
        description: expect.stringContaining(
          `${window.location.origin}/oauth/callback/debug`,
        ),
      }),
    );
  });

  it("stays quiet when the code came back before the popup closed", async () => {
    await openPopup();

    postCode();
    closePopup();

    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("drops a hint shown early once the code comes back", async () => {
    await openPopup();

    closePopup();
    postCode();

    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.dismiss).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when OAuth was skipped before the popup closed", async () => {
    const view = await openPopup();

    act(() => view.result.current.skipOAuth());
    closePopup();

    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("shows the hint when the run deadline ends while signing in", async () => {
    await openPopup(5);

    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(toast.warning).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when the deadline ends before the popup was opened", async () => {
    await parkOAuth(5);

    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(toast.warning).not.toHaveBeenCalled();
  });
});
