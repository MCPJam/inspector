import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  autoOAuthEscalation,
  confirmAutoOAuthEscalation,
  type AutoEscalationIdentity,
} from "../auto-oauth-escalation";
import { toast } from "@/lib/toast";

vi.mock("@/lib/toast", () => ({
  toast: vi.fn(),
}));

const toastMock = vi.mocked(toast);

const asana: AutoEscalationIdentity = {
  projectId: "project-1",
  serverId: "server-1",
  serverName: "Asana",
};

describe("autoOAuthEscalation marker lifecycle", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
    toastMock.mockReset();
  });

  it("markPending → hasPendingAttempt; succeeded and failed both clear", () => {
    expect(autoOAuthEscalation.hasPendingAttempt(asana)).toBe(false);

    autoOAuthEscalation.markPending(asana);
    expect(autoOAuthEscalation.hasPendingAttempt(asana)).toBe(true);

    autoOAuthEscalation.markSucceeded(asana);
    expect(autoOAuthEscalation.hasPendingAttempt(asana)).toBe(false);

    autoOAuthEscalation.markPending(asana);
    autoOAuthEscalation.markFailed(asana);
    expect(autoOAuthEscalation.hasPendingAttempt(asana)).toBe(false);
  });

  it("survives a simulated page reload (sessionStorage-backed)", () => {
    autoOAuthEscalation.markPending(asana);
    // Nothing in-memory: a fresh read hits sessionStorage directly.
    expect(
      JSON.parse(sessionStorage.getItem("mcp-auto-oauth-escalated") ?? "[]"),
    ).toHaveLength(1);
    expect(autoOAuthEscalation.hasPendingAttempt(asana)).toBe(true);
  });

  it("does not collide across projects for identically named servers", () => {
    const sameNameOtherProject: AutoEscalationIdentity = {
      projectId: "project-2",
      serverId: "server-9",
      serverName: "Asana",
    };
    autoOAuthEscalation.markPending(asana);

    expect(autoOAuthEscalation.hasPendingAttempt(sameNameOtherProject)).toBe(
      false,
    );

    autoOAuthEscalation.markFailed(sameNameOtherProject);
    expect(autoOAuthEscalation.hasPendingAttempt(asana)).toBe(true);
  });

  it("prefers the server id over the name within a project", () => {
    autoOAuthEscalation.markPending(asana);
    // Same name, different id → different server (e.g. deleted + re-added).
    expect(
      autoOAuthEscalation.hasPendingAttempt({
        ...asana,
        serverId: "server-2",
      }),
    ).toBe(false);
    // No id yet (pre-sync) keys by name — distinct from the id-keyed entry.
    expect(
      autoOAuthEscalation.hasPendingAttempt({ ...asana, serverId: null }),
    ).toBe(false);
  });

  it("degrades to re-prompting when sessionStorage is unavailable", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota exceeded");
      },
    });
    try {
      expect(() => autoOAuthEscalation.markPending(asana)).not.toThrow();
      expect(autoOAuthEscalation.hasPendingAttempt(asana)).toBe(false);
      expect(() => autoOAuthEscalation.markFailed(asana)).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("ignores corrupted storage payloads", () => {
    sessionStorage.setItem("mcp-auto-oauth-escalated", "{not json");
    expect(autoOAuthEscalation.hasPendingAttempt(asana)).toBe(false);
    autoOAuthEscalation.markPending(asana);
    expect(autoOAuthEscalation.hasPendingAttempt(asana)).toBe(true);
  });
});

describe("confirmAutoOAuthEscalation", () => {
  beforeEach(() => {
    toastMock.mockReset();
  });

  function capturedToastOptions() {
    expect(toastMock).toHaveBeenCalledTimes(1);
    return toastMock.mock.calls[0][1] as {
      action: { onClick: () => void };
      cancel: { onClick: () => void };
      onDismiss: () => void;
      onAutoClose: () => void;
      duration: number;
    };
  }

  it("resolves true when the user continues", async () => {
    const promise = confirmAutoOAuthEscalation("Asana");
    const options = capturedToastOptions();
    expect(options.duration).toBe(Infinity);
    options.action.onClick();
    await expect(promise).resolves.toBe(true);
  });

  it("resolves false on cancel", async () => {
    const promise = confirmAutoOAuthEscalation("Asana");
    capturedToastOptions().cancel.onClick();
    await expect(promise).resolves.toBe(false);
  });

  it("treats dismissal as not-now", async () => {
    const promise = confirmAutoOAuthEscalation("Asana");
    capturedToastOptions().onDismiss();
    await expect(promise).resolves.toBe(false);
  });

  it("settles exactly once — a late dismiss cannot flip a confirm", async () => {
    const promise = confirmAutoOAuthEscalation("Asana");
    const options = capturedToastOptions();
    options.action.onClick();
    options.onDismiss();
    options.cancel.onClick();
    await expect(promise).resolves.toBe(true);
  });
});
