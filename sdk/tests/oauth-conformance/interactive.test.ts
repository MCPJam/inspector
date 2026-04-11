const mockSpawn = jest.fn();

jest.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

import { EventEmitter } from "node:events";
import {
  createInteractiveAuthorizationSession,
  openUrlInBrowser,
} from "../../src/oauth-conformance/auth-strategies/interactive.js";

describe("interactive authorization session", () => {
  afterEach(() => {
    mockSpawn.mockReset();
  });

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

  it("opens the browser with a node-native system command", async () => {
    const child = new EventEmitter() as EventEmitter & {
      unref: jest.Mock;
    };
    child.unref = jest.fn();

    mockSpawn.mockImplementation(() => {
      process.nextTick(() => {
        child.emit("spawn");
      });
      return child;
    });

    await openUrlInBrowser("https://auth.example.com/authorize");

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(child.unref).toHaveBeenCalledTimes(1);
    const [command, args, options] = mockSpawn.mock.calls[0];

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
