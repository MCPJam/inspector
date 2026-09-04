import { describe, expect, it } from "vitest";
import { buildBrowserdStack } from "../daemon/server";
import { ChromiumDriver } from "../daemon/chromium-driver";
import { HandoffLease } from "../daemon/lease";
import { createInProcessBrowserdClient } from "../in-process-client";
import { fakeContext, type FakePage } from "../daemon/__tests__/fake-page";
import type { BrowserCommand } from "../protocol";

function stackWith(init: { pages?: FakePage[] } = {}) {
  const lease = new HandoffLease();
  const { context, created } = fakeContext(init);
  const driver = new ChromiumDriver(context, { lease });
  const stack = buildBrowserdStack(driver, { token: "t0k3n", lease });
  const client = createInProcessBrowserdClient(stack, "t0k3n");
  return { stack, client, lease, created, driver };
}

const command = (
  action: BrowserCommand["action"],
  over: Partial<BrowserCommand> = {},
): BrowserCommand => ({
  commandId: `c-${Math.random()}`,
  source: "chat",
  action,
  ...over,
});

describe("in-process browserd client", () => {
  it("drives the whole stack — navigate, observe, act — with no port", async () => {
    const { client } = stackWith();

    const nav = await client.sendCommand(
      command({ kind: "navigate", url: "https://example.com/" }),
    );
    expect(nav.status).toBe("ok");
    expect(nav.status === "ok" && nav.result.ok).toBe(true);

    const observed = await client.sendCommand(
      command({ kind: "observe", mode: "url" }),
    );
    expect(observed.status).toBe("ok");
    expect(observed.status === "ok" && observed.result.output).toMatchObject({
      url: "https://example.com/",
    });

    const acted = await client.sendCommand(
      command({ kind: "act", verb: "click", target: { coordinates: [10, 10] } }),
    );
    expect(acted.status).toBe("ok");
  });

  it("echoes a bootId the caller can pin a retry to", async () => {
    const { client, stack } = stackWith();
    const status = await client.status();
    expect(status).toEqual({ kind: "ok", bootId: stack.bootId });

    const stale = await client.sendCommand(
      command({ kind: "observe", mode: "url" }),
      "a-previous-boot",
    );
    expect(stale.status).toBe("unknown_boot");
  });

  it("de-duplicates a replayed commandId instead of acting twice", async () => {
    const { client, created } = stackWith();
    const cmd = command({ kind: "navigate", url: "https://example.com/a" });
    await client.sendCommand(cmd);
    await client.sendCommand(cmd);
    expect(created[0]?.calls.goto).toEqual(["https://example.com/a"]);
  });

  it("refuses a bad bearer — the in-process path is not an auth bypass", async () => {
    const { stack } = stackWith();
    const wrong = createInProcessBrowserdClient(stack, "not-the-token");
    await expect(
      wrong.sendCommand(command({ kind: "observe", mode: "url" })),
    ).rejects.toThrow(/HTTP 401/);
  });

  it("blocks the agent — and captures nothing — while a person holds the browser", async () => {
    const { client, created } = stackWith();
    await client.sendCommand(
      command({ kind: "navigate", url: "https://example.com/" }),
    );
    const shotsBefore = created[0]!.calls.shots;

    await client.leaseAction({ action: "acquire", holder: "rail-1" });

    const blocked = await client.sendCommand(
      command({ kind: "observe", mode: "screenshot" }),
    );
    expect(blocked.status).toBe("lease_blocked");
    expect(blocked.status === "lease_blocked" && blocked.lease).toBe("held");
    // The point of enforcing at the daemon: the page was never asked.
    expect(created[0]!.calls.shots).toBe(shotsBefore);
  });

  it("lets the holder drive, and nobody else", async () => {
    const { client } = stackWith();
    await client.leaseAction({ action: "acquire", holder: "rail-1" });

    const mine = await client.sendCommand(
      command(
        { kind: "navigate", url: "https://example.com/login" },
        { source: "manual", holder: "rail-1" },
      ),
    );
    expect(mine.status).toBe("ok");

    const theirs = await client.sendCommand(
      command(
        { kind: "navigate", url: "https://evil.example/" },
        { source: "manual", holder: "someone-else" },
      ),
    );
    expect(theirs.status).toBe("lease_blocked");
    expect(theirs.status === "lease_blocked" && theirs.lease).toBe(
      "other_holder",
    );
  });

  it("makes the resume loud, and says WHAT was driving", async () => {
    const { client } = stackWith();
    await client.sendCommand(
      command({ kind: "navigate", url: "https://example.com/" }),
    );
    await client.leaseAction({
      action: "acquire",
      holder: "script-1",
      kind: "script",
    });
    const held = await client.lease();
    expect(held).toMatchObject({ state: "held", holderKind: "script" });

    await client.leaseAction({ action: "resume", holder: "script-1" });
    const after = await client.sendCommand(
      command({ kind: "observe", mode: "url" }),
    );
    expect(after.status).toBe("ok");
    expect(
      after.status === "ok" &&
        (after.result.output as { handoffNote?: string }).handoffNote,
    ).toMatch(/script took control/i);
  });
});
