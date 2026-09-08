import { describe, expect, it } from "vitest";
import {
  DEFAULT_BROWSERD_HOST,
  DEFAULT_BROWSERD_PORT,
  DEFAULT_BROWSERD_RECORD_MAX_BYTES,
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
    expect(() => readBrowserdConfig({})).toThrow(
      /MCPJAM_BROWSERD_TOKEN is required/,
    );
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
      // Video needs the browser to fill the display, and that is opt-in: a box
      // booted without it refuses video rather than streaming a picture whose
      // coordinates do not match the page.
      kiosk: false,
      // 1 unless the box says otherwise. Raising it is a MEASUREMENT, not a
      // promise — see the wave's DPR gate.
      deviceScaleFactor: 1,
      // Recordings live beside the profile, capped below the evidence pipe's
      // own 64 MiB limit: a file past it can only be dropped at upload time,
      // which is the one moment the evidence cannot be re-made.
      recordDir: `${DEFAULT_BROWSERD_USER_DATA_DIR}/recordings`,
      recordMaxBytes: DEFAULT_BROWSERD_RECORD_MAX_BYTES,
      recordingEnabled: true,
      // An inspector replica handed us a token; nothing was minted here.
      startedBy: "inspector",
    });
  });

  it("puts recordings under a user data dir the box chose", () => {
    const c = readBrowserdConfig(
      withToken({ MCPJAM_BROWSERD_USER_DATA_DIR: "/data/profile" }),
    );
    expect(c.recordDir).toBe("/data/profile/recordings");
    expect(
      readBrowserdConfig(
        withToken({ MCPJAM_BROWSERD_RECORD_DIR: "/evidence" }),
      ).recordDir,
    ).toBe("/evidence");
  });

  it("only the exact string turns recording off", () => {
    // A typo must not silently cost a run its evidence — the same rule every
    // other switch here follows.
    expect(readBrowserdConfig(withToken()).recordingEnabled).toBe(true);
    expect(
      readBrowserdConfig(withToken({ MCPJAM_BROWSERD_RECORD: "0" }))
        .recordingEnabled,
    ).toBe(false);
    expect(
      readBrowserdConfig(withToken({ MCPJAM_BROWSERD_RECORD: "false" }))
        .recordingEnabled,
    ).toBe(true);
  });

  it("never lets the size cap exceed what the evidence pipe can accept", () => {
    // Lenient about nonsense (a mistyped variable must not cost the run its
    // browser) and strict about the ceiling (a value past it produces a file
    // nothing can accept).
    expect(
      readBrowserdConfig(
        withToken({ MCPJAM_BROWSERD_RECORD_MAX_BYTES: "1048576" }),
      ).recordMaxBytes,
    ).toBe(1_048_576);
    for (const raw of ["", "lots", "-5", "0", String(1024 ** 4)]) {
      expect(
        readBrowserdConfig(
          withToken({ MCPJAM_BROWSERD_RECORD_MAX_BYTES: raw }),
        ).recordMaxBytes,
        `raw=${raw}`,
      ).toBe(DEFAULT_BROWSERD_RECORD_MAX_BYTES);
    }
  });

  it("mints a token into a file when the box started this daemon", () => {
    // The prelaunch case: a daemon baked into the image has no inspector to
    // hand it a secret. Minting one is not a weakening of the rule above — it
    // is still 32 random bytes, and it still only ever travels over the E2B
    // files API, which is authenticated with the team's own key.
    const written: Array<{ path: string; token: string }> = [];
    const config = readBrowserdConfig(
      {
        MCPJAM_BROWSERD_TOKEN_FILE: "/home/user/.mcpjam-browserd.token",
      } as NodeJS.ProcessEnv,
      (path) => {
        const token = "minted-token";
        written.push({ path, token });
        return token;
      },
    );
    expect(config.token).toBe("minted-token");
    expect(config.tokenFile).toBe("/home/user/.mcpjam-browserd.token");
    expect(config.startedBy).toBe("prelaunch");
    expect(written).toEqual([
      { path: "/home/user/.mcpjam-browserd.token", token: "minted-token" },
    ]);
  });

  it("prefers a supplied token over minting one", () => {
    // A box that was ALSO booted by an inspector must use the inspector's
    // secret: minting over it would leave the replica holding a bearer the
    // daemon no longer accepts, and every command would 401.
    let minted = 0;
    const config = readBrowserdConfig(
      withToken({ MCPJAM_BROWSERD_TOKEN_FILE: "/tmp/tok" }),
      () => {
        minted += 1;
        return "minted";
      },
    );
    expect(config.token).toBe("tok");
    expect(config.startedBy).toBe("inspector");
    expect(minted).toBe(0);
  });

  it("still refuses to start with no token and no file to mint into", () => {
    expect(() => readBrowserdConfig({} as NodeJS.ProcessEnv)).toThrow(
      /MCPJAM_BROWSERD_TOKEN is required/,
    );
  });

  it("reads the device scale factor, and refuses nonsense rather than the boot", () => {
    const dpr = (value: string) =>
      readBrowserdConfig(withToken({ MCPJAM_BROWSERD_DPR: value }))
        .deviceScaleFactor;
    expect(dpr("1.5")).toBe(1.5);
    expect(dpr("2")).toBe(2);
    // A sharpness knob is not worth refusing to boot a browser over.
    for (const bad of ["", "x", "0", "-1", "9"]) expect(dpr(bad)).toBe(1);
  });

  it("refuses kiosk on a headless browser, which has no display to fill", () => {
    // Kiosk is what makes "the display IS the page" true for the encoder, and
    // a headless Chromium draws on no display at all — so the daemon would
    // advertise `h264`, grab an empty X screen, and hand every watcher a
    // picture of nothing.
    expect(
      readBrowserdConfig(
        withToken({
          MCPJAM_BROWSERD_KIOSK: "1",
          MCPJAM_BROWSERD_HEADLESS: "true",
        }),
      ).kiosk,
    ).toBe(false);
  });

  it("kiosk is the exact string, like every other opt-in here", () => {
    expect(readBrowserdConfig(withToken()).kiosk).toBe(false);
    expect(
      readBrowserdConfig(withToken({ MCPJAM_BROWSERD_KIOSK: "1" })).kiosk,
    ).toBe(true);
    expect(
      readBrowserdConfig(withToken({ MCPJAM_BROWSERD_KIOSK: "true" })).kiosk,
    ).toBe(false);
  });

  it("kiosk args make the window cover the display", () => {
    // The encoder grabs the WHOLE display, so "the display IS the page" only
    // holds if the window fills it with no chrome. Without this the grab is a
    // desktop with a browser somewhere on it, and every click the pane mapped
    // would be off by the window's origin.
    const args = extraArgsFor(
      readBrowserdConfig(withToken({ MCPJAM_BROWSERD_KIOSK: "1" })),
    );
    expect(args).toContain("--kiosk");
    expect(args).toContain("--window-position=0,0");
  });

  it("raises the scale factor only for a persistent profile", () => {
    // An ephemeral context is an eval or a swarm iteration, where a screenshot
    // on one host has to match one on another (L5). Its scale factor stays 1
    // whatever the box is configured for.
    const persistent = readBrowserdConfig(
      withToken({ MCPJAM_BROWSERD_DPR: "2" }),
    );
    expect(extraArgsFor(persistent)).toContain("--force-device-scale-factor=2");
    const ephemeral = readBrowserdConfig(
      withToken({
        MCPJAM_BROWSERD_DPR: "2",
        MCPJAM_BROWSERD_EPHEMERAL: "true",
      }),
    );
    expect(extraArgsFor(ephemeral).join(" ")).not.toContain(
      "force-device-scale-factor",
    );
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
    expect(() =>
      readBrowserdConfig(withToken({ MCPJAM_BROWSERD_PORT: "0" })),
    ).toThrow(/port/);
    expect(() =>
      readBrowserdConfig(withToken({ MCPJAM_BROWSERD_PORT: "abc" })),
    ).toThrow(/port/);
    expect(() =>
      readBrowserdConfig(withToken({ MCPJAM_BROWSERD_PORT: "70000" })),
    ).toThrow(/port/);
  });
});

describe("extraArgsFor / formatReadyLine", () => {
  it("emits a --window-size arg only when configured", () => {
    expect(extraArgsFor(readBrowserdConfig(withToken()))).toEqual([]);
    expect(
      extraArgsFor(
        readBrowserdConfig(
          withToken({ MCPJAM_BROWSERD_WINDOW_SIZE: "1600,1200" }),
        ),
      ),
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
