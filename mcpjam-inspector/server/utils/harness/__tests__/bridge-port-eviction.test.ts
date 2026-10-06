import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bridgePortOf,
  evictBridgePortCommand,
} from "../bridge-port-eviction.js";

/** Run the eviction the way E2B does: one shell command line. */
const evict = (port: number, graceMs = 1_000): string =>
  execFileSync("/bin/sh", ["-c", evictBridgePortCommand(port, graceMs)], {
    encoding: "utf8",
  }).trim();

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });

const canBind = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "0.0.0.0", () => server.close(() => resolve(true)));
  });

describe("evictBridgePortCommand", () => {
  it("survives the single quotes it travels in", () => {
    const command = evictBridgePortCommand(39271);
    expect(command.startsWith("node -e '")).toBe(true);
    const script = command.slice("node -e '".length, command.lastIndexOf("'"));
    expect(script).not.toContain("'");
    expect(command.endsWith("' 39271 3000")).toBe(true);
  });

  it("refuses anything that is not a port", () => {
    for (const port of [0, -1, 65_536, 1.5, Number.NaN]) {
      expect(() => evictBridgePortCommand(port)).toThrow("not a TCP port");
    }
  });

  it("does nothing, and says nothing, when the port is free", async () => {
    // Also the whole story on a box without /proc: nothing to read, no-op.
    expect(evict(await freePort())).toBe("");
  });
});

describe("bridgePortOf", () => {
  it("reads the port a bridge spawn is about to bind", () => {
    expect(bridgePortOf({ BRIDGE_WS_PORT: "39271", OTHER: "x" })).toBe(39271);
  });

  it("is undefined for any other spawn", () => {
    expect(bridgePortOf(undefined)).toBeUndefined();
    expect(bridgePortOf({})).toBeUndefined();
    expect(bridgePortOf({ BRIDGE_WS_PORT: "" })).toBeUndefined();
    expect(bridgePortOf({ BRIDGE_WS_PORT: "39271; rm -rf ~" })).toBeUndefined();
    expect(bridgePortOf({ BRIDGE_WS_PORT: "70000" })).toBeUndefined();
  });
});

// The script reads Linux's /proc, so the real eviction only runs there (CI).
describe.runIf(process.platform === "linux")("against a real listener", () => {
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const child of children.splice(0)) child.kill("SIGKILL");
  });

  /** A process named like a bridge (or not) that holds `port`. */
  const listener = async (
    fileName: string,
    port: number,
    script = "",
  ): Promise<ChildProcess> => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-eviction-"));
    const file = join(dir, fileName);
    // A dynamic import, so the same body runs as `bridge.mjs` and as `.js`.
    writeFileSync(
      file,
      `${script}
      import("node:net").then(({ default: net }) =>
        net.createServer().listen(Number(process.argv[2]), "0.0.0.0", () => console.log("ready")));`,
    );
    const child = spawn(process.execPath, [file, String(port)], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      child.once("exit", (code) => reject(new Error(`exited ${code}`)));
      child.stdout!.once("data", () => resolve());
    });
    return child;
  };

  const exited = (child: ChildProcess): Promise<NodeJS.Signals | null> =>
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve(child.signalCode)
      : new Promise((resolve) =>
          child.once("exit", (_code, sig) => resolve(sig)),
        );

  it("stops the bridge holding the port and frees it for the next one", async () => {
    const port = await freePort();
    const bridge = await listener("bridge.mjs", port);

    expect(evict(port)).toBe(String(bridge.pid));
    expect(await exited(bridge)).toBe("SIGTERM");
    expect(await canBind(port)).toBe(true);
  });

  it("kills a bridge that ignores SIGTERM once the grace runs out", async () => {
    const port = await freePort();
    const bridge = await listener(
      "bridge.mjs",
      port,
      `process.on("SIGTERM", () => {});`,
    );

    expect(evict(port, 300)).toBe(String(bridge.pid));
    expect(await exited(bridge)).toBe("SIGKILL");
    expect(await canBind(port)).toBe(true);
  });

  it("leaves a process that is not a bridge alone, even on the bridge port", async () => {
    const port = await freePort();
    const other = await listener("dev-server.js", port);

    expect(evict(port)).toBe("");
    expect(other.exitCode).toBeNull();
    expect(other.signalCode).toBeNull();
    expect(await canBind(port)).toBe(false);
  });

  it("leaves a bridge on another port alone", async () => {
    const [mine, theirs] = [await freePort(), await freePort()];
    const other = await listener("bridge.mjs", theirs);

    expect(evict(mine)).toBe("");
    expect(other.exitCode).toBeNull();
    expect(other.signalCode).toBeNull();
  });
});
