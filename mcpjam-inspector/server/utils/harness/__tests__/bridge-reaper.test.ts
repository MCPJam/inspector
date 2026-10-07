import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bridgeStateDirOf,
  isBridgeSpawn,
  reapHarnessBridgesCommand,
} from "../bridge-reaper.js";

/** Run the reaper the way E2B does: one shell command line. */
const reap = (ownStateDir: string, graceMs = 1_000): string =>
  execFileSync(
    "/bin/sh",
    ["-c", reapHarnessBridgesCommand(ownStateDir, graceMs)],
    { encoding: "utf8" },
  ).trim();

describe("reapHarnessBridgesCommand", () => {
  it("survives the single quotes it travels in", () => {
    const command = reapHarnessBridgesCommand(
      "/home/user/.agent-runs/s-1/bridge",
    );
    expect(command.startsWith("node -e '")).toBe(true);
    const script = command.slice("node -e '".length, command.indexOf("' '"));
    expect(script).not.toContain("'");
    // The bridge's own state dir, then its sessions root, then the grace.
    expect(
      command.endsWith(
        "' '/home/user/.agent-runs/s-1/bridge' '/home/user/.agent-runs/' 3000",
      ),
    ).toBe(true);
  });

  it("quotes a state dir that would otherwise break out of its argument", () => {
    expect(reapHarnessBridgesCommand("/tmp/it's; rm -rf ~")).toContain(
      `'/tmp/it'\\''s; rm -rf ~'`,
    );
  });

  it("does nothing, and says nothing, when no bridge is running", () => {
    // Also the whole story on a box without /proc: nothing to read, no-op.
    expect(reap(join(tmpdir(), "no-such-root", "s-1", "bridge"))).toBe("");
  });

  it("refuses a state dir it cannot scope", () => {
    expect(() => reapHarnessBridgesCommand("relative/bridge")).toThrow(
      "not an absolute bridge state dir",
    );
  });
});

describe("isBridgeSpawn", () => {
  it("recognises a bridge by the port it is told to bind", () => {
    expect(isBridgeSpawn({ BRIDGE_WS_PORT: "0", OTHER: "x" })).toBe(true);
    expect(isBridgeSpawn({})).toBe(false);
    expect(isBridgeSpawn(undefined)).toBe(false);
  });
});

describe("bridgeStateDirOf", () => {
  it("reads the state dir the adapters' shellQuote wrote", () => {
    expect(
      bridgeStateDirOf(
        "node '/home/user/.b/bridge.mjs' --workdir '/home/user/w' " +
          "--bridge-state-dir '/home/user/.agent-runs/s-1/bridge' --session-data-dir '/x'",
      ),
    ).toBe("/home/user/.agent-runs/s-1/bridge");
  });

  it("undoes the quoting of an embedded single quote", () => {
    expect(
      bridgeStateDirOf(`node b/bridge.mjs --bridge-state-dir '/tmp/it'\\''s'`),
    ).toBe("/tmp/it's");
  });

  it("is undefined for a command without one", () => {
    expect(bridgeStateDirOf("tail -f /dev/null")).toBeUndefined();
  });
});

