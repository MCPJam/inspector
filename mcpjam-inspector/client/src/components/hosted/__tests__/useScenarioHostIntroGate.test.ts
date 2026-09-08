import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useScenarioHostIntroGate } from "../useScenarioHostIntroGate";

const needsAuthRow = {
  server: { serverId: "srv_1" },
  state: { status: "needs_auth", errorMessage: null, serverUrl: null },
};

describe("useScenarioHostIntroGate", () => {
  afterEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("shows the recording notice on a plain scenario and blocks the composer", () => {
    const { result } = renderHook(() =>
      useScenarioHostIntroGate({
        scenarioId: "sbx_plain",
        oauthPending: false,
        pendingOAuthServers: [],
      }),
    );

    expect(result.current.showConsent).toBe(true);
    expect(result.current.composerBlocked).toBe(true);
  });

  it("asks for consent BEFORE authorization", () => {
    // Consenting to being read is a precondition for the session; the auth
    // panel waits behind it so only one dialog is ever up.
    const { result } = renderHook(() =>
      useScenarioHostIntroGate({
        scenarioId: "sbx_oauth",
        oauthPending: true,
        pendingOAuthServers: [needsAuthRow],
      }),
    );

    expect(result.current.showConsent).toBe(true);
    expect(result.current.showAuthPanel).toBe(false);
    expect(result.current.composerBlocked).toBe(true);
  });

  it("asks even while an authorization is resuming", () => {
    // An earlier version suppressed the notice whenever OAuth was busy, on the
    // theory that a resuming tester had already consented in this tab. But the
    // OAuth resume marker lives in `localStorage` — shared across tabs — while
    // the consent latch is per-tab `sessionStorage`, so opening the link in a
    // NEW tab hit "busy, no latch" and skipped the notice entirely. Nothing is
    // lost by asking: the same-tab return already has the latch.
    const { result } = renderHook(() =>
      useScenarioHostIntroGate({
        scenarioId: "sbx_busy",
        oauthPending: true,
        pendingOAuthServers: [
          {
            server: { serverId: "srv_1" },
            state: { status: "verifying", errorMessage: null, serverUrl: null },
          },
        ],
      }),
    );

    expect(result.current.showConsent).toBe(true);
    // Consent still outranks the auth panel — one dialog at a time.
    expect(result.current.showAuthPanel).toBe(false);
    expect(result.current.composerBlocked).toBe(true);
  });

  it("does not re-ask a tester returning from an authorization redirect", () => {
    // The case the dropped guard was defending: same tab, so the latch is
    // there, so no dialog either way.
    sessionStorage.setItem("scenario-intro-dismissed-sbx_return", "1");
    const { result } = renderHook(() =>
      useScenarioHostIntroGate({
        scenarioId: "sbx_return",
        oauthPending: true,
        pendingOAuthServers: [
          {
            server: { serverId: "srv_1" },
            state: { status: "verifying", errorMessage: null, serverUrl: null },
          },
        ],
      }),
    );

    expect(result.current.showConsent).toBe(false);
    expect(result.current.showAuthPanel).toBe(true);
  });

  it("latches acceptance per scenario and then reveals the auth panel", () => {
    const { result } = renderHook(() =>
      useScenarioHostIntroGate({
        scenarioId: "sbx_accept",
        oauthPending: true,
        pendingOAuthServers: [needsAuthRow],
      }),
    );

    expect(result.current.showConsent).toBe(true);

    act(() => {
      result.current.acceptConsent();
    });

    expect(result.current.showConsent).toBe(false);
    expect(result.current.showAuthPanel).toBe(true);
    expect(sessionStorage.getItem("scenario-intro-dismissed-sbx_accept")).toBe(
      "1",
    );
  });

  it("does not ask again in a session that already consented", () => {
    sessionStorage.setItem("scenario-intro-dismissed-sbx_seen", "1");
    const { result } = renderHook(() =>
      useScenarioHostIntroGate({
        scenarioId: "sbx_seen",
        oauthPending: false,
        pendingOAuthServers: [],
      }),
    );

    expect(result.current.showConsent).toBe(false);
    expect(result.current.composerBlocked).toBe(false);
  });

  it("never auto-latches consent — an OAuth scenario that loads authorized still asks", () => {
    // The version this replaces persisted a dismissal exactly here, so that
    // runtime OAuth errors would show the auth overlay rather than a stale
    // welcome. A notice that must not be skippable cannot take that shortcut:
    // whether the tester was told their session is read must not depend on
    // whether their servers happened to need authorization.
    const { result, rerender } = renderHook(
      ({ oauthPending }: { oauthPending: boolean }) =>
        useScenarioHostIntroGate({
          scenarioId: "sbx_autolatch",
          oauthPending,
          pendingOAuthServers: oauthPending ? [needsAuthRow] : [],
        }),
      { initialProps: { oauthPending: true } },
    );

    rerender({ oauthPending: false });

    expect(
      sessionStorage.getItem("scenario-intro-dismissed-sbx_autolatch"),
    ).toBeNull();
    expect(result.current.showConsent).toBe(true);
  });

  it("keeps the composer blocked after Leave, and re-asks on rejoin", () => {
    const { result } = renderHook(() =>
      useScenarioHostIntroGate({
        scenarioId: "sbx_leave",
        oauthPending: false,
        pendingOAuthServers: [],
      }),
    );

    act(() => {
      result.current.declineConsent();
    });

    // The dialog is gone but nothing was accepted: declining is an answer, so
    // the session stays closed rather than falling open behind the dialog.
    expect(result.current.showConsent).toBe(false);
    expect(result.current.consentDeclined).toBe(true);
    expect(result.current.composerBlocked).toBe(true);
    expect(
      sessionStorage.getItem("scenario-intro-dismissed-sbx_leave"),
    ).toBeNull();

    act(() => {
      result.current.rejoinAfterDecline();
    });

    // Rejoining re-arms the question rather than answering it.
    expect(result.current.showConsent).toBe(true);
    expect(result.current.consentDeclined).toBe(false);
  });

  it("asks again for a different scenario in the same tab", () => {
    const { result, rerender } = renderHook(
      ({ scenarioId }: { scenarioId: string }) =>
        useScenarioHostIntroGate({
          scenarioId,
          oauthPending: false,
          pendingOAuthServers: [],
        }),
      { initialProps: { scenarioId: "sbx_a" } },
    );

    act(() => {
      result.current.acceptConsent();
    });
    expect(result.current.showConsent).toBe(false);

    rerender({ scenarioId: "sbx_b" });

    expect(result.current.showConsent).toBe(true);
  });

  it("survives a sessionStorage that throws", () => {
    // A private window, or site data blocked. The safe direction to fail in is
    // "ask again", never "assume they consented".
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });

    const { result } = renderHook(() =>
      useScenarioHostIntroGate({
        scenarioId: "sbx_nostorage",
        oauthPending: false,
        pendingOAuthServers: [],
      }),
    );

    expect(result.current.showConsent).toBe(true);

    act(() => {
      result.current.acceptConsent();
    });

    // Accepting still works for this page view even though it cannot persist.
    expect(result.current.showConsent).toBe(false);
    expect(result.current.composerBlocked).toBe(false);
  });

  it("releases the composer on dismissAuthPanel and re-arms on a new requirement", () => {
    const errorRow = {
      server: { serverId: "srv_1" },
      state: { status: "error", errorMessage: "nope", serverUrl: null },
    };
    sessionStorage.setItem("scenario-intro-dismissed-sbx_deadend", "1");
    const { result, rerender } = renderHook(
      ({ pending }: { pending: (typeof errorRow)[] }) =>
        useScenarioHostIntroGate({
          scenarioId: "sbx_deadend",
          oauthPending: true,
          pendingOAuthServers: pending,
        }),
      { initialProps: { pending: [errorRow] } },
    );

    expect(result.current.composerBlocked).toBe(true);

    act(() => {
      result.current.dismissAuthPanel();
    });

    expect(result.current.showAuthPanel).toBe(false);
    expect(result.current.composerBlocked).toBe(false);

    // A later 401 on another server is new information, not a dismissed one.
    rerender({
      pending: [
        {
          server: { serverId: "srv_2" },
          state: { status: "needs_auth", errorMessage: null, serverUrl: null },
        },
      ],
    });

    expect(result.current.showAuthPanel).toBe(true);
  });
});
