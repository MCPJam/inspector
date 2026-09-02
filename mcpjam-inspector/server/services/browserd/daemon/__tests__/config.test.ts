import { describe, expect, it } from "vitest";
import {
  DEFAULT_BROWSERD_HOST,
  DEFAULT_BROWSERD_PORT,
  DEFAULT_BROWSERD_USER_DATA_DIR,
  extraArgsFor,
  formatReadyLine,
  readBrowserdConfig,
} from "../config";

const withToken = (over: Record<string, string> = {}) => ({
  MCPJAM_BROWSERD_TOKEN: "tok",
  ...over,
});

describe("readBrowserdConfig", () => {
  it("fails closed when the token is missing (public host → no open browser)", () => {
    expect(() => readBrowserdConfig({})).toThrow(/MCPJAM_BROWSERD_TOKEN is required/);
    expect(() => readBrowserdConfig({ MCPJAM_BROWSERD_TOKEN: "" })).toThrow(
      /required/,
    );
  });

  it("applies defaults for everything but the token", () => {
    const c = readBrowserdConfig(withToken());
    expect(c).toEqual({
      token: "tok",
      port: DEFAULT_BROWSERD_PORT,
      host: DEFAULT_BROWSERD_HOST,
      userDataDir: DEFAULT_BROWSERD_USER_DATA_DIR,
      headless: false,
      windowSize: undefined,
      contextMode: "persistent",
    });
  });

  it("only the exact string opts into ephemeral mode", () => {
    // A typo must not silently wipe a user's logged-in profile, so anything
    // that is not exactly "true" keeps the persistent profile.
    expect(readBrowserdConfig(withToken()).contextMode).toBe("persistent");
    for (const value of ["", "false", "TRUE", "1", "ephemeral"]) {
      expect(
        readBrowserdConfig(withToken({ MCPJAM_BROWSERD_EPHEMERAL: value }))
          .contextMode,
      ).toBe("persistent");
    }
    expect(
      readBrowserdConfig(withToken({ MCPJAM_BROWSERD_EPHEMERAL: "true" }))
        .contextMode,
    ).toBe("ephemeral");
  });

  it("reads overrides", () => {
    const c = readBrowserdConfig(
      withToken({
        MCPJAM_BROWSERD_PORT: "9000",
        MCPJAM_BROWSERD_HOST: "127.0.0.1",
        MCPJAM_BROWSERD_USER_DATA_DIR: "/tmp/profile",
        MCPJAM_BROWSERD_HEADLESS: "true",
        MCPJAM_BROWSERD_WINDOW_SIZE: "1600,1200",
      }),
    );
    expect(c).toMatchObject({
      port: 9000,
      host: "127.0.0.1",
      userDataDir: "/tmp/profile",
      headless: true,
      windowSize: "1600,1200",
    });
  });

  it("rejects a nonsensical port", () => {
    expect(() => readBrowserdConfig(withToken({ MCPJAM_BROWSERD_PORT: "0" }))).toThrow(/port/);
    expect(() => readBrowserdConfig(withToken({ MCPJAM_BROWSERD_PORT: "abc" }))).toThrow(/port/);
    expect(() => readBrowserdConfig(withToken({ MCPJAM_BROWSERD_PORT: "70000" }))).toThrow(/port/);
  });
});

describe("extraArgsFor / formatReadyLine", () => {
  it("emits a --window-size arg only when configured", () => {
    expect(extraArgsFor(readBrowserdConfig(withToken()))).toEqual([]);
    expect(
      extraArgsFor(readBrowserdConfig(withToken({ MCPJAM_BROWSERD_WINDOW_SIZE: "1600,1200" }))),
    ).toEqual(["--window-size=1600,1200"]);
  });

  it("formats a parseable ready-line carrying the bootId", () => {
    const line = formatReadyLine("0.0.0.0", 8791, "boot-xyz");
    expect(JSON.parse(line)).toEqual({
      event: "listening",
      host: "0.0.0.0",
      port: 8791,
      bootId: "boot-xyz",
    });
  });
});
