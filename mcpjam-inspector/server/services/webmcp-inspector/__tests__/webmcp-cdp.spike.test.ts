/**
 * The contract test for Chrome's experimental CDP `WebMCP` domain.
 *
 * Every fact the WebMCP Inspector's provider relies on is asserted here against
 * a real browser, so a Chromium bump that changes the domain fails THIS test
 * with a named expectation rather than surfacing as a broken feature. The
 * domain is marked experimental and the page API has already churned once
 * (`navigator.` → `document.modelContext`), which is exactly why the provider
 * speaks CDP and why this file exists.
 *
 * Pinned surface: Playwright 1.62.1 / Chromium 151.0.7922.34.
 *
 * Findings encoded below that the implementation depends on:
 *   1. `WebMCP.enable` resolves even when the feature is OFF — it is not a
 *      support probe. Support is probed in the page.
 *   2. `invokeTool` takes `{frameId, toolName, input}` and returns
 *      `{invocationId}` IMMEDIATELY, before the tool settles.
 *   3. `toolInvoked.input` is a JSON STRING; `toolResponded.output` is an
 *      OBJECT, and is present only when status is `Completed`.
 *   4. Statuses are `Completed | Canceled | Error` (one "l" in Canceled).
 *      On `Error`, `errorText` is empty and the real message is on
 *      `exception.description`.
 *   5. Unknown tool / unknown invocation id reject at the CDP layer instead of
 *      producing a `toolResponded`.
 *   6. NAVIGATION FIRES NO `toolsRemoved`. The provider MUST synthesize
 *      removal, or a page's tools accumulate across navigations forever.
 *   7. Tools registered in a CROSS-ORIGIN subframe never reach the page's CDP
 *      session, and the subframe is not in `Page.getFrameTree`. V1 scope is
 *      therefore main-frame + same-process frames.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Browser, CDPSession, Page } from "playwright";
import { chromium } from "playwright";
import { isChromiumInstalled } from "../../../utils/browser-rendering-setup";
import { buildWebMcpLaunchArgs, PAGE_API_PROBE } from "../launch-args";
import {
  startWebMcpFixtureServer,
  FIXTURE_BIG_OUTPUT_BYTES,
  type WebMcpFixture,
} from "./fixture-page";

const CHROMIUM_AVAILABLE = await isChromiumInstalled();

// Locally a missing browser skips; in CI it fails. CI runs the pinned Playwright
// image with Chromium preinstalled, so "skipped" there would mean the one test
// that guards an experimental protocol quietly stopped running.
if (process.env.CI && !CHROMIUM_AVAILABLE) {
  throw new Error(
    "WebMCP CDP spike requires Chromium, which is preinstalled in the pinned " +
      "Playwright CI image. Its absence means the image or the pin is wrong.",
  );
}

interface ToolPayload {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    readOnly?: boolean;
    untrustedContent?: boolean;
    autosubmit?: boolean;
  };
  frameId: string;
  backendNodeId?: number;
  stackTrace?: { callFrames: unknown[] };
}
interface RespondedPayload {
  invocationId: string;
  status: "Completed" | "Canceled" | "Error";
  output?: unknown;
  errorText?: string;
  exception?: { description?: string };
}

function waitFor<T>(
  predicate: () => T | undefined,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const value = predicate();
      if (value !== undefined) return resolve(value);
      if (Date.now() > deadline) return reject(new Error("timed out waiting"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe.skipIf(!CHROMIUM_AVAILABLE)("CDP WebMCP domain contract", () => {
  let fixture: WebMcpFixture;
  let browser: Browser;
  let page: Page;
  let cdp: CDPSession;
  let mainFrameId: string;
  const added: { tools: ToolPayload[] }[] = [];
  const removed: { tools: { name: string; frameId: string }[] }[] = [];
  const invoked: {
    toolName: string;
    frameId: string;
    invocationId: string;
    input: string;
  }[] = [];
  const responded: RespondedPayload[] = [];

  beforeAll(async () => {
    fixture = await startWebMcpFixtureServer();
    browser = await chromium.launch({
      headless: true,
      args: buildWebMcpLaunchArgs(),
    });
    page = await browser.newPage();
    cdp = await page.context().newCDPSession(page);
    cdp.on("WebMCP.toolsAdded", (e) => added.push(e as never));
    cdp.on("WebMCP.toolsRemoved", (e) => removed.push(e as never));
    cdp.on("WebMCP.toolInvoked", (e) => invoked.push(e as never));
    cdp.on("WebMCP.toolResponded", (e) => responded.push(e as never));
    await cdp.send("WebMCP.enable" as never);
    await page.goto(fixture.url, { waitUntil: "networkidle" });
    await waitFor(() =>
      added.flatMap((e) => e.tools).some((t) => t.name === "echo")
        ? true
        : undefined,
    );
    mainFrameId = (
      (await cdp.send("Page.getFrameTree" as never)) as {
        frameTree: { frame: { id: string } };
      }
    ).frameTree.frame.id;
  }, 60_000);

  afterAll(async () => {
    await browser?.close().catch(() => {});
    await fixture?.close();
  });

  it("exposes the page API under document.modelContext, aliased on navigator", async () => {
    expect(await page.evaluate(PAGE_API_PROBE)).toBe(true);
    expect(await page.evaluate("window.__navigatorAliasesDocument")).toBe(true);
  });

  it("reports registrations with the documented Tool shape", () => {
    const echo = added.flatMap((e) => e.tools).find((t) => t.name === "echo");
    expect(echo).toBeDefined();
    expect(echo!.description).toBe("Echoes its input back");
    expect(echo!.inputSchema).toMatchObject({ type: "object" });
    expect(echo!.frameId).toBe(mainFrameId);
    // Imperative registrations carry a stack trace and no backendNodeId; the
    // latter is what marks a DECLARATIVE tool, so it is our provenance signal.
    expect(echo!.stackTrace?.callFrames?.length).toBeGreaterThan(0);
    expect(echo!.backendNodeId).toBeUndefined();
  });

  it("does not plumb annotation VALUES through for imperative tools", () => {
    // The fixture registers `annotated` with readOnly + untrustedContent true.
    // Chromium 151 reports the annotation object with both FALSE. This is the
    // evidence for the product rule that annotations are advisory display only:
    // approval policy must never be derived from them. If a future Chromium
    // starts honouring them, this test fails and the rule can be revisited.
    const annotated = added
      .flatMap((e) => e.tools)
      .find((t) => t.name === "annotated");
    expect(annotated).toBeDefined();
    expect(annotated!.annotations).toBeDefined();
    expect(annotated!.annotations?.readOnly).toBe(false);
    expect(annotated!.annotations?.untrustedContent).toBe(false);
    // Tools registered without an `annotations` key get no annotations at all.
    const echo = added.flatMap((e) => e.tools).find((t) => t.name === "echo");
    expect(echo!.annotations).toBeUndefined();
  });

  it("invokes a tool and returns the invocationId before the tool settles", async () => {
    responded.length = 0;
    const before = responded.length;
    const { invocationId } = (await cdp.send(
      "WebMCP.invokeTool" as never,
      {
        frameId: mainFrameId,
        toolName: "echo",
        input: { text: "hello" },
      } as never,
    )) as { invocationId: string };
    expect(invocationId).toMatch(/^[0-9A-F]+$/i);
    expect(responded.length).toBe(before); // resolved before any response

    // The command response beats its own events: `toolInvoked` has not arrived
    // yet at this point, so a caller that registered the invocation only on the
    // event would miss the window in which it is already running.
    expect(
      invoked.find((e) => e.invocationId === invocationId),
    ).toBeUndefined();

    const start = await waitFor(() =>
      invoked.find((e) => e.invocationId === invocationId),
    );
    expect(start.toolName).toBe("echo");
    expect(start.frameId).toBe(mainFrameId);
    // Input arrives as a JSON STRING on the event, not an object.
    expect(typeof start.input).toBe("string");
    expect(JSON.parse(start.input)).toEqual({ text: "hello" });

    const done = await waitFor(() =>
      responded.find((r) => r.invocationId === invocationId),
    );
    expect(done.status).toBe("Completed");
    // Output is an OBJECT (the MCP-shaped tool result), not a string.
    expect(done.output).toMatchObject({
      content: [{ type: "text", text: 'echo:{"text":"hello"}' }],
    });
  });

  it("reports a thrown tool as Error with the message on exception.description", async () => {
    responded.length = 0;
    const { invocationId } = (await cdp.send(
      "WebMCP.invokeTool" as never,
      {
        frameId: mainFrameId,
        toolName: "boom",
        input: {},
      } as never,
    )) as { invocationId: string };
    const done = await waitFor(() =>
      responded.find((r) => r.invocationId === invocationId),
    );
    expect(done.status).toBe("Error");
    expect(done.output).toBeUndefined();
    // errorText is empty in practice — the usable message is on the exception.
    expect(done.errorText ?? "").toBe("");
    expect(done.exception?.description).toContain("intentional failure");
  });

  it("rejects an unknown tool at the CDP layer, not as a toolResponded", async () => {
    await expect(
      cdp.send(
        "WebMCP.invokeTool" as never,
        {
          frameId: mainFrameId,
          toolName: "does_not_exist",
          input: {},
        } as never,
      ),
    ).rejects.toThrow(/Tool not found/i);
  });

  it("passes oversized output through untruncated, so we must cap it ourselves", async () => {
    responded.length = 0;
    const { invocationId } = (await cdp.send(
      "WebMCP.invokeTool" as never,
      {
        frameId: mainFrameId,
        toolName: "big",
        input: {},
      } as never,
    )) as { invocationId: string };
    const done = await waitFor(
      () => responded.find((r) => r.invocationId === invocationId),
      15_000,
    );
    expect(done.status).toBe("Completed");
    expect(JSON.stringify(done.output).length).toBeGreaterThan(
      FIXTURE_BIG_OUTPUT_BYTES,
    );
  }, 30_000);

  it("cancels a pending invocation and settles it as Canceled", async () => {
    responded.length = 0;
    const { invocationId } = (await cdp.send(
      "WebMCP.invokeTool" as never,
      {
        frameId: mainFrameId,
        toolName: "slow",
        input: {},
      } as never,
    )) as { invocationId: string };
    await waitFor(() =>
      invoked.find((e) => e.invocationId === invocationId) ? true : undefined,
    );
    expect(
      responded.find((r) => r.invocationId === invocationId),
    ).toBeUndefined();

    await cdp.send(
      "WebMCP.cancelInvocation" as never,
      {
        invocationId,
      } as never,
    );
    const done = await waitFor(() =>
      responded.find((r) => r.invocationId === invocationId),
    );
    expect(done.status).toBe("Canceled");
    expect(done.output).toBeUndefined();
  });

  it("rejects cancelling an unknown invocation id", async () => {
    await expect(
      cdp.send(
        "WebMCP.cancelInvocation" as never,
        {
          invocationId: "not-a-real-invocation",
        } as never,
      ),
    ).rejects.toThrow(/Invalid invocation id/i);
  });

  it("does NOT emit toolsRemoved on navigation — removal must be synthesized", async () => {
    added.length = 0;
    removed.length = 0;
    await page.goto(fixture.nextUrl, { waitUntil: "networkidle" });
    await waitFor(() =>
      added.flatMap((e) => e.tools).some((t) => t.name === "page2_tool")
        ? true
        : undefined,
    );
    // The new page's tool arrives...
    expect(added.flatMap((e) => e.tools).map((t) => t.name)).toContain(
      "page2_tool",
    );
    // ...but nothing tells us the previous page's tools are gone, and the main
    // frame keeps its id across the navigation. A registry that trusted the
    // domain here would serve tools that no longer exist.
    expect(removed).toEqual([]);
    const frameIdAfter = (
      (await cdp.send("Page.getFrameTree" as never)) as {
        frameTree: { frame: { id: string } };
      }
    ).frameTree.frame.id;
    expect(frameIdAfter).toBe(mainFrameId);
  }, 30_000);

  it("does not surface cross-origin subframe tools (V1 scope boundary)", async () => {
    // Fresh page so the earlier navigation doesn't confuse the frame picture.
    const probePage = await browser.newPage();
    const probeCdp = await probePage.context().newCDPSession(probePage);
    const seen: ToolPayload[] = [];
    probeCdp.on("WebMCP.toolsAdded", (e) =>
      seen.push(...(e as { tools: ToolPayload[] }).tools),
    );
    await probeCdp.send("WebMCP.enable" as never);
    await probePage.goto(fixture.url, { waitUntil: "networkidle" });
    await waitFor(() =>
      seen.some((t) => t.name === "echo") ? true : undefined,
    );

    // The subframe itself reports a successful registration...
    const subFrame = probePage
      .frames()
      .find((f) => f.url().startsWith(fixture.subOriginUrl));
    expect(subFrame).toBeDefined();
    expect(await subFrame!.evaluate("window.__subRegistered")).toBe(
      "registered",
    );
    // ...yet its tool never reaches this session, and the OOPIF is not even in
    // the page's frame tree: it is a separate target. Supporting it means
    // Target.setAutoAttach, which is deliberately out of V1 scope.
    expect(seen.map((t) => t.name)).not.toContain("sub_tool");
    const tree = (await probeCdp.send("Page.getFrameTree" as never)) as {
      frameTree: { childFrames?: unknown[] };
    };
    expect(tree.frameTree.childFrames ?? []).toEqual([]);
    await probePage.close();
  }, 30_000);
});

describe.skipIf(!CHROMIUM_AVAILABLE)("WebMCP support probing", () => {
  it("WebMCP.enable succeeds even with the feature off, so it cannot be the probe", async () => {
    const fixture = await startWebMcpFixtureServer();
    // Base args only: no --enable-features=WebMCP.
    const browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });
    try {
      const page = await browser.newPage();
      const cdp = await page.context().newCDPSession(page);
      const added: unknown[] = [];
      cdp.on("WebMCP.toolsAdded", (e) => added.push(e));
      // The command resolves...
      await expect(cdp.send("WebMCP.enable" as never)).resolves.toBeDefined();
      await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
      // ...but the page API is absent, the fixture's registrations never ran,
      // and no tool is ever reported. This is why the provider probes the page.
      expect(await page.evaluate(PAGE_API_PROBE)).toBe(false);
      expect(added).toEqual([]);
    } finally {
      await browser.close().catch(() => {});
      await fixture.close();
    }
  }, 60_000);
});
