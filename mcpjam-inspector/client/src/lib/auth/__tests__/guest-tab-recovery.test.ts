import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGuestTabRecovery,
  type GuestTransition,
} from "../guest-tab-recovery";

describe("guest tab recovery", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
  });
  afterEach(() => vi.useRealTimers());
  function tabs() {
    const reload = vi.fn();
    const allow = vi.fn(() => true);
    const receiver = createGuestTabRecovery({
      publish: vi.fn(),
      reload,
      allowAutomaticReload: allow,
    });
    receiver.setGuest("guest-a");
    const messages: GuestTransition[] = [];
    const sender = createGuestTabRecovery({
      publish: (m) => {
        messages.push(m);
        receiver.receive(m);
      },
      reload: vi.fn(),
      allowAutomaticReload: () => true,
    });
    return { sender, receiver, reload, allow, messages };
  }
  it.each(["completed", "failed", "timeout"] as const)(
    "does not replay a handled %s attempt after a reload",
    (outcome) => {
      const first = tabs();
      const message: GuestTransition = {
        guestId: "guest-a",
        attempt: "persisted",
        startedAt: Date.now(),
        phase: outcome === "timeout" ? "started" : outcome,
      };
      localStorage.setItem(
        "mcpjam.guest-transition.v1",
        JSON.stringify(message),
      );
      first.receiver.receive(message);
      if (outcome === "timeout") vi.advanceTimersByTime(15_000);
      first.receiver.dispose();
      const reloaded = tabs();
      reloaded.receiver.receive(message);
      reloaded.receiver.receive({ ...message, phase: "completed" });
      expect(reloaded.receiver.store.getState().status).toBe("idle");
      expect(reloaded.reload).not.toHaveBeenCalled();
      expect(localStorage.getItem("mcpjam.guest-transition.v1")).toBe(
        JSON.stringify(message),
      );
      localStorage.clear();
    },
  );
  it("does not consume started before a later completion, even across reload", () => {
    const first = tabs();
    const message: GuestTransition = {
      guestId: "guest-a",
      attempt: "pending",
      startedAt: Date.now(),
      phase: "started",
    };
    first.receiver.receive(message);
    expect(
      sessionStorage.getItem("mcpjam.guest-transition.v1.handled"),
    ).toBeNull();
    first.receiver.dispose();
    const reloaded = tabs();
    reloaded.receiver.receive({ ...message, phase: "completed" });
    expect(reloaded.reload).toHaveBeenCalledTimes(1);
    reloaded.receiver.dispose();
  });
  it("retains in-memory replay protection when session storage throws", () => {
    const get = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw Error("blocked");
      });
    const set = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw Error("blocked");
      });
    try {
      const t = tabs();
      const message: GuestTransition = {
        guestId: "guest-a",
        attempt: "memory",
        startedAt: Date.now(),
        phase: "failed",
      };
      expect(() => t.receiver.receive(message)).not.toThrow();
      t.receiver.dispose();
      t.receiver.receive(message);
      expect(t.receiver.store.getState().status).toBe("idle");
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });
  it("blocks another guest tab before promotion and reloads only after nested retirement finishes", () => {
    const t = tabs();
    const finish = t.sender.begin("guest-a");
    expect(t.receiver.store.getState().status).toBe("waiting");
    expect(t.reload).not.toHaveBeenCalled();
    const retire = t.sender.begin("guest-a");
    finish(true);
    expect(t.reload).not.toHaveBeenCalled();
    retire(true);
    expect(t.reload).toHaveBeenCalledTimes(1);
    t.receiver.receive(t.messages[1]);
    expect(t.reload).toHaveBeenCalledTimes(1);
  });
  it("keeps failure and timeout blocked with retry available", () => {
    const t = tabs();
    t.sender.begin("guest-a")(false);
    expect(t.receiver.store.getState().status).toBe("failed");
    expect(t.reload).not.toHaveBeenCalled();
    t.receiver.retry();
    expect(t.reload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(15_000);
    expect(t.receiver.store.getState().status).toBe("failed");
  });
  it("times out when the initiating tab disappears", () => {
    const t = tabs();
    t.sender.begin("guest-a");
    vi.advanceTimersByTime(15_000);
    expect(t.receiver.store.getState().status).toBe("failed");
  });
  it("ignores old attempts, unrelated guests and identity replacements", () => {
    const t = tabs();
    const old = t.sender.begin("guest-a");
    vi.advanceTimersByTime(1);
    t.receiver.receive({
      ...t.messages[0],
      attempt: "new",
      startedAt: Date.now(),
    });
    old(true);
    expect(t.reload).not.toHaveBeenCalled();
    t.receiver.setGuest(null); // WorkOS login has replaced the guest.
    expect(t.receiver.revoked("guest-a")).toBe(true);
    t.receiver.receive({ ...t.messages[0], phase: "completed" });
    expect(t.receiver.store.getState().status).toBe("idle");
    expect(t.reload).not.toHaveBeenCalled();
    expect(t.receiver.revoked(null)).toBe(false); // WorkOS handling remains separate.
  });
  it("handles a completed message after sleeping through start", () => {
    const t = tabs();
    t.receiver.receive({
      guestId: "guest-a",
      attempt: "sleep",
      phase: "completed",
      startedAt: Date.now() - 5000,
    });
    expect(t.reload).toHaveBeenCalledTimes(1);
  });
  it("recovers a missed message on guest refusal without repeated reloads", () => {
    const t = tabs();
    expect(t.receiver.revoked("guest-a")).toBe(true);
    t.receiver.revoked("guest-a");
    expect(t.reload).toHaveBeenCalledTimes(1);
  });
  it("offers manual recovery when automatic reload is unsafe", () => {
    const t = tabs();
    t.allow.mockReturnValue(false);
    t.receiver.revoked("guest-a");
    expect(t.reload).not.toHaveBeenCalled();
    expect(t.receiver.store.getState().status).toBe("failed");
    t.receiver.retry();
    expect(t.reload).toHaveBeenCalledTimes(1);
  });
  it("does not interrupt the source operation when messaging fails", () => {
    const t = createGuestTabRecovery({
      publish: () => {
        throw Error("blocked storage");
      },
      reload: vi.fn(),
      allowAutomaticReload: () => false,
    });
    expect(() => t.begin("guest-a")(true)).not.toThrow();
  });
});

