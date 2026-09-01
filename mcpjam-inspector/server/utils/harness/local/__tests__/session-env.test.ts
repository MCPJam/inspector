import { describe, expect, it } from "vitest";
import {
  LOCAL_HARNESS_ENV_ALLOWLIST,
  LocalHarnessEnvError,
  buildLocalHarnessEnv,
  syntheticHomeDirectories,
} from "../session-env.js";

const HOME = "/state/sessions/s1/home";
const ROOT = "/home/dev/project";

/** A parent environment shaped like a real Inspector process: locale and
 *  terminal alongside every credential a server holds. */
const PARENT: NodeJS.ProcessEnv = {
  LANG: "en_US.UTF-8",
  TERM: "xterm-256color",
  PATH: "/home/dev/.nvm/versions/node/v22/bin:/home/dev/project/node_modules/.bin:/usr/bin",
  HOME: "/home/dev",
  ANTHROPIC_API_KEY: "sk-ant-canary",
  AI_GATEWAY_API_KEY: "gw-canary",
  INSPECTOR_SERVICE_TOKEN: "svc-canary",
  E2B_API_KEY: "e2b-canary",
  AWS_SECRET_ACCESS_KEY: "aws-canary",
  DATABASE_URL: "postgres://canary",
  GITHUB_TOKEN: "gh-canary",
  NPM_TOKEN: "npm-canary",
  SSH_AUTH_SOCK: "/tmp/ssh-canary",
};

describe("the child environment is an allowlist", () => {
  const env = buildLocalHarnessEnv({
    syntheticHome: HOME,
    sessionRoot: ROOT,
    platform: "linux",
    base: PARENT,
  });

  it("carries no credential from the parent", () => {
    const serialized = JSON.stringify(env);
    for (const canary of [
      "sk-ant-canary",
      "gw-canary",
      "svc-canary",
      "e2b-canary",
      "aws-canary",
      "postgres://canary",
      "gh-canary",
      "npm-canary",
      "/tmp/ssh-canary",
    ]) {
      expect(serialized).not.toContain(canary);
    }
  });

  it("points HOME at the synthetic root, never the user's real home", () => {
    expect(env.HOME).toBe(HOME);
    expect(env.HOME).not.toBe(PARENT.HOME);
  });

  it("builds PATH instead of inheriting the user's", () => {
    // Inheriting would hand the child every version-manager shim and
    // project-local `node_modules/.bin` on the user's PATH.
    expect(env.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
    expect(env.PATH).not.toContain("node_modules");
    expect(env.PATH).not.toContain(".nvm");
  });

  it("redirects every conventional config and cache path into the session", () => {
    expect(env.XDG_CONFIG_HOME).toBe(`${HOME}/.config`);
    expect(env.XDG_CACHE_HOME).toBe(`${HOME}/.cache`);
    expect(env.XDG_DATA_HOME).toBe(`${HOME}/.local/share`);
    expect(env.XDG_STATE_HOME).toBe(`${HOME}/.local/state`);
    expect(env.TMPDIR).toBe(`${HOME}/tmp`);
  });

  it("keeps the locale and terminal shape a vendor CLI needs", () => {
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.TERM).toBe("xterm-256color");
  });

  it("tells the CLI it has no interactive terminal", () => {
    expect(env.CI).toBe("1");
    expect(env.NO_COLOR).toBe("1");
  });

  it("exposes an exactly-known key set", () => {
    expect(Object.keys(env).sort()).toEqual(
      [
        "CI",
        "HOME",
        "LANG",
        "NO_COLOR",
        "PATH",
        "PWD",
        "TERM",
        "TMPDIR",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
      ].sort()
    );
  });

  it("locks the allowlist so an addition is a reviewed edit", () => {
    expect(LOCAL_HARNESS_ENV_ALLOWLIST).not.toContain("PATH");
    expect(LOCAL_HARNESS_ENV_ALLOWLIST).not.toContain("HOME");
    expect(LOCAL_HARNESS_ENV_ALLOWLIST).toEqual([
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
      "TERM",
      "TZ",
      "COLORTERM",
      "SYSTEMROOT",
      "SYSTEMDRIVE",
      "WINDIR",
      "COMSPEC",
      "PATHEXT",
      "NUMBER_OF_PROCESSORS",
      "PROCESSOR_ARCHITECTURE",
    ]);
  });
});

describe("scoped values", () => {
  it("adds the session's gateway endpoint and capability", () => {
    const env = buildLocalHarnessEnv({
      syntheticHome: HOME,
      sessionRoot: ROOT,
      platform: "linux",
      base: PARENT,
      scoped: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:39271/gateway",
        ANTHROPIC_AUTH_TOKEN: "session-capability",
      },
    });
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:39271/gateway");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("session-capability");
  });

  it.each([
    "PATH",
    "HOME",
    "NODE_OPTIONS",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
  ])("refuses to let a caller inject %s", (name) => {
    expect(() =>
      buildLocalHarnessEnv({
        syntheticHome: HOME,
        sessionRoot: ROOT,
        platform: "linux",
        base: PARENT,
        scoped: { [name]: "/evil" },
      })
    ).toThrow(LocalHarnessEnvError);
  });

  it("refuses a control character in a scoped value", () => {
    expect(() =>
      buildLocalHarnessEnv({
        syntheticHome: HOME,
        sessionRoot: ROOT,
        base: PARENT,
        scoped: { TOKEN: "a\nB=c" },
      })
    ).toThrow(/control character/);
  });

  it("refuses a scoped name that is not an environment variable name", () => {
    expect(() =>
      buildLocalHarnessEnv({
        syntheticHome: HOME,
        sessionRoot: ROOT,
        base: PARENT,
        scoped: { "A-B": "x" },
      })
    ).toThrow(LocalHarnessEnvError);
  });
});

describe("windows", () => {
  it("redirects the Windows profile paths too", () => {
    const env = buildLocalHarnessEnv({
      syntheticHome: "C:\\state\\home",
      sessionRoot: "C:\\project",
      platform: "win32",
      base: { SYSTEMROOT: "C:\\Windows" },
    });
    expect(env.USERPROFILE).toBe("C:\\state\\home");
    expect(env.PATH).toContain("C:\\Windows\\System32");
  });
});

describe("preconditions", () => {
  it("requires absolute paths", () => {
    expect(() =>
      buildLocalHarnessEnv({ syntheticHome: "home", sessionRoot: ROOT })
    ).toThrow(/absolute/);
    expect(() =>
      buildLocalHarnessEnv({ syntheticHome: HOME, sessionRoot: "project" })
    ).toThrow(/absolute/);
  });

  it("lists the directories the synthetic home needs up front", () => {
    expect(syntheticHomeDirectories(HOME, "linux")).toEqual([
      HOME,
      `${HOME}/tmp`,
      `${HOME}/.config`,
      `${HOME}/.cache`,
      `${HOME}/.local/share`,
      `${HOME}/.local/state`,
    ]);
  });
});
