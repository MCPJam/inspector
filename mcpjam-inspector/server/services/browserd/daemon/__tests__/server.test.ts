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