it("uses storage events when BroadcastChannel is unavailable", async () => {
  const { guestTabRecovery, listenForGuestTransitions } =
    await import("../guest-tab-recovery");
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      constructor() {
        throw Error("unavailable");
      }
    },
  );
  guestTabRecovery.setGuest("storage-guest");
  const stop = listenForGuestTransitions();
  try {
    localStorage.setItem(
      "mcpjam.guest-transition.v1",
      JSON.stringify({
        guestId: "storage-guest",
        attempt: "storage",
        startedAt: Date.now(),
        phase: "started",
      }),
    );
    window.dispatchEvent(
      new StorageEvent("storage", { key: "mcpjam.guest-transition.v1" }),
    );
    await Promise.resolve();
    expect(guestTabRecovery.store.getState().status).toBe("waiting");
  } finally {
    stop();
    guestTabRecovery.setGuest(null);
    localStorage.clear();
    vi.unstubAllGlobals();
  }
});

it("creates correlation IDs when randomUUID is unavailable on plain HTTP", async () => {
  const { authCorrelationId } = await import("../correlation-id");
  vi.stubGlobal("crypto", {});
  try {
    expect(authCorrelationId()).toMatch(/^[a-z0-9-]+$/);
    expect(authCorrelationId()).not.toBe(authCorrelationId());
  } finally {
    vi.unstubAllGlobals();
  }
});
