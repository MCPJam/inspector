import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { buildBrowserdStack } from "../server";
import type { BrowserDriver } from "../browser-driver";
import type { BrowserCommandResult } from "../../protocol";
import { createBrowserSecretRegistry } from "../secret-registry";
import { resolveActSecrets } from "../secret-substitution";

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
      profileExport: async () => new Uint8Array([31, 139, 8, 0]),
    });
    server = stack.server;
    bootId = stack.bootId;
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
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

  it("serves a profile export as raw gzip bytes", async () => {
    const res = await fetch(`${base}/v1/profile/export`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new Uint8Array([31, 139, 8, 0]),
    );
  });

  it("401s a command with no bearer", async () => {
    const res = await fetch(`${base}/v1/commands`, {
      method: "POST",
      body: JSON.stringify({
        command: {
          commandId: "c1",
          source: "chat",
          action: { kind: "reload" },
        },
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
        command: {
          commandId: "c1",
          source: "chat",
          action: { kind: "reload" },
        },
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

/**
 * R-3. A secret goes in beside the command and does not come back out.
 *
 * Over a real socket because the property is about the WHOLE stack: the value
 * arrives as a sibling of the command (so no ledger writer is ever handed it),
 * the driver substitutes it at the last moment, and the scrub wrapper — reading
 * the DRIVER'S OWN registry — replaces it in everything the page hands back.
 * Two registries would pass every unit test and leak here.
 */
describe("browserd server adapter — typed secrets do not come back", () => {
  /** A driver that types what it is given and then reads the field back. */
  function echoingDriver(): BrowserDriver {
    const registry = createBrowserSecretRegistry();
    return {
      execute: async (command, context) => {
        const action = command.action as { kind: string; value?: string };
        if (action.kind !== "act") return { ok: true };
        const resolved = resolveActSecrets(
          action as never,
          context?.secrets,
        ) as { value?: string };
        if (resolved.value !== action.value && context?.secrets)
          registry.register(context.secrets);
        // What the page hands back: the field now holds the typed value.
        return {
          ok: true,
          output: { a11y: `textbox "Password" value=${resolved.value}` },
        };
      },
      secretRegistry: () => registry,
      currentStateToken: async () => undefined,
      health: async () => ({ ok: true }),
      close: async () => {},
    };
  }

  async function withEchoingStack(
    run: (base: string) => Promise<void>,
  ): Promise<void> {
    const stack = buildBrowserdStack(echoingDriver(), { token: TOKEN });
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

  const typeCommand = (commandId: string, value: string) =>
    JSON.stringify({
      command: {
        commandId,
        source: "chat",
        action: { kind: "act", verb: "type", value },
      },
      secrets: [{ name: "PW", value: "hunter2-hunter2-hunter2" }],
    });

  it("substitutes the value and scrubs it back out of the tree", async () => {
    await withEchoingStack(async (base) => {
      const res = await fetch(`${base}/v1/commands`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: typeCommand("c1", "{{secret:PW}}"),
      });
      const body = await res.text();
      expect(body).not.toContain("hunter2");
      expect(JSON.parse(body).result.output.a11y).toBe(
        'textbox "Password" value={{secret:PW}}',
      );
    });
  });

  it("keeps scrubbing on LATER commands that carry no secret", async () => {
    // The point of a per-boot registry: the field still holds the value, and
    // forgetting after the typing command would leak every observation after
    // it.
    await withEchoingStack(async (base) => {
      await fetch(`${base}/v1/commands`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: typeCommand("c1", "{{secret:PW}}"),
      });
      const res = await fetch(`${base}/v1/commands`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          command: {
            commandId: "c2",
            source: "chat",
            action: {
              kind: "act",
              verb: "type",
              value: "hunter2-hunter2-hunter2",
            },
          },
        }),
      });
      expect(await res.text()).not.toContain("hunter2");
    });
  });

  it("refuses rather than typing a literal placeholder", async () => {
    await withEchoingStack(async (base) => {
      const res = await fetch(`${base}/v1/commands`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          command: {
            commandId: "c3",
            source: "chat",
            action: { kind: "act", verb: "type", value: "{{secret:ABSENT}}" },
          },
        }),
      });
      // The driver here throws rather than refusing, which the queue normalizes
      // — either way, no page ever sees the placeholder.
      expect((await res.json()).result).toMatchObject({
        ok: false,
        error: expect.stringContaining("secret_unresolved"),
      });
    });
  });
});
