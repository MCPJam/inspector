import { expect, type Frame, type Page, test } from "@playwright/test";
import {
  startViewFixtureServer,
  type ViewFixtureServer,
} from "./fixtures/mcp-app-view-fixture-server";

/**
 * MCP App views run at a real URL.
 *
 * A customer with a referrer-restricted Google Maps key could not render a map
 * in MCPJam: the view was loaded via `iframe.srcdoc`, so its document URL was
 * `about:srcdoc` and no allowlist could name it. The proxy now writes the HTML
 * into a blank same-origin frame, and per the HTML spec's document-open steps
 * the written document adopts the entry document's URL — the proxy's.
 *
 * jsdom models none of that (`document.open()` there only clears child nodes),
 * so these are the only assertions that can hold the behaviour: the view's own
 * `location.href`, what a third-party server actually receives, and whether the
 * injected CSP still binds after the write.
 */

const HARNESS = "/__e2e/mcp-app-view";
const PROXY_PATH = "/api/apps/mcp-apps/sandbox-proxy";

interface HarnessState {
  viewModes: Array<{ mode: string; url: string }>;
  cspViolations: Array<{ directive: string; blockedUri: string }>;
}

function harnessUrl(
  fixture: ViewFixtureServer,
  options: { mount?: "srcdoc"; doctype?: "none" } = {},
): string {
  const params = new URLSearchParams({ fixture: fixture.origin });
  if (options.mount) params.set("mount", options.mount);
  if (options.doctype) params.set("doctype", options.doctype);
  return `${HARNESS}?${params.toString()}`;
}

/** The outer sandbox-proxy frame, which is a direct child of the page. */
function proxyFrame(page: Page): Frame {
  const frame = page
    .frames()
    .find(
      (f) =>
        f.parentFrame() === page.mainFrame() && f.url().includes(PROXY_PATH),
    );
  if (!frame) throw new Error("sandbox proxy frame not found");
  return frame;
}

/**
 * The view frame, reached through Playwright's frame tree rather than by URL.
 *
 * Two reasons not to match on the URL: once the view is mounted by
 * `document.write` it reports the SAME url as its parent — the property under
 * test — so a URL match would happily return the proxy and pass even if the
 * view never mounted; and the proxy is cross-origin to the page (127.0.0.1 vs
 * localhost), so the page cannot reach into it with `contentDocument` at all.
 */
