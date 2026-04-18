import { beforeEach, describe, expect, it, vi } from "vitest";

const authFetchMock = vi.hoisted(() => vi.fn());
const getGuestBearerTokenMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: false,
}));

vi.mock("@/lib/session-token", () => ({
  authFetch: (...args: unknown[]) => authFetchMock(...args),
  getSessionToken: () => null,
}));

vi.mock("@/lib/guest-session", () => ({
  getGuestBearerToken: (...args: unknown[]) => getGuestBearerTokenMock(...args),
}));

import {
  runInlineEvalTestCaseGuest,
  streamInlineEvalTestCaseGuest,
} from "../evals-api";

describe("evals-api local guest mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getGuestBearerTokenMock.mockResolvedValue(null);
  });

  it("fails fast when local guest inline run cannot obtain a guest token", async () => {
    await expect(
      runInlineEvalTestCaseGuest({
        serverNameOrId: "server-a",
        model: "claude-haiku-4.5",
        provider: "anthropic",
        test: {
          title: "Guest inline run",
          query: "hello",
        },
      }),
    ).rejects.toThrow(
      "Could not obtain a guest session. Try refreshing the page.",
    );

    expect(getGuestBearerTokenMock).toHaveBeenCalledTimes(1);
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it("fails fast when local guest inline streaming cannot obtain a guest token", async () => {
    await expect(
      streamInlineEvalTestCaseGuest(
        {
          serverNameOrId: "server-a",
          model: "claude-haiku-4.5",
          provider: "anthropic",
          test: {
            title: "Guest inline stream",
            query: "hello",
          },
        },
        vi.fn(),
      ),
    ).rejects.toThrow(
      "Could not obtain a guest session. Try refreshing the page.",
    );

    expect(getGuestBearerTokenMock).toHaveBeenCalledTimes(1);
    expect(authFetchMock).not.toHaveBeenCalled();
  });
});
