import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { buildBrowserdStack } from "../server";
import type { BrowserDriver } from "../browser-driver";
import type { BrowserCommandResult } from "../../protocol";

const TOKEN = "integration-token";

function stubDriver(): BrowserDriver {
  return {
    execute: async (): Promise<BrowserCommandResult> => ({
      ok: true,
      output: "navigated",
      settled: true,
    }),
    currentStateToken: async () => undefined,
    health: async () => ({ ok: true }),
    close: async () => {},
  };
}

describe("browserd server adapter (over a real socket)", () => {
  let server: Server;
  let bootId: string;
  let base: string;

  beforeEach(async () => {
    const stack = buildBrowserdStack(stubDriver(), {
      token: TOKEN,
      bodyLimitBytes: 256,
    });
    server = stack.server;
    bootId = stack.bootId;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("serves /healthz unauthenticated", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("401s a command with no bearer", async () => {
    const res = await fetch(`${base}/v1/commands`, {
      method: "POST",
      body: JSON.stringify({
        command: { commandId: "c1", source: "chat", action: { kind: "reload" } },
      }),
    });
    expect(res.status).toBe(401);
  });

  it("round-trips a valid command and echoes the minted bootId", async () => {
    const res = await fetch(`${base}/v1/commands`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        command: {
          commandId: "c1",
          source: "chat",
          action: { kind: "navigate", url: "https://x.test" },
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ok",
      result: { ok: true, output: "navigated", settled: true },
      bootId,
    });
  });

  it("rejects a replay against a different bootId as command_unknown_boot", async () => {
    const res = await fetch(`${base}/v1/commands`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        command: { commandId: "c1", source: "chat", action: { kind: "reload" } },
        expectedBootId: "some-old-boot",
      }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "command_unknown_boot" });
  });

  it("413s a body over the size limit", async () => {
    const res = await fetch(`${base}/v1/commands`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: "x".repeat(512),
    });
    expect(res.status).toBe(413);
  });
});

/**
 * R-2. A capability the inspector reads before it uses, over a real socket.
 *
 * The rule the whole no-forced-relaunch posture rests on: the inspector never
 * calls a route the daemon did not advertise. A stack built with a recorder
 * says `record` on `/v1/status` and answers `/v1/record`; one built without
 * says neither, and its route refuses rather than pretending.
 */
describe("browserd server adapter — recording is announced, never assumed", () => {
  async function withStack(
    config: Parameters<typeof buildBrowserdStack>[1],
    run: (base: string) => Promise<void>,
  ): Promise<void> {
    const stack = buildBrowserdStack(stubDriver(), config);
    await new Promise<void>((resolve) =>
      stack.server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = stack.server.address() as AddressInfo;
    try {
      await run(`http://127.0.0.1:${port}`);
    } finally {
      stack.closeStreams();
      await new Promise<void>((resolve) => stack.server.close(() => resolve()));
    }
  }

  const fakeRecorder = () => {
    const calls: string[] = [];
    return {
      calls,
      recorder: {
        start: (args: { id: string; fps: number }) => {
          calls.push(`start:${args.id}@${args.fps}`);
          return { ok: true as const };
        },
        stop: async () => {
          calls.push("stop");
          return null;
        },
        status: () => ({ active: false }),
        finalize: async () => {},
        dispose: () => {},
      },
    };
  };

  it("advertises `record` and serves the route when the box has a recorder", async () => {
    const { recorder, calls } = fakeRecorder();
    await withStack(
      { token: TOKEN, features: ["record"], recorder },
      async (base) => {
        const status = await fetch(`${base}/v1/status`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect((await status.json()).features).toContain("record");

        const started = await fetch(`${base}/v1/record`, {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify({ action: "start", id: "run-1", fps: 15 }),
        });
        expect(started.status).toBe(200);
        expect(calls).toEqual(["start:run-1@15"]);
      },
    );
  });

  it("advertises nothing and refuses the route when it has none", async () => {
    await withStack({ token: TOKEN }, async (base) => {
      const status = await fetch(`${base}/v1/status`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect((await status.json()).features).not.toContain("record");

      const started = await fetch(`${base}/v1/record`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ action: "start", id: "run-1" }),
      });
      expect(started.status).toBe(503);
      expect(await started.json()).toMatchObject({
        error: "record_unavailable",
      });
    });
  });
});
