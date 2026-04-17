import { createRemoteBrowserAuthorizationController } from "../../src/oauth-conformance/auth-strategies/remote-browser.js";

describe("createRemoteBrowserAuthorizationController", () => {
  it("surfaces the authorization URL when the runner asks and resolves on deliverCode", async () => {
    const controller = createRemoteBrowserAuthorizationController({
      redirectUrl: "https://inspector.example/oauth/callback",
    });

    const session = await controller.createSession();
    expect(session.redirectUrl).toBe("https://inspector.example/oauth/callback");

    const authorizePromise = session.authorize({
      authorizationUrl: "https://auth.example/authorize?state=abc",
      expectedState: "abc",
      timeoutMs: 5_000,
    });

    await expect(controller.awaitAuthorizationUrl).resolves.toEqual({
      authorizationUrl: "https://auth.example/authorize?state=abc",
      expectedState: "abc",
    });

    controller.deliverCode({ code: "good-code", state: "abc" });

    await expect(authorizePromise).resolves.toEqual({ code: "good-code" });
  });

  it("rejects authorize with a state mismatch when state is wrong", async () => {
    const controller = createRemoteBrowserAuthorizationController({
      redirectUrl: "https://inspector.example/oauth/callback",
    });
    const session = await controller.createSession();

    const authorizePromise = session.authorize({
      authorizationUrl: "https://auth.example/authorize",
      expectedState: "expected",
      timeoutMs: 5_000,
    });

    controller.deliverCode({ code: "c", state: "wrong" });

    await expect(authorizePromise).rejects.toThrow(/state mismatch/i);
  });

  it("propagates fail() to a pending authorize", async () => {
    const controller = createRemoteBrowserAuthorizationController({
      redirectUrl: "https://inspector.example/oauth/callback",
    });
    const session = await controller.createSession();

    const authorizePromise = session.authorize({
      authorizationUrl: "https://auth.example/authorize",
      timeoutMs: 5_000,
    });

    controller.fail(new Error("user cancelled"));

    await expect(authorizePromise).rejects.toThrow("user cancelled");
  });

  it("rejects awaitAuthorizationUrl when fail() is called before the runner asks", async () => {
    const controller = createRemoteBrowserAuthorizationController({
      redirectUrl: "https://inspector.example/oauth/callback",
    });

    controller.fail(new Error("boom"));

    await expect(controller.awaitAuthorizationUrl).rejects.toThrow("boom");
  });

  it("times out the pending authorize using codeTimeoutMs when provided", async () => {
    vi.useFakeTimers();
    try {
      const controller = createRemoteBrowserAuthorizationController({
        redirectUrl: "https://inspector.example/oauth/callback",
        codeTimeoutMs: 100,
      });
      const session = await controller.createSession();
      const authorizePromise = session.authorize({
        authorizationUrl: "https://auth.example/authorize",
        timeoutMs: 9_999_999, // would otherwise dominate
      });

      vi.advanceTimersByTime(200);

      await expect(authorizePromise).rejects.toThrow(/timed out after 100/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires a redirectUrl", () => {
    expect(() =>
      createRemoteBrowserAuthorizationController({ redirectUrl: "" }),
    ).toThrow(/redirectUrl is required/);
  });
});
