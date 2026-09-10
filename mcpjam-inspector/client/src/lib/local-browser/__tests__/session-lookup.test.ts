import { beforeEach, describe, expect, it, vi } from "vitest";
import { authFetch } from "@/lib/session-token";
import { LOCAL_CONSENT_HEADER } from "@/lib/local-computer-consent";
import { fetchLocalBrowserSession } from "../client";

vi.mock("@/lib/session-token", () => ({ authFetch: vi.fn() }));
beforeEach(() => vi.mocked(authFetch).mockReset());

describe("reading a conversation's live browser", () => {
  it.each([
    null,
    { bootId: "existing", contextMode: "persistent", lease: { state: "free" } },
  ])(
    "returns the lookup result without calling ensure: %j",
    async (session) => {
      vi.mocked(authFetch).mockResolvedValue(
        new Response(JSON.stringify({ session })),
      );
      expect(
        await fetchLocalBrowserSession("project", "consent", "chat-a"),
      ).toEqual(session);
      expect(authFetch).toHaveBeenCalledOnce();
      expect(authFetch).toHaveBeenCalledWith(
        "/api/mcp/computers/local-browser/lookup",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [LOCAL_CONSENT_HEADER]: "consent",
          },
          body: JSON.stringify({ projectId: "project", sessionId: "chat-a" }),
        },
      );
    },
  );
});
