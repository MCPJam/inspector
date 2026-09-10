import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authFetch } from "@/lib/session-token";
import {
  clearStoredLocalComputerConsent,
  loadStoredLocalComputerConsent,
  persistLocalComputerConsent,
  subscribeLocalComputerConsent,
} from "@/lib/local-computer-consent";
import { ensureLocalBrowser } from "../client";

vi.mock("@/lib/session-token", () => ({ authFetch: vi.fn() }));

const oldToken = "old-device-consent-token";
const newToken = "new-device-consent-token";
const refused = () =>
  new Response(
    JSON.stringify({ error: "Local computer consent is required" }),
    { status: 403 },
  );

beforeEach(() => {
  vi.mocked(authFetch).mockReset();
  persistLocalComputerConsent({ token: oldToken, grantedAt: "test" });
});
afterEach(() => clearStoredLocalComputerConsent());

describe("local browser consent recovery", () => {
  it("clears the rejected grant and notifies the consent gate", async () => {
    vi.mocked(authFetch).mockResolvedValue(refused());
    const changed = vi.fn();
    const unsubscribe = subscribeLocalComputerConsent(changed);
    try {
      await expect(ensureLocalBrowser("project", oldToken)).rejects.toThrow(
        "Local computer consent is required",
      );
      expect(loadStoredLocalComputerConsent()).toBeNull();
      expect(changed).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
    }
  });

  it("preserves a newer grant when an old request is rejected", async () => {
    vi.mocked(authFetch).mockImplementation(async () => {
      persistLocalComputerConsent({ token: newToken, grantedAt: "test" });
      return refused();
    });
    await expect(ensureLocalBrowser("project", oldToken)).rejects.toThrow();
    expect(loadStoredLocalComputerConsent()?.token).toBe(newToken);
  });

  it.each([401, 403, 500])(
    "preserves consent for an unrelated %s failure",
    async (status) => {
      vi.mocked(authFetch).mockResolvedValue(
        new Response(JSON.stringify({ error: "Another failure" }), { status }),
      );
      await expect(ensureLocalBrowser("project", oldToken)).rejects.toThrow();
      expect(loadStoredLocalComputerConsent()?.token).toBe(oldToken);
    },
  );
});
