import { beforeEach, expect, it, vi } from "vitest";
const ensure = vi.hoisted(() => vi.fn());
vi.mock("../../../utils/built-in-tools/browser", () => ({
  ensureHostedConversationSession: ensure,
}));
import {
  browserFeatureUnavailable,
  provisionConversationBrowser,
} from "../chat-session-browser";
import { BrowserSessionServiceError } from "../../../services/browserd/session-service";
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
it("passes the hosted-browser gate's refusal through instead of a 422", async () => {
  // The organization lacks the beta: a 403 with the gate's own message, not
  // the BROWSER_NOT_AVAILABLE every other unexplained failure becomes.
  ensure.mockRejectedValue(
    new BrowserSessionServiceError(
      "browser session route /browser-sessions/open failed: Hosted Browser is not currently available",
      403,
      "Hosted Browser is not currently available",
      { code: "FEATURE_UNAVAILABLE", feature: "hosted-browser" },
    ),
  );
  const refusal = await provisionConversationBrowser({
    bearer: "Bearer token",
    projectId: "project",
    wireUuid: "wire",
    signal: new AbortController().signal,
  }).catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(BrowserSessionServiceError);
  expect(browserFeatureUnavailable(refusal)).toEqual({
    message: "Hosted Browser is not currently available",
    details: { code: "FEATURE_UNAVAILABLE", feature: "hosted-browser" },
  });
});
it("answers nothing for a refusal that is not the gate's", () => {
  expect(
    browserFeatureUnavailable(
      new BrowserSessionServiceError("x", 403, "Browser access refused"),
    ),
  ).toBeUndefined();
  expect(
    browserFeatureUnavailable(
      Object.assign(new Error("x"), { code: "FEATURE_UNAVAILABLE" }),
    ),
  ).toBeUndefined();
});
