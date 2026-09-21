import { beforeEach, expect, it, vi } from "vitest";
const ensure = vi.hoisted(() => vi.fn());
vi.mock("../../../utils/built-in-tools/browser", () => ({
  ensureHostedConversationSession: ensure,
}));
import { provisionConversationBrowser } from "../chat-session-browser";
import { BrowserAdmissionError } from "../../../utils/computers/browser-admission-error";
beforeEach(() => {
  ensure.mockReset();
});
it("preserves cap status and limit independently of the refusal wording", async () => {
  ensure.mockRejectedValue(
    new BrowserAdmissionError({
      error: "Close another desktop first",
      status: 409,
      code: "user_desktop_cap",
      limit: 3,
      retryAfterMs: 60000,
    }),
  );
  await expect(
    provisionConversationBrowser({
      bearer: "Bearer token",
      projectId: "project",
      wireUuid: "wire",
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({
    code: "BROWSER_CAP_EXCEEDED",
    status: 409,
    limit: 3,
    retryAfterMs: 60000,
  });
});
