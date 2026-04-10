import { createInteractiveAuthorizationSession } from "../../src/oauth-conformance/auth-strategies/interactive.js";

describe("interactive authorization session", () => {
  it("captures the authorization code from the loopback callback", async () => {
    const session = await createInteractiveAuthorizationSession();

    try {
      const resultPromise = session.authorize({
        authorizationUrl: "https://auth.example.com/authorize",
        expectedState: "expected-state",
        timeoutMs: 2_000,
        openUrl: async () => {
          await fetch(
            `${session.redirectUrl}?code=test-code&state=expected-state`,
          );
        },
      });

      await expect(resultPromise).resolves.toEqual({ code: "test-code" });
    } finally {
      await session.stop().catch(() => undefined);
    }
  });
});
