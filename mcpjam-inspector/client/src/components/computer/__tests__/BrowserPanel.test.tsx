/**
 * The Browser Panel's token discipline.
 *
 * Both cases here are one incident (Sentry CONVEX-27Q). The panel minted a
 * fresh token on every request, and its two polling loops swallowed every
 * failure with `.catch(() => {})`. So a computer released or auto-paused under
 * an open panel produced one uncaught server error per minute per open tab,
 * for as long as the tab stayed open, while the panel itself showed nothing.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { ConvexError } from "convex/values";

const mintProject = vi.fn();
const mintConversation = vi.fn();

// Both must be referentially STABLE across renders. `useAction` is; a mock
// that returns a fresh function each render rebuilds `getToken` → `authorized`
// → `refresh`, and the effect keyed on `refresh` then re-fires forever.
vi.mock("@/hooks/useProjectComputer", () => ({
  useMintBrowserToken: () => mintProject,
  useMintConversationBrowserToken: () => mintConversation,
}));

vi.mock("../BrowserStream", () => ({ BrowserStream: () => null }));
vi.mock("@/components/browser/BrowserProfileSaveButton", () => ({
  BrowserProfileSaveButton: () => null,
}));

const setBrowserLocation = vi.fn();
const markBrowserSessionActive = vi.fn();
const useActiveChatSessionStore = Object.assign(
  (select: (s: unknown) => unknown) => select({ markBrowserSessionActive }),
  { getState: () => ({ setBrowserLocation }) },
);
vi.mock("@/stores/active-chat-session-store", () => ({
  get useActiveChatSessionStore() {
    return useActiveChatSessionStore;
  },
}));

import { BrowserPanel } from "../BrowserPanel";

/** A live `/session` answer, so the panel settles into WATCHING. */
function sessionOk() {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({
      sessionId: "s-1",
      bootId: "b-1",
      lease: { state: "free" },
    }),
  } as unknown as Response;
}

describe("BrowserPanel token discipline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mintProject.mockReset();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sessionOk()),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reuses one token across requests instead of minting per request", async () => {
    // Long-lived token so the keepalive tick lands well inside its lifetime.
    mintProject.mockResolvedValue({
      token: "tok",
      expiresAt: Date.now() + 600_000,
    });

    render(<BrowserPanel projectId="p1" />);
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    // Two requests went out — the initial /session and one /keepalive — and
    // they shared a single mint. Before this, that was two round trips to
    // Convex for a token already sitting in memory.
    expect(
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThanOrEqual(2);
    expect(mintProject).toHaveBeenCalledTimes(1);
  });

  it("stops polling and says so when the browser goes away", async () => {
    // First mint succeeds so the panel reaches WATCHING; the computer is then
    // released, so the re-mint after the token lapses reports it.
    mintProject
      .mockResolvedValueOnce({ token: "tok", expiresAt: Date.now() + 60_000 })
      .mockRejectedValue(
        new ConvexError({
          kind: "browser_unavailable",
          message:
            "No active desktop computer for this project — reserve one first",
        }),
      );

    render(<BrowserPanel projectId="p1" />);
    await act(async () => {});

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(screen.getByText(/reserve one first/)).toBeTruthy();

    const afterStop = mintProject.mock.calls.length;
    // Five more minutes of wall clock. The loop is gone, so nothing else is
    // attempted — this is the assertion that the error-per-minute stops.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });
    expect(mintProject).toHaveBeenCalledTimes(afterStop);
  });
});
