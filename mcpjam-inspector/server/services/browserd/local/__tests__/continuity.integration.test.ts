/** RUN_BROWSER_CONTINUITY_E2E=1 npx vitest run server/services/browserd/local/__tests__/continuity.integration.test.ts */
import { afterEach, expect, it } from "vitest";
import { chromium, type BrowserContext } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adaptContext } from "../../daemon/chromium-launch";
import {
  ensureLocalBrowserSession,
  findLocalBrowserSession,
  findLocalBrowserSessionForSession,
  resetLocalBrowserSessionsForTests,
  sweepLocalBrowserSessions,
  watchLocalBrowserSession,
  LOCAL_BROWSER_MAX_LIFETIME_MS,
  type LocalBrowserDeps,
} from "../local-browser-session";

const enabled = process.env.RUN_BROWSER_CONTINUITY_E2E === "1";
let root = "";
afterEach(async () => {
  if (!enabled) return;
  await resetLocalBrowserSessionsForTests();
  if (root) await rm(root, { recursive: true, force: true });
});

it.skipIf(!enabled)(
  "two real Chromium conversations retain page memory, forms and tabs on reattachment",
  async () => {
    root = await mkdtemp(join(tmpdir(), "browser-continuity-e2e-"));
    const contexts: BrowserContext[] = [];
    let now = Date.now();
    const deps: LocalBrowserDeps = {
      launch: async (options) => {
        const context = await chromium.launchPersistentContext(
          options.userDataDir,
          { headless: true, channel: "chromium" },
        );
        contexts.push(context);
        return adaptContext(context as never);
      },
      launchElectron: async () => {
        throw new Error("Node test");
      },
      runtime: () => "playwright",
      chromiumInstalled: async () => true,
      probeProfileOwner: async () => ({ live: false }),
      profileDirFor: (project) => join(root, project, "legacy"),
      profileDirForSession: (project, session) => join(root, project, session),
      now: () => now,
      env: {},
    };
    const a = await ensureLocalBrowserSession(
      { projectId: "e2e", sessionId: "chat-a" },
      deps,
    );
    const b = await ensureLocalBrowserSession(
      { projectId: "e2e", sessionId: "chat-b" },
      deps,
    );
    expect(a.bootId).not.toBe(b.bootId);
    const pageA = contexts[0].pages()[0];
    const pageB = contexts[1].pages()[0];
    await pageA.setContent(
      '<input id="draft"><div style="height:3000px">A</div>',
    );
    await pageA.locator("#draft").fill("unfinished form in A");
    await pageA.evaluate(() => {
      (window as any).continuityNonce = "unique-live-memory-a";
      window.scrollTo(0, 600);
    });
    await pageB.setContent('<input id="draft" value="B">');
    const extra = await contexts[0].newPage();
    await extra.setContent("<title>A second tab</title>");

    // The same public lookup seam used by the pane; no launch/URL reconstruction.
    expect(
      findLocalBrowserSessionForSession("e2e", "chat-b")?.handle.bootId,
    ).toBe(b.bootId);
    const reattached = findLocalBrowserSessionForSession("e2e", "chat-a");
    expect(reattached?.handle.bootId).toBe(a.bootId);
    expect(contexts).toHaveLength(2);
    expect(await pageA.locator("#draft").inputValue()).toBe(
      "unfinished form in A",
    );
    expect(await pageA.evaluate(() => (window as any).continuityNonce)).toBe(
      "unique-live-memory-a",
    );
    expect(await pageA.evaluate(() => window.scrollY)).toBe(600);
    expect(await pageB.locator("#draft").inputValue()).toBe("B");
    expect(await extra.title()).toBe("A second tab");

    // A foreground browser survives the old absolute-age eviction boundary.
    now += LOCAL_BROWSER_MAX_LIFETIME_MS + 1;
    watchLocalBrowserSession(a, now);
    await sweepLocalBrowserSessions(now);
    expect(findLocalBrowserSession(a.bootId)).toBeDefined();
    expect(findLocalBrowserSession(b.bootId)).toBeUndefined();
    expect(await pageA.locator("#draft").inputValue()).toBe(
      "unfinished form in A",
    );
    now += 45_001;
    await sweepLocalBrowserSessions(now);
    expect(findLocalBrowserSession(a.bootId)).toBeUndefined();
  },
  60_000,
);