// The script reads Linux's /proc, so the real reaping only runs there (CI).
describe.runIf(process.platform === "linux")("against real bridges", () => {
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const child of children.splice(0)) child.kill("SIGKILL");
  });
  const root = () => mkdtempSync(join(tmpdir(), "bridge-reaper-"));

  /**
   * A process shaped like a bridge — `…/bridge.mjs --bridge-state-dir <dir>`
   * — whose `bridge-meta.json` records `state` (and its own pid, as
   * `runBridge` does, unless `metaPid` says otherwise).
   */
  const bridge = async (
    stateDir: string,
    state: string | null,
    {
      fileName = "bridge.mjs",
      script = "",
      metaPid,
    }: {
      fileName?: string;
      script?: string;
      metaPid?: number;
    } = {},
  ): Promise<ChildProcess> => {
    mkdirSync(stateDir, { recursive: true });
    const file = join(stateDir, "..", fileName);
    // "ready" only once any signal handler in `script` is installed.
    writeFileSync(
      file,
      `${script}\nsetInterval(() => {}, 1 << 30);\nconsole.log("ready");\n`,
    );
    const child = spawn(
      process.execPath,
      [file, "--workdir", "/tmp", "--bridge-state-dir", stateDir],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once("data", () => resolve());
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`exited ${code}`)));
    });
    if (state !== null) {
      writeFileSync(
        join(stateDir, "bridge-meta.json"),
        JSON.stringify({
          type: "claude-code",
          port: 4100,
          state,
          pid: metaPid ?? child.pid,
        }),
      );
    }
    return child;
  };

  const running = (child: ChildProcess) =>
    child.exitCode === null && child.signalCode === null;
  const exited = (child: ChildProcess): Promise<NodeJS.Signals | null> =>
    running(child)
      ? new Promise((resolve) =>
          child.once("exit", (_code, sig) => resolve(sig)),
        )
      : Promise.resolve(child.signalCode);

  it("A pauses on an approval, B starts: A's bridge survives for the decision", async () => {
    const dir = root();
    const paused = await bridge(join(dir, "chat-a", "bridge"), "running");

    expect(reap(join(dir, "chat-b", "bridge"))).toBe("");
    expect(running(paused)).toBe(true);
  });

  it("stops another chat's bridge that is between turns", async () => {
    const dir = root();
    const idle = await bridge(join(dir, "chat-a", "bridge"), "waiting");
    const paused = await bridge(join(dir, "chat-c", "bridge"), "running");

    expect(reap(join(dir, "chat-b", "bridge"))).toBe(String(idle.pid));
    expect(await exited(idle)).toBe("SIGTERM");
    expect(running(paused)).toBe(true);
  });

  it("stops the spawning chat's own older bridge, even one paused on an approval", async () => {
    // The user sent a new message instead of deciding: the approval is void
    // and the new bridge supersedes the old one.
    const dir = root();
    const own = join(dir, "chat-a", "bridge");
    const old = await bridge(own, "running");

    expect(reap(own)).toBe(String(old.pid));
    expect(await exited(old)).toBe("SIGTERM");
  });

  it("stops a bridge its own session has since replaced", async () => {
    const dir = root();
    const replaced = await bridge(join(dir, "chat-a", "bridge"), "running", {
      metaPid: 999_999,
    });

    expect(reap(join(dir, "chat-b", "bridge"))).toBe(String(replaced.pid));
    expect(await exited(replaced)).toBe("SIGTERM");
  });

  it("keeps a bridge whose state it cannot read", async () => {
    const dir = root();
    const unknown = await bridge(join(dir, "chat-a", "bridge"), null);

    expect(reap(join(dir, "chat-b", "bridge"))).toBe("");
    expect(running(unknown)).toBe(true);
  });

  it("leaves a bridge outside this computer's sessions root alone", async () => {
    const elsewhere = await bridge(join(root(), "chat-a", "bridge"), "waiting");

    expect(reap(join(root(), "chat-b", "bridge"))).toBe("");
    expect(running(elsewhere)).toBe(true);
  });

  it("leaves a process that is not a bridge alone", async () => {
    const dir = root();
    const other = await bridge(join(dir, "dev", "bridge"), "waiting", {
      fileName: "dev-server.js",
    });

    expect(reap(join(dir, "chat-b", "bridge"))).toBe("");
    expect(running(other)).toBe(true);
  });

  it("kills a bridge that ignores SIGTERM once the grace runs out", async () => {
    const dir = root();
    const stubborn = await bridge(join(dir, "chat-a", "bridge"), "waiting", {
      script: `process.on("SIGTERM", () => {});`,
    });

    expect(reap(join(dir, "chat-b", "bridge"), 300)).toBe(String(stubborn.pid));
    expect(await exited(stubborn)).toBe("SIGKILL");
  });
});