async function viewFrame(page: Page): Promise<Frame> {
  let found: Frame | undefined;
  await expect
    .poll(
      async () => {
        const outer = page
          .frames()
          .find(
            (f) =>
              f.parentFrame() === page.mainFrame() &&
              f.url().includes(PROXY_PATH),
          );
        const children = outer?.childFrames() ?? [];
        if (children.length !== 1) return false;
        try {
          const mounted = await children[0].evaluate(
            () => !!document.querySelector("#widget-marker"),
          );
          if (mounted) found = children[0];
          return mounted;
        } catch {
          // The frame can navigate mid-evaluation (a remount); poll again.
          return false;
        }
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  return found!;
}

function readHarness(page: Page): Promise<HarnessState> {
  return page.evaluate(
    () => window.__mcpAppViewE2E ?? { viewModes: [], cspViolations: [] },
  ) as Promise<HarnessState>;
}

test.describe("MCP App view origin", () => {
  let fixture: ViewFixtureServer;

  test.beforeEach(async () => {
    fixture = await startViewFixtureServer();
  });

  test.afterEach(async () => {
    await fixture.close();
  });

  test("the view runs at the sandbox proxy's URL, on the sandbox origin", async ({
    page,
    baseURL,
  }) => {
    await page.goto(harnessUrl(fixture));
    const view = await viewFrame(page);

    const viewLocation = await view.evaluate(() => ({
      href: location.href,
      origin: location.origin,
      // The property the whole change exists for: a widget asking where it is
      // gets an answer a third-party allowlist can match.
      documentUrl: document.URL,
      hasSrcdocAttribute: !!window.frameElement?.hasAttribute("srcdoc"),
    }));

    // Origin separation is still intact: the app is on localhost, the view is
    // on 127.0.0.1 (the local stand-in for a distinct sandbox origin).
    const appOrigin = new URL(baseURL!).origin;
    expect(viewLocation.origin).not.toBe(appOrigin);
    expect(viewLocation.origin).toBe(
      appOrigin.replace("localhost", "127.0.0.1"),
    );
    expect(viewLocation.href).toContain(PROXY_PATH);
    expect(viewLocation.documentUrl).toBe(viewLocation.href);
    expect(viewLocation.hasSrcdocAttribute).toBe(false);

    const state = await readHarness(page);
    expect(state.viewModes).toHaveLength(1);
    expect(state.viewModes[0].mode).toBe("url");
    expect(state.viewModes[0].url).toBe(viewLocation.href);
  });

  test("a third party sees the view's real page URL as the referrer", async ({
    page,
  }) => {
    // This is the customer's failure, inverted: Google rejected the key because
    // the request carried nothing an allowlist could match.
    await page.goto(harnessUrl(fixture));
    const view = await viewFrame(page);
    const href = await view.evaluate(() => location.href);
    const viewOrigin = new URL(href).origin;

    await expect
      .poll(() => fixture.requests.filter((r) => r.path === "/echo").length)
      .toBeGreaterThan(0);

    const echo = fixture.requests.find((r) => r.path === "/echo")!;

    // The app sends `Referrer-Policy: strict-origin-when-cross-origin`, so a
    // cross-origin request carries the origin and not the path. That is the
    // granularity a referrer allowlist matches on anyway (`http://127.0.0.1:*/*`),
    // and it is what changed: the value is a real origin rather than absent.
    expect(echo.referer).toBe(`${viewOrigin}/`);
    expect(echo.referer).not.toBe("");
    // Specifically NOT the app's own origin — the sandbox is a separate origin
    // and the third party must see the sandbox, or the allowlist a developer
    // was told to add would be the wrong one.
    expect(echo.referer).not.toContain("localhost");
    // Allowlists that key on `Origin` (WebKit strips `Referer` cross-origin,
    // which is why Claude's docs tell iOS developers to use it) agree.
    expect(echo.origin).toBe(viewOrigin);
  });

  test("the injected CSP still binds to the written document", async ({
    page,
  }) => {
    // The policy travels as a `<meta>` inside the HTML the proxy writes. If it
    // failed to bind during the write, an undeclared host would simply be
    // fetched and the view would silently have no policy at all.
    await page.goto(harnessUrl(fixture));
    await viewFrame(page);

    await expect
      .poll(async () => (await readHarness(page)).cspViolations.length)
      .toBeGreaterThan(0);

    const state = await readHarness(page);
    expect(state.cspViolations[0].blockedUri).toContain("blocked.invalid");
    expect(state.cspViolations[0].directive).toContain("connect-src");
    // The declared host was not collateral damage.
    expect(fixture.requests.some((r) => r.path === "/echo")).toBe(true);
  });

  test("a widget reloading itself restarts rather than blanking", async ({
    page,
  }) => {
    // Chromium answers `location.reload()` in a written document by reloading
    // the frame's history entry — the initial about:blank — so without the
    // proxy's remount the widget would vanish and nothing would report it.
    await page.goto(harnessUrl(fixture));
    const view = await viewFrame(page);
    const before = (await readHarness(page)).viewModes.length;

    await view
      .evaluate(() => location.reload())
      .catch(() => {
        // The frame navigates out from under the evaluation; the assertions
        // below are what decide the outcome.
      });

    await expect
      .poll(async () => (await readHarness(page)).viewModes.length)
      .toBeGreaterThan(before);

    const restored = await viewFrame(page);
    expect(
      await restored.evaluate(
        () => document.querySelector("#widget-marker")?.textContent,
      ),
    ).toBe("mcp app view e2e");
    const state = await readHarness(page);
    expect(state.viewModes.at(-1)!.mode).toBe("url");
  });

  test("the srcdoc mount path still renders, and reports that it has no origin", async ({
    page,
  }) => {
    // The fallback the proxy keeps for a frame whose document is unreachable.
    // It must still render — and must say it has no URL, so the Inspector's
    // origin chip never offers a value no allowlist would accept.
    await page.goto(harnessUrl(fixture, { mount: "srcdoc" }));
    const view = await viewFrame(page);

    expect(
      await view.evaluate(
        () => document.querySelector("#widget-marker")?.textContent,
      ),
    ).toBe("mcp app view e2e");
    expect(await view.evaluate(() => location.href)).toBe("about:srcdoc");

    const state = await readHarness(page);
    expect(state.viewModes).toHaveLength(1);
    expect(state.viewModes[0]).toEqual({
      mode: "srcdoc",
      url: "about:srcdoc",
    });
  });

  test("HTML without a doctype renders in quirks mode, as it does on Claude", async ({
    page,
  }) => {
    // A real behaviour change from the srcdoc era: a srcdoc document is never
    // in quirks mode, a written one without a doctype is (HTML parsing, the
    // "initial" insertion mode). claude.ai behaves the same way, so MCPJam
    // matching it is the point — pinned here so it stays a deliberate fidelity
    // choice rather than resurfacing as a mystery layout report.
    await page.goto(harnessUrl(fixture));
    const withDoctype = await viewFrame(page);
    expect(await withDoctype.evaluate(() => document.compatMode)).toBe(
      "CSS1Compat",
    );

    await page.goto(harnessUrl(fixture, { doctype: "none" }));
    const withoutDoctype = await viewFrame(page);
    expect(await withoutDoctype.evaluate(() => document.compatMode)).toBe(
      "BackCompat",
    );
  });
});
