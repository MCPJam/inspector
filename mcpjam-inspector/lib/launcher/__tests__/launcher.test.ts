import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ spawn: spawnMock }));

import { launchInspector } from "../index";

class FakeChild extends EventEmitter {
  stderr: PassThrough | null;
  kill = vi.fn();
  constructor(withStderr: boolean) {
    super();
    this.stderr = withStderr ? new PassThrough() : null;
  }
}

function fakeSpawn() {
  let child: FakeChild | undefined;
  spawnMock.mockImplementation(
    (_cmd: string, _args: string[], opts: { stdio: unknown }) => {
      child = new FakeChild(Array.isArray(opts.stdio));
      return child;
    },
  );
  return () => {
    if (!child) throw new Error("spawn was not called");
    return child;
  };
}

function spawnOptions() {
  return spawnMock.mock.calls[0][2] as {
    stdio: unknown;
    env: Record<string, string>;
  };
}

describe("launchInspector", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    vi.stubEnv("MCPJAM_SESSION_TOKEN", undefined);
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("shares the terminal by default", async () => {
    fakeSpawn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    await launchInspector();

    expect(spawnOptions().stdio).toBe("inherit");
  });

  it("keeps output out of the terminal when silent", async () => {
    fakeSpawn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    await launchInspector({ silent: true });

    expect(spawnOptions().stdio).toEqual(["ignore", "ignore", "pipe"]);
  });

  it("returns a link carrying the session token it gave the inspector", async () => {
    fakeSpawn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const inspector = await launchInspector({ defaultTab: "chat" });

    const token = spawnOptions().env.MCPJAM_SESSION_TOKEN;
    expect(token).toMatch(/^[A-Za-z0-9_-]{24,}$/);
    expect(inspector.url).toBe(
      `http://localhost:6274/#token=${token}&tab=chat-v2`,
    );
  });

  it("reuses a session token from the environment", async () => {
    const token = "a".repeat(32);
    vi.stubEnv("MCPJAM_SESSION_TOKEN", token);
    fakeSpawn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const inspector = await launchInspector();

    expect(spawnOptions().env.MCPJAM_SESSION_TOKEN).toBe(token);
    expect(inspector.url).toBe(`http://localhost:6274/#token=${token}`);
  });

  it("rejects with the inspector's stderr when it exits before it is ready", async () => {
    const child = fakeSpawn();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("refused")));

    const launch = launchInspector({ silent: true });
    child().stderr?.write("Port 6274 is already in use\n");
    await new Promise((r) => setImmediate(r));
    child().emit("exit", 1, null);

    await expect(launch).rejects.toThrow(
      /exited before it was ready \(code 1\)\nInspector stderr:\nPort 6274 is already in use/,
    );
  });
});
