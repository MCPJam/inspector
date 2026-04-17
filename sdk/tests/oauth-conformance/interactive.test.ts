const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: childProcessMocks.spawn,
}));

import { EventEmitter } from "node:events";
import {
  createInteractiveAuthorizationSession,
  openUrlInBrowser,
} from "../../src/oauth-conformance/auth-strategies/interactive.js";

describe("interactive authorization session", () => {
  afterEach(() => {
    childProcessMocks.spawn.mockReset();
  });

  it("captures the authorization code from the loopback callback", async () => {
    const session = await createInteractiveAuthorizationSession();

    try {
      const resultPromise = session.authorize({
        authorizationUrl: "https://auth.example.com/authorize",
        expectedState: "expected-state",
        timeoutMs: 2_000,
        openUrl: async () => {
          const response = await fetch(
            `${session.redirectUrl}?code=test-code&state=expected-state`
          );
          expect(response.status).toBe(200);
          expect(response.headers.get("content-type")).toContain("text/html");

          const html = await response.text();
          expect(html).toContain("Authorization complete");
          expect(html).toContain("Return to the terminal to continue.");
        },
      });

      await expect(resultPromise).resolves.toEqual({ code: "test-code" });
    } finally {
      await session.stop().catch(() => undefined);
    }
  });

  it("accepts custom loopback callback paths", async () => {
    const session = await createInteractiveAuthorizationSession({
      redirectUrl: "http://127.0.0.1:0/oauth/custom-callback",
    });

    try {
      expect(session.redirectUrl).toMatch(/\/oauth\/custom-callback$/);

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

  it("surfaces OAuth error responses from the callback without waiting for timeout", async () => {
    const session = await createInteractiveAuthorizationSession();

    try {
      const resultPromise = session.authorize({
        authorizationUrl: "https://auth.example.com/authorize",
        timeoutMs: 10_000,
        openUrl: async () => {
          const response = await fetch(
            `${session.redirectUrl}?error=access_denied&error_description=User+rejected+%3Caccess%3E`
          );
          expect(response.status).toBe(400);
          expect(response.headers.get("content-type")).toContain("text/html");

          const html = await response.text();
          expect(html).toContain("Authorization failed");
          expect(html).toContain("Return to the terminal for details.");
          expect(html).toContain("access_denied: User rejected &lt;access&gt;");
        },
      });

      await expect(resultPromise).rejects.toThrow(
        /access_denied: User rejected <access>/
      );
    } finally {
      await session.stop().catch(() => undefined);
    }
  });

  it("rejects callbacks missing both code and error without hanging", async () => {
    const session = await createInteractiveAuthorizationSession();

    try {
      const resultPromise = session.authorize({
        authorizationUrl: "https://auth.example.com/authorize",
        timeoutMs: 10_000,
        openUrl: async () => {
          const response = await fetch(`${session.redirectUrl}?state=no-code`);
          expect(response.status).toBe(400);
          expect(response.headers.get("content-type")).toContain("text/html");

          const html = await response.text();
          expect(html).toContain("Authorization incomplete");
          expect(html).toContain(
            "No authorization code was included in the callback."
          );
        },
      });

      await expect(resultPromise).rejects.toThrow(
        /without a code or error parameter/
      );
    } finally {
      await session.stop().catch(() => undefined);
    }
  });

  it("returns an error page when the callback state does not match", async () => {
    const session = await createInteractiveAuthorizationSession();

    try {
      const resultPromise = session.authorize({
        authorizationUrl: "https://auth.example.com/authorize",
        expectedState: "expected-state",
        timeoutMs: 10_000,
        openUrl: async () => {
          const response = await fetch(
            `${session.redirectUrl}?code=test-code&state=wrong-state`
          );
          expect(response.status).toBe(400);
          expect(response.headers.get("content-type")).toContain("text/html");

          const html = await response.text();
          expect(html).toContain("Authorization failed");
          expect(html).toContain("Authorization state mismatch.");
          expect(html).not.toContain("Authorization complete");
        },
      });

      await expect(resultPromise).rejects.toThrow(
        /Authorization state mismatch/
      );
    } finally {
      await session.stop().catch(() => undefined);
    }
  });

  it("opens the browser with a node-native system command", async () => {
    const child = new EventEmitter() as EventEmitter & {
      unref: jest.Mock;
    };
    child.unref = vi.fn();

    childProcessMocks.spawn.mockImplementation(() => {
      process.nextTick(() => {
        child.emit("spawn");
      });
      return child;
    });

    await openUrlInBrowser("https://auth.example.com/authorize");

    expect(childProcessMocks.spawn).toHaveBeenCalledTimes(1);
    expect(child.unref).toHaveBeenCalledTimes(1);
    const [command, args, options] = childProcessMocks.spawn.mock.calls[0];

    if (process.platform === "darwin") {
      expect(command).toBe("open");
      expect(args).toEqual(["https://auth.example.com/authorize"]);
    } else if (process.platform === "win32") {
      expect(command).toBe("cmd");
      expect(args).toEqual([
        "/c",
        "start",
        "",
        "https://auth.example.com/authorize",
      ]);
    } else {
      expect(command).toBe("xdg-open");
      expect(args).toEqual(["https://auth.example.com/authorize"]);
    }

    expect(options).toMatchObject({
      detached: true,
      stdio: "ignore",
    });
  });
});
