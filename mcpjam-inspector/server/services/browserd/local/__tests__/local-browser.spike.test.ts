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
import type {
  BrowserCommand,
  ObservationStateToken,
} from "../../protocol";

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

/**
 * A sign-in form, the shape the composites exist for.
 *
 * Submitting swaps the whole body — which is what makes it usable as the
 * "the page moved under the model" fixture too, since that is a structural
 * change the DOM signal has to notice.
 */
const SIGN_IN = `data:text/html,${encodeURIComponent(
  `<title>Sign in</title>
   <form onsubmit="event.preventDefault();document.body.innerHTML='<h1 id=hello>Welcome</h1>'">
     <label for="email">Email</label><input id="email" name="email" />
     <label for="password">Password</label>
     <input id="password" name="password" type="password" />
     <select id="plan" aria-label="Plan">
       <option value="free">Free</option>
       <option value="pro">Pro</option>
     </select>
     <button id="signin" type="submit">Sign in</button>
   </form>`,
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

  it("signs in with ONE fill_form, and the act says what the page became", async () => {
    // The whole plan, against a real page: three gated calls (type, type,
    // press) become one, and the result already carries the tree of what to
    // do next — so nothing has to call browser_observe between two steps.
    const { client, driver } = await startBrowser("ephemeral");
    try {
      await client.sendCommand(command({ kind: "navigate", url: SIGN_IN }));

      const filled = await client.sendCommand(
        command({
          kind: "act",
          verb: "fill_form",
          fields: [
            { selector: "#email", value: "ada@example.com" },
            { selector: "#password", value: "hunter2" },
            // A <select> among the inputs: `fillSelector` refuses it and the
            // driver falls back, so the model never has to know the
            // difference.
            { selector: "#plan", value: "pro" },
          ],
          observe: "both",
        }),
      );

      expect(filled.status).toBe("ok");
      const before = (
        filled as {
          result: { ok: boolean; output: Record<string, unknown> };
        }
      ).result;
      expect(before.ok).toBe(true);
      // What the model reads back from ONE act: the tree, its refs, and the
      // picture — the observation it used to spend a second call on. And the
      // tree ALREADY proves the three fields landed, `<select>` included:
      //
      //   - textbox "Email" [ref=e1]: "ada@example.com"
      //   - textbox "Password" [focused ref=e2]: "•••••••"
      //   - combobox "Plan" [expanded=false ref=e3]: "Pro"
      //   - button "Sign in" [ref=e6]
      const tree = String(before.output.a11y);
      expect(tree).toContain('textbox "Email"');
      expect(tree).toContain("ada@example.com");
      // The fallback fired against a REAL Playwright refusal, not a fixture's.
      expect(tree).toMatch(/combobox "Plan".*: "Pro"/);
      expect(tree).toMatch(/button "Sign in" \[ref=e\d+\]/);
      expect(Object.keys(before.output.refs as object).length).toBeGreaterThan(0);
      expect(String(before.output.screenshot).startsWith("/9j/")).toBe(true);

      // NO `observe` between the two steps: the next act is decided from the
      // tree the previous one returned. That is the round trip this is for.
      const submitted = await client.sendCommand(
        command({
          kind: "act",
          verb: "click",
          target: { selector: "#signin" },
          observe: "a11y",
        }),
      );
      const after = (
        submitted as { result: { output: Record<string, unknown> } }
      ).result;
      expect(String(after.output.a11y)).toContain("Welcome");

      await driver.close();
    } finally {
      await driver.close().catch(() => {});
    }
  }, 120_000);

  it("answers a STALE act with the page, not just a token", async () => {
    // The 409 recovery path end to end: an act pinned to an observation the
    // page has moved past comes back refused AND observed, so re-deciding
    // costs no extra call.
    const { driver, client } = await startBrowser("ephemeral");
    try {
      await client.sendCommand(command({ kind: "navigate", url: SIGN_IN }));
      const observed = await client.sendCommand(
        command({ kind: "observe", mode: "screenshot" }),
      );
      const token = (
        observed as unknown as {
          result: { stateToken: ObservationStateToken };
        }
      ).result.stateToken;

      // Kill the tab's content under the model, the way a second act in the
      // same step would.
      await client.sendCommand(
        command({ kind: "act", verb: "click", target: { selector: "#signin" } }),
      );

      const refused = await client.sendCommand(
        command({
          kind: "act",
          verb: "click",
          target: { selector: "#signin" },
          expectedState: token,
          observe: "a11y",
        }),
      );

      expect(refused.status).toBe("stale_observation");
      const result = (
        refused as {
          result: { staleObservation?: boolean; output: Record<string, unknown> };
        }
      ).result;
      expect(result.staleObservation).toBe(true);
      // THE POINT: the refusal carries the page the model must re-decide from.
      expect(String(result.output.a11y)).toContain("Welcome");
      expect(String(result.output.url)).toContain("data:text/html");

      await driver.close();
    } finally {
      await driver.close().catch(() => {});
    }
  }, 120_000);
});
