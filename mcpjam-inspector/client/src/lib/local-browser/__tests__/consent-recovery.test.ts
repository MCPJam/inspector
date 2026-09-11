import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authFetch } from "@/lib/session-token";
import {
  clearStoredLocalBrowserConsent,
  loadStoredLocalBrowserConsent,
  persistLocalBrowserConsent,
  localBrowserSetupPending,
  subscribeLocalBrowserConsent,
} from "@/lib/local-browser-consent";
import { ensureLocalBrowser } from "../client";

vi.mock("@/lib/session-token", () => ({ authFetch: vi.fn() }));

const oldToken = "old-device-consent-token";
const newToken = "new-device-consent-token";
const refused = () =>
  new Response(
    JSON.stringify({
      error:
        "Browser permission is required. Allow Browser in the Browser panel.",
      code: "browser_consent_required",
    }),
    { status: 403 },
  );

beforeEach(() => {
  vi.mocked(authFetch).mockReset();
  persistLocalBrowserConsent({ token: oldToken, grantedAt: "test" });
});
afterEach(() => clearStoredLocalBrowserConsent());

describe("local browser consent recovery", () => {
  it.each([false, true])(
    "clears the rejected grant and notifies once (setup pending: %s)",
    async (setupPending) => {
      vi.mocked(authFetch).mockResolvedValue(refused());
      if (setupPending)
        localStorage.setItem("mcp-local-browser-setup-pending-v1", "true");
      const changed = vi.fn(() => {
        expect(loadStoredLocalBrowserConsent()).toBeNull();
        expect(localBrowserSetupPending()).toBe(false);
      });
      const unsubscribe = subscribeLocalBrowserConsent(changed);
      try {
        await expect(ensureLocalBrowser("project", oldToken)).rejects.toThrow(
          "Browser permission is required. Allow Browser in the Browser panel.",
        );
        expect(loadStoredLocalBrowserConsent()).toBeNull();
        expect(changed).toHaveBeenCalledOnce();
      } finally {
        unsubscribe();
      }
    },
  );

  it("preserves a newer grant when an old request is rejected", async () => {
    vi.mocked(authFetch).mockImplementation(async () => {
      persistLocalBrowserConsent({ token: newToken, grantedAt: "test" });
      return refused();
    });
    await expect(ensureLocalBrowser("project", oldToken)).rejects.toThrow();
    expect(loadStoredLocalBrowserConsent()?.token).toBe(newToken);
  });

  it.each([401, 403, 500])(
    "preserves consent for an unrelated %s failure",
    async (status) => {
      vi.mocked(authFetch).mockResolvedValue(
        new Response(JSON.stringify({ error: "Another failure" }), { status }),
      );
      await expect(ensureLocalBrowser("project", oldToken)).rejects.toThrow();
      expect(loadStoredLocalBrowserConsent()?.token).toBe(oldToken);
    },
  );
});
