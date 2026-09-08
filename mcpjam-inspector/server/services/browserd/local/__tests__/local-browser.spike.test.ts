/**
 * The local engine, against a REAL Chromium.
 *
 * Everything else in this area is driven through a fake page, which proves the
 * logic and nothing about the browser. This drives the whole local stack — the
 * daemon built in-process, its queue, its lease, a Playwright Chromium on this
 * machine — the way a chat turn and the rail pane actually do.
 *
 * Gated on `RUN_BROWSERD_SPIKE=true` and skipped otherwise, like the daemon's
 * own launch spike: it downloads nothing, but it does start a browser, and a
 * unit run should not.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBrowserdStack } from "../../daemon/server";
import { ChromiumDriver } from "../../daemon/chromium-driver";
import { HandoffLease } from "../../daemon/lease";
import { launchBrowserdContext } from "../../daemon/chromium-launch";
import { createInProcessBrowserdClient } from "../../in-process-client";
import type { ViewportFrame } from "../../daemon/viewport";
import type { BrowserCommand } from "../../protocol";

const RUN = process.env.RUN_BROWSERD_SPIKE === "true";

/**
 * This sandbox ships one Chromium build at a path Playwright's own resolver
 * does not know. Honoured only for the spike; production resolves through
 * Playwright, which is what a user's machine has.
 */
const EXECUTABLE = process.env.MCPJAM_SPIKE_CHROMIUM_PATH;

const profiles: string[] = [];
afterAll(async () => {
  for (const dir of profiles) await rm(dir, { recursive: true, force: true });
});

async function startBrowser(contextMode: "persistent" | "ephemeral") {
  const userDataDir = await mkdtemp(join(tmpdir(), "browserd-spike-"));
  profiles.push(userDataDir);
  const context = await launchBrowserdContext({
    userDataDir,
    headless: true,
    contextMode,
    ...(EXECUTABLE ? { executablePath: EXECUTABLE } : { channel: "chromium" }),
    extraArgs: ["--no-sandbox"],
  });
  const lease = new HandoffLease();
  const driver = new ChromiumDriver(context, { lease });
  const stack = buildBrowserdStack(driver, { token: "spike", lease });
  return {
    driver,
    lease,
    stack,
    client: createInProcessBrowserdClient(stack, "spike"),
    userDataDir,
  };
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

const PAGE = `data:text/html,${encodeURIComponent(
  `<title>Spike</title>
   <button id="go" onclick="document.title='clicked'">Go</button>
   <input id="field" />`,
)}`;

describe.skipIf(!RUN)("the local browser, end to end", () => {
  it("navigates, screenshots, clicks, and types — through the whole stack", async () => {
    const { client, driver } = await startBrowser("persistent");
    try {
      const navigated = await client.sendCommand(
        command({ kind: "navigate", url: PAGE }),
      );
      expect(navigated.status).toBe("ok");

      const shot = await client.sendCommand(
        command({ kind: "observe", mode: "screenshot" }),
      );
      expect(shot.status).toBe("ok");
      const image = (shot as { result: { output: { screenshot?: string } } })
        .result.output.screenshot;
      // A real JPEG, not an empty string: this is what reaches the model as
      // image content, and the coordinate design depends on it being real.
      expect(image?.startsWith("/9j/")).toBe(true);

      const clicked = await client.sendCommand(
        command({
          kind: "act",
          verb: "click",
          target: { selector: "#go" },
        }),
      );
      expect(clicked.status).toBe("ok");

      const url = await client.sendCommand(
        command({ kind: "observe", mode: "dom" }),
      );
      expect(url.status).toBe("ok");
      await driver.close();
    } finally {
      await driver.close().catch(() => {});
    }
  }, 120_000);

  it("streams frames to a watcher and stops when they leave", async () => {
    const { stack, driver } = await startBrowser("ephemeral");
    try {
      const client = createInProcessBrowserdClient(stack, "spike");
      await client.sendCommand(command({ kind: "navigate", url: PAGE }));

      const frames: ViewportFrame[] = [];
      const subscription = await stack.handler.subscribeFrames({
        listener: (frame) => frames.push(frame),
      });
      expect(subscription.ok).toBe(true);

      // Nudge the page so Chromium paints something after the subscribe.
      await client.sendCommand(
        command({ kind: "act", verb: "click", target: { selector: "#go" } }),
      );
      await new Promise((r) => setTimeout(r, 2_000));

      expect(frames.length).toBeGreaterThan(0);
      const frame = frames[0]!;
      expect(frame.deviceWidth).toBeGreaterThan(0);
      expect(frame.data.startsWith("/9j/")).toBe(true);

      if (subscription.ok) subscription.unsubscribe();
    } finally {
      await driver.close().catch(() => {});
    }
  }, 120_000);

  it("takes a person's typing while they hold the browser, and refuses it otherwise", async () => {
    const { stack, driver, client } = await startBrowser("ephemeral");
    try {
      await client.sendCommand(command({ kind: "navigate", url: PAGE }));
      await client.sendCommand(
        command({ kind: "act", verb: "click", target: { selector: "#field" } }),
      );

      // No lease: refused before it reaches the page.
      expect(
        await stack.handler.dispatchInput({
          holder: "pane-1",
          events: [{ type: "text", text: "nope" }],
        }),
      ).toMatchObject({ ok: false, error: "lease_required" });

      await client.leaseAction({ action: "acquire", holder: "pane-1" });
      expect(
        await stack.handler.dispatchInput({
          holder: "pane-1",
          events: [{ type: "text", text: "hunter2" }],
        }),
      ).toEqual({ ok: true });

      // And the agent cannot look while they hold it.
      const blocked = await client.sendCommand(
        command({ kind: "observe", mode: "screenshot" }),
      );
      expect(blocked.status).toBe("lease_blocked");

      await client.leaseAction({ action: "resume", holder: "pane-1" });
      const after = await client.sendCommand(
        command({ kind: "observe", mode: "dom" }),
      );
      expect(after.status).toBe("ok");
      // The loud resume: the model is told a person touched the page.
      expect(
        (after as { result: { output: { handoffNote?: string } } }).result.output
          .handoffNote,
      ).toMatch(/person took control/i);
    } finally {
      await driver.close().catch(() => {});
    }
  }, 120_000);
});
