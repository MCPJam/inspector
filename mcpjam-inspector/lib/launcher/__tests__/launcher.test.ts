import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ spawn: spawnMock }));

import { launchInspector } from "../index";

class FakeChild extends EventEmitter {
  stdout: PassThrough | null;
  stderr: PassThrough | null;
  kill = vi.fn();
  constructor(piped: boolean) {
    super();
    this.stdout = piped ? new PassThrough() : null;
    this.stderr = piped ? new PassThrough() : null;
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

    expect(spawnOptions().stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("returns a link carrying the session token it gave the inspector", async () => {
    fakeSpawn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const inspector = await launchInspector({ defaultTab: "chat" });

    const token = spawnOptions().env.MCPJAM_SESSION_TOKEN;
    expect(token).toMatch(/^[A-Za-z0-9_-]{24,}$/);
    expect(inspector.url).toBe(
      `http://localhost:6274/#token=${token}&tab=playground`,
    );
  });

  it.each(["chat", "app-builder", "chat-v2"])(
    "opens Playground for the older tab name %s",
    async (defaultTab) => {
      fakeSpawn();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

      const inspector = await launchInspector({ defaultTab });

      const { env } = spawnOptions();
      expect(env.MCP_INITIAL_TAB).toBe("playground");
      expect(inspector.url).toBe(
        `http://localhost:6274/#token=${env.MCPJAM_SESSION_TOKEN}&tab=playground`,
      );
    },
  );

  it("passes a current tab through unchanged", async () => {
    fakeSpawn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const inspector = await launchInspector({ defaultTab: "tools" });

    const { env } = spawnOptions();
    expect(env.MCP_INITIAL_TAB).toBe("tools");
    expect(inspector.url).toMatch(/&tab=tools$/);
  });

  it("rejects a tab the Inspector does not have, before starting it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const error: Error = await launchInspector({
      defaultTab: "app-bulder",
    }).then(
      () => {
        throw new Error("launch resolved");
      },
      (err: Error) => err,
    );

    expect(error.message).toMatch(
      /^Could not launch the Inspector because defaultTab "app-bulder" is not a tab\. Set defaultTab to one of .*\.$/,
    );
    for (const tab of ["playground", "servers", "tools", "resources"]) {
      expect(error.message).toContain(tab);
    }
    expect(spawnMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
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

  it("waits for the inspector to confirm its own session token", async () => {
    fakeSpawn();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await launchInspector();

    const token = spawnOptions().env.MCPJAM_SESSION_TOKEN;
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:6274/api/session-token",
      expect.objectContaining({
        headers: { "X-MCP-Session-Auth": `Bearer ${token}` },
      }),
    );
  });

  it("does not mistake an inspector already on the port for its own", async () => {
    const child = fakeSpawn();
    // Another inspector holds the port: it is healthy but rejects this token.
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith("/health") ? { ok: true } : { ok: false, status: 401 },
    );
    vi.stubGlobal("fetch", fetchMock);

    const launch = launchInspector({ silent: true });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // bin/start.js reports this on stdout, in color.
    child().stdout?.write(
      "\u001b[31m❌ Default port 6274 is already in use. Please free the port\u001b[0m\n",
    );
    await new Promise((r) => setImmediate(r));
    child().emit("exit", 1, null);
    child().emit("close", 1, null);

    await expect(launch).rejects.toThrow(
      /exited before it was ready \(code 1\)\nInspector output:\n❌ Default port 6274 is already in use/,
    );
  });

  it("checks plain health in hosted mode, where there is no session token", async () => {
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
    fakeSpawn();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const inspector = await launchInspector();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:6274/health",
      expect.objectContaining({ headers: undefined }),
    );
    expect(inspector.url).toBe("http://localhost:6274/");
  });

  it("rejects with the inspector's stderr when it exits before it is ready", async () => {
    const child = fakeSpawn();
    const fetchMock = vi.fn().mockRejectedValue(new Error("refused"));
    vi.stubGlobal("fetch", fetchMock);

    const launch = launchInspector({ silent: true });
    child().stderr?.write("Port 6274 is already in use\n");
    await new Promise((r) => setImmediate(r));
    child().emit("exit", 1, null);
    child().emit("close", 1, null);

    await expect(launch).rejects.toThrow(
      /exited before it was ready \(code 1\)\nInspector output:\nPort 6274 is already in use/,
    );

    const healthChecksAtRejection = fetchMock.mock.calls.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(fetchMock.mock.calls.length).toBe(healthChecksAtRejection);
  });

  it("includes stderr that arrives after the inspector exits", async () => {
    const child = fakeSpawn();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("refused")));

    const launch = launchInspector({ silent: true });
    await new Promise((r) => setImmediate(r));
    child().emit("exit", 1, null);
    child().stderr?.write("Error: Cannot find module dist/server\n");
    await new Promise((r) => setImmediate(r));
    child().emit("close", 1, null);

    await expect(launch).rejects.toThrow(
      /Inspector output:\nError: Cannot find module dist\/server/,
    );
  });

  it("keeps the session token out of startup errors", async () => {
    const child = fakeSpawn();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("refused")));

    const launch = launchInspector({ silent: true });
    const token = spawnOptions().env.MCPJAM_SESSION_TOKEN;
    child().stdout?.write(`http://127.0.0.1:6274/#token=${token}\n`);
    await new Promise((r) => setImmediate(r));
    child().emit("exit", 1, null);
    child().emit("close", 1, null);

    const error: Error = await launch.then(
      () => {
        throw new Error("launch resolved");
      },
      (err: Error) => err,
    );
    expect(error.message).toContain("#token=<session token>");
    expect(error.message).not.toContain(token);
  });
});
