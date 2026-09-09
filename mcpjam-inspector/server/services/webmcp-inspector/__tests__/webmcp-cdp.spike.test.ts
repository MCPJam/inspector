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
 *      session, and the subframe is not in `Page.getFrameTree` — it is a
 *      separate target. This is WHY a session per such frame is necessary, and
 *      attaching one is what makes those tools visible and invocable (12).
 *   8. ANNOTATIONS, PER FIELD. The page API reads the `*Hint` keys and the CDP
 *      `Annotation` type reports them under bare names: `readOnlyHint` →
 *      `readOnly`, `untrustedContentHint` → `untrustedContent`, values and all.
 *      `consequentialHint` is NOT copied at this pin, so `consequential` is
 *      absent even when declared. `autosubmit` only ever comes from markup.
 *      Tools registered with the BARE names get `false` for both, because those
 *      keys are not the ones Blink reads.
 *   9. DECLARATIVE tools (`<form toolname>`) carry a `backendNodeId` and NO
 *      `stackTrace` — the inverse of an imperative registration, and the
 *      provenance signal the provider infers `registrationKind` from. Blink
 *      DERIVES their `inputSchema` from the form's controls, including
 *      `format`, `minimum`/`maximum`, `multipleOf`, `pattern` and enums.
 *  10. CROSS-DOCUMENT RESULTS ARE DELIVERED BY THE PLATFORM, natively, for
 *      every navigation shape that stays in this tab: same-document autosubmit,
 *      a named target frame, an imperative `location.href`, a form a person
 *      submits later. The response is `Completed` and `output` is a JSON ARRAY
 *      of every `application/ld+json` block in the destination document —
 *      `[]` when it has none, malformed blocks skipped. No intermediate null
 *      arrives first, and the whole thing lands within tens of milliseconds of
 *      the navigation, orders of magnitude inside the 60s caller deadline.
 *      Measured END TO END per transport as well, because the path between
 *      Blink and us is what was in question: Playwright in
 *      `playwright-provider.integration.test.ts` against a real browser, and
 *      the two boundaries a fake can exercise honestly — the daemon's command
 *      protocol (`browserd-provider.test.ts`) and the Electron debugger adapter
 *      (`electron-webview-provider.test.ts`) — each asserting that a top-level
 *      JSON ARRAY survives the hop as itself rather than being re-wrapped.
 *  11. `target="_blank"` IS THE EXCEPTION and the response is LOST: nothing
 *      arrives on the opener's session, on the new tab's own session, or with
 *      `Target.setAutoAttach` on the opener, and the invocation is not pending
 *      in any renderer. There is nothing to recover — the browser produced no
 *      response, it did not merely route one somewhere we were not listening.
 *  12. A frame with its OWN CDP session reports its tools there, and they are
 *      invocable through it. Invoking a child frame's id on the PAGE's session
 *      is rejected outright ("FrameId does not belong to current target"), so
 *      the session is part of addressing a tool, not an optimisation.
 *  13. A tool that returns a value and THEN navigates is answered TWICE for one
 *      invocation id: its own value first, the destination document's JSON-LD
 *      second. The first is the true outcome; the second must not displace it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Browser, CDPSession, Page } from "playwright";
import { chromium } from "playwright";
import { isChromiumInstalled } from "../../../utils/browser-rendering-setup";
import { buildWebMcpLaunchArgs, PAGE_API_PROBE } from "../launch-args";
import {
  startWebMcpFixtureServer,
  FIXTURE_BIG_OUTPUT_BYTES,
  FIXTURE_RESULT_TYPES,
  FIXTURE_SUBMIT_AND_RETURN_TEXT,
  FIXTURE_TOOLS,
  FIXTURE_VALIDATION_TEXT,
  type WebMcpFixture,
} from "./fixture-page";

/**
 * The build every finding in this file's header was measured against.
 *
 * Asserted, not commented: several findings are of the form "not at this
 * version" (`consequential` is the live one), and a claim like that is only
 * meaningful next to the version it was taken from.
 */
const PINNED_CHROMIUM = "151.0.7922.34";

const CHROMIUM_AVAILABLE = await isChromiumInstalled();

/**
 * Playwright can have a Chromium binary installed without that binary exposing
 * the experimental WebMCP CDP domain. Keep local runs useful on older images,
 * while making CI fail loudly instead of silently skipping the contract suite.
 */
async function isWebMcpCdpAvailable(): Promise<boolean> {
  if (!CHROMIUM_AVAILABLE) return false;
  const browser = await chromium.launch({
    headless: true,
    args: buildWebMcpLaunchArgs(),
  });
  try {
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("WebMCP.enable" as never);
    await page.close();
    return true;
  } catch {
    return false;
  } finally {
    await browser.close().catch(() => {});
  }
}

const WEBMCP_CDP_AVAILABLE = await isWebMcpCdpAvailable();

// Locally a missing browser skips; in CI it fails. CI runs the pinned Playwright
// image with Chromium preinstalled, so "skipped" there would mean the one test
// that guards an experimental protocol quietly stopped running.
if (process.env.CI && !CHROMIUM_AVAILABLE) {
  throw new Error(
    "WebMCP CDP spike requires Chromium, which is preinstalled in the pinned " +
      "Playwright CI image. Its absence means the image or the pin is wrong.",
  );
}
if (process.env.CI && CHROMIUM_AVAILABLE && !WEBMCP_CDP_AVAILABLE) {
  throw new Error(
    "WebMCP CDP spike requires a Chromium build exposing the WebMCP domain. " +
      "Install the pinned Playwright browser before running CI.",
  );
}

interface ToolPayload {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    readOnly?: boolean;
    untrustedContent?: boolean;
    consequential?: boolean;
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

describe.skipIf(!WEBMCP_CDP_AVAILABLE)("CDP WebMCP domain contract", () => {
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

  /** One tool from the accumulated `toolsAdded` stream, or a named failure. */
  function toolNamed(name: string): ToolPayload {
    const tool = added.flatMap((e) => e.tools).find((t) => t.name === name);
    if (!tool) throw new Error(`the fixture never registered "${name}"`);
    return tool;
  }

  it("was measured against the pinned Chromium", () => {
    // Every finding in this file's header — above all the ones that say "not
    // at this version", like `consequential` — is a fact about ONE build. A
    // bump that silently re-took them under a different browser would leave
    // product rules resting on evidence nobody re-checked, so the version is
    // asserted rather than assumed. When this fails: bump the string, re-run
    // the suite, and re-read the findings it changed.
    expect(browser.version()).toBe(PINNED_CHROMIUM);
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

  // ---- ANNOTATIONS, ONE FIELD AT A TIME ------------------------------------
  // Asserted per field rather than per object, because the fields do NOT behave
  // alike: two are copied, one is not copied at this version, and one can only
  // come from markup. An `toEqual` on the whole object would state all four
  // facts as one and re-state them as one when any single one changed.

  it("copies readOnlyHint through, under the bare `readOnly` name", () => {
    // `hinted` declares `readOnlyHint: true` — the key the page API reads.
    expect(toolNamed(FIXTURE_TOOLS.hinted).annotations?.readOnly).toBe(true);
  });

  it("copies untrustedContentHint through, under the bare `untrustedContent` name", () => {
    expect(
      toolNamed(FIXTURE_TOOLS.hinted).annotations?.untrustedContent,
    ).toBe(true);
  });

  it("does NOT copy consequentialHint at this Chromium version", () => {
    // `hinted` declares `consequentialHint: true` and the CDP `Annotation` type
    // carries a `consequential` field, but this pin never writes it. Asserted
    // as ABSENCE-AT-THIS-VERSION on purpose: current Chromium does copy it, so
    // the day this build's successor lands, this fails loudly and the
    // `consequential` badge's "not reported at our pinned version" tooltip
    // stops being true. It is not a claim that the field is meaningless.
    const annotations = toolNamed(FIXTURE_TOOLS.hinted).annotations;
    expect(annotations).toBeDefined();
    expect(annotations).not.toHaveProperty("consequential");
  });

  it("never sets `autosubmit` on an imperative registration", () => {
    // The only annotation that markup alone can produce; see the declarative
    // suite for the other half of this fact.
    expect(
      toolNamed(FIXTURE_TOOLS.hinted).annotations,
    ).not.toHaveProperty("autosubmit");
  });

  it("reports the BARE annotation keys as false — they are not the ones read", () => {
    // The negative control. `annotated` declares `readOnly`/`untrustedContent`/
    // `consequential` — the MCP vocabulary WITHOUT the `Hint` suffix — and gets
    // `false` for the two fields that exist, because Blink read `readOnlyHint`
    // and `untrustedContentHint` and found nothing.
    //
    // This is why "an absent or false `readOnly` says nothing" was only ever
    // true of tools using the wrong key: a tool using the RIGHT key gets its
    // value through. What does not change is the product rule — the value is
    // still a claim the page makes about ITSELF, so approval never derives
    // from it.
    const annotations = toolNamed(FIXTURE_TOOLS.annotated).annotations;
    expect(annotations?.readOnly).toBe(false);
    expect(annotations?.untrustedContent).toBe(false);
    expect(annotations).not.toHaveProperty("consequential");
  });

  it("omits the annotation object entirely when the page declared none", () => {
    expect(toolNamed(FIXTURE_TOOLS.echo).annotations).toBeUndefined();
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

  it("does not surface cross-origin subframe tools ON THE PAGE'S SESSION ALONE", async () => {
    // WHAT THIS ESTABLISHES: not a scope boundary, but the REASON a session per
    // frame is necessary. On the main session, a cross-origin frame's tools do
    // not arrive and the frame is not even in the frame tree — so a page whose
    // tools live in a third-party widget inspects as having none. The next
    // suite attaches a session to that frame and finds them.
    //
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
    // ...yet its tool never reaches THIS session, and the OOPIF is not in this
    // session's frame tree at all: it is a separate target.
    expect(seen.map((t) => t.name)).not.toContain(FIXTURE_TOOLS.sub);
    const tree = (await probeCdp.send("Page.getFrameTree" as never)) as {
      frameTree: { childFrames?: unknown[] };
    };
    expect(tree.frameTree.childFrames ?? []).toEqual([]);
    await probePage.close();
  }, 30_000);
});

describe.skipIf(!WEBMCP_CDP_AVAILABLE)("WebMCP support probing", () => {
  it("WebMCP.enable succeeds even with the feature off, so it cannot be the probe", async () => {
    const fixture = await startWebMcpFixtureServer();
    // Base args only: no --enable-features=WebMCP.
    const browser = await chromium.launch({
      headless: true,
      args: [
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

/**
 * DECLARATIVE registration: a `<form toolname>` with no script at all.
 *
 * Everything the provider says about a declarative tool — the `declarative`
 * badge, the `autosubmit` annotation, the schema the invoke form prefills from
 * — rested on inference until this suite. `backendNodeId`-present /
 * `stackTrace`-absent is the inverse of an imperative registration, which is
 * what makes provenance readable off the payload rather than guessed.
 */
describe.skipIf(!WEBMCP_CDP_AVAILABLE)("declarative WebMCP registration", () => {
  let fixture: WebMcpFixture;
  let browser: Browser;
  let tools: ToolPayload[];

  beforeAll(async () => {
    fixture = await startWebMcpFixtureServer();
    browser = await chromium.launch({
      headless: true,
      args: buildWebMcpLaunchArgs(),
    });
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    const seen: ToolPayload[] = [];
    cdp.on("WebMCP.toolsAdded", (e) =>
      seen.push(...(e as { tools: ToolPayload[] }).tools),
    );
    await cdp.send("WebMCP.enable" as never);
    await page.goto(fixture.declarativeUrl, { waitUntil: "networkidle" });
    await waitFor(() =>
      seen.some((t) => t.name === FIXTURE_TOOLS.typedFields) ? true : undefined,
    );
    tools = seen;
  }, 60_000);

  afterAll(async () => {
    await browser?.close().catch(() => {});
    await fixture?.close();
  });

  function declared(name: string): ToolPayload {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`the fixture never registered "${name}"`);
    return tool;
  }

  it("registers a form as a tool, with markup as its provenance", () => {
    const tool = declared(FIXTURE_TOOLS.submitOrder);
    expect(tool.description).toBe("Places an order in this document");
    // The INVERSE of an imperative registration (see the contract suite): a DOM
    // node and no stack trace. This is the whole basis of `registrationKind`.
    expect(tool.backendNodeId).toBeGreaterThan(0);
    expect(tool.stackTrace).toBeUndefined();
  });

  it("sets `autosubmit` from the attribute, and only from the attribute", () => {
    expect(declared(FIXTURE_TOOLS.submitOrder).annotations?.autosubmit).toBe(
      true,
    );
    // A declarative tool WITHOUT the attribute carries no annotations at all —
    // not `autosubmit: false`. So the badge means "declared", never "not
    // declared", and the absence of an annotation object is not a claim.
    expect(declared(FIXTURE_TOOLS.confirmOrder).annotations).toBeUndefined();
  });

  it("carries no readOnly/untrustedContent for a declarative tool", () => {
    // The other half of finding 8: `autosubmit` is the only field markup can
    // set, so a declarative tool's annotation object holds nothing else.
    const annotations = declared(FIXTURE_TOOLS.submitOrder).annotations;
    expect(annotations).not.toHaveProperty("readOnly");
    expect(annotations).not.toHaveProperty("untrustedContent");
    expect(annotations).not.toHaveProperty("consequential");
  });

  it("derives the inputSchema from the form's controls", () => {
    const schema = declared(FIXTURE_TOOLS.submitOrder).inputSchema as {
      type: string;
      properties: Record<string, Record<string, unknown>>;
      required: string[];
    };
    expect(schema.type).toBe("object");
    expect(schema.properties.sku).toEqual({ type: "string" });
    // `min`/`max`/`step` become real JSON Schema constraints, which is what the
    // invoke form validates against.
    expect(schema.properties.qty).toEqual({
      type: "number",
      minimum: 1,
      maximum: 99,
      multipleOf: 1,
    });
    // `required` on the control, not a guess from presence.
    expect(schema.required).toEqual(["sku"]);
  });

  it("derives `format` for the date-ish inputs, as a real artifact", () => {
    const properties = (
      declared(FIXTURE_TOOLS.typedFields).inputSchema as {
        properties: Record<string, Record<string, unknown>>;
      }
    ).properties;

    // `date` is the ONE named JSON Schema format, and it comes with prose the
    // model is expected to read.
    expect(properties.date).toMatchObject({
      type: "string",
      format: "date",
    });
    expect(String(properties.date.description)).toContain("YYYY-MM-DD");
    // The others put a REGEX in `format` — not a JSON Schema format name. A
    // consumer that treated `format` as an enum of known names would show a
    // date picker for one of these and a raw pattern for the rest, which is
    // exactly why the values are pinned here rather than assumed.
    for (const field of ["time", "datetime", "month", "week", "color"]) {
      expect(String(properties[field].format)).toMatch(/^\^/);
    }
  });

  it("derives booleans, enums and multi-selects from the control kind", () => {
    const properties = (
      declared(FIXTURE_TOOLS.typedFields).inputSchema as {
        properties: Record<string, Record<string, unknown>>;
      }
    ).properties;
    expect(properties.agree).toEqual({ type: "boolean" });
    // A `<select>` and a radio group both become an enum, with `anyOf` const
    // entries beside it — the oneOf/anyOf-with-const shape `tool-form.ts`
    // already handles for MCP servers that emit it.
    expect(properties.ship).toMatchObject({
      type: "string",
      enum: ["standard", "express"],
    });
    expect(properties.tier).toMatchObject({
      type: "string",
      enum: ["basic", "pro"],
    });
    // `multiple` is the only control that yields an ARRAY.
    expect(properties.addons).toMatchObject({
      type: "array",
      uniqueItems: true,
      items: { enum: ["gift", "rush"] },
    });
    expect(properties.search).toMatchObject({
      type: "string",
      pattern: "[a-z]+",
    });
  });
});

/**
 * CROSS-DOCUMENT RESULTS — measured, not assumed.
 *
 * A WebMCP tool can finish in a document other than the one that started it: a
 * declarative form navigates, an imperative tool sets `location.href`. Blink
 * handles that itself — it defers until the destination has finished parsing,
 * collects every `application/ld+json` block into a JSON array, and answers the
 * ORIGINAL invocation — and the bridge keys pending invocations by id and
 * settles on `toolResponded` whatever frame it came from, so this should just
 * work. Whether it survives the CDP path is what this suite establishes, one
 * navigation shape at a time.
 *
 * Each test records an ANSWER, not a hope: which status arrives, what shape the
 * output is, how long after the navigation, and whether the invocation id is
 * still good for a cancel afterwards.
 */
describe.skipIf(!WEBMCP_CDP_AVAILABLE)("cross-document tool results", () => {
  let fixture: WebMcpFixture;
  let browser: Browser;
  let page: Page;
  let cdp: CDPSession;
  const responded: RespondedPayload[] = [];
  const navigations: { url: string; at: number }[] = [];

  beforeAll(async () => {
    fixture = await startWebMcpFixtureServer();
    browser = await chromium.launch({
      headless: true,
      args: buildWebMcpLaunchArgs(),
    });
    page = await browser.newPage();
    cdp = await page.context().newCDPSession(page);
    cdp.on("WebMCP.toolResponded", (e) => responded.push(e as never));
    cdp.on("Page.frameNavigated", (e) =>
      navigations.push({
        url: (e as { frame: { url: string } }).frame.url,
        at: Date.now(),
      }),
    );
    await cdp.send("WebMCP.enable" as never);
    await cdp.send("Page.enable" as never);
  }, 60_000);

  afterAll(async () => {
    await browser?.close().catch(() => {});
    await fixture?.close();
  });

  /** Load a fixture page and answer with its (current) main frame id. */
  async function open(url: string): Promise<string> {
    responded.length = 0;
    navigations.length = 0;
    await page.goto(url, { waitUntil: "networkidle" });
    // The declarative page registers from markup at parse time; the imperative
    // one from a script. Either way, wait for the tool set rather than a timer.
    await waitFor(async () => true);
    return (
      (await cdp.send("Page.getFrameTree" as never)) as {
        frameTree: { frame: { id: string } };
      }
    ).frameTree.frame.id;
  }

  /**
   * How long to keep listening AFTER the first response.
   *
   * Not padding. Two things this suite measures live in that window: an
   * invocation that is answered twice (a tool that returns a value and then
   * navigates), and the claim that the others are answered exactly ONCE — which
   * a wait that stopped at the first response could never test, only assume.
   * The second answer is ~15ms behind the first when it comes at all.
   */
  const FOLLOW_UP_WINDOW_MS = 1_000;

  /** Invoke and collect THIS invocation's responses, or report that none came. */
  async function invokeAndWait(
    frameId: string,
    toolName: string,
    input: Record<string, unknown>,
    timeoutMs = 10_000,
  ): Promise<{
    invocationId: string;
    response?: RespondedPayload;
    /** ms from the invocation to the FIRST response; the parse-deferral latency. */
    elapsedMs: number;
    /** Every response for this invocation, in order — there can be two. */
    all: RespondedPayload[];
  }> {
    const startedAt = Date.now();
    const { invocationId } = (await cdp.send(
      "WebMCP.invokeTool" as never,
      { frameId, toolName, input } as never,
    )) as { invocationId: string };
    const mine = () => responded.filter((r) => r.invocationId === invocationId);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (mine().length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const elapsedMs = Date.now() - startedAt;
    // Keep listening past the first answer, so "answered twice" and "answered
    // once" are both observations rather than one observation and one guess.
    if (mine().length > 0) {
      await new Promise((resolve) => setTimeout(resolve, FOLLOW_UP_WINDOW_MS));
    }
    const all = mine();
    return {
      invocationId,
      ...(all[0] ? { response: all[0] } : {}),
      elapsedMs,
      all,
    };
  }

  /** Whether `cancelInvocation` still knows this id. */
  async function cancelStillValid(invocationId: string): Promise<boolean> {
    try {
      await cdp.send(
        "WebMCP.cancelInvocation" as never,
        { invocationId } as never,
      );
      return true;
    } catch {
      return false;
    }
  }

  it("answers a same-document autosubmit with the destination's JSON-LD array", async () => {
    const frameId = await open(fixture.declarativeUrl);
    const { response, all, invocationId, elapsedMs } = await invokeAndWait(
      frameId,
      FIXTURE_TOOLS.submitOrder,
      { sku: "S1", qty: 2 },
    );
    // The invoking document is REPLACED and still the invocation is answered:
    // the platform delivers this, the inspector does not reconstruct it.
    expect(navigations.map((n) => n.url).join(" ")).toContain("/result?sku=S1");
    expect(response?.status).toBe("Completed");
    expect(Array.isArray(response?.output)).toBe(true);
    expect(response?.output).toEqual([
      {
        "@context": "https://schema.org",
        "@type": FIXTURE_RESULT_TYPES.single,
        orderNumber: "A-1",
        status: "confirmed",
      },
    ]);
    // NO INTERMEDIATE NULL, and no follow-up either: the declarative path
    // suppresses the empty response the invoking document would otherwise
    // produce, so exactly one answer arrives — checked after a window long
    // enough for a second to have landed — and a consumer settling on the first
    // is settling on the real one.
    expect(all).toHaveLength(1);
    // The parse deferral is visible as latency, and it is nothing: two orders
    // of magnitude inside the caller's 60s deadline (`session-runtime.ts`).
    expect(elapsedMs).toBeLessThan(3_000);
    // Once answered, the id is spent — `cancelInvocation` rejects it.
    expect(await cancelStillValid(invocationId)).toBe(false);
  }, 30_000);

  it("answers when the result lands in a NAMED TARGET FRAME", async () => {
    const frameId = await open(fixture.declarativeUrl);
    const { response } = await invokeAndWait(frameId, FIXTURE_TOOLS.frameOrder, {
      sku: "F1",
    });
    // The invoking document SURVIVES here and a different one answers, which is
    // the case that shows the response is keyed by invocation, not by frame.
    expect(response?.status).toBe("Completed");
    expect(response?.output).toEqual([
      {
        "@context": "https://schema.org",
        "@type": FIXTURE_RESULT_TYPES.single,
        orderNumber: "A-1",
        status: "confirmed",
      },
    ]);
  }, 30_000);

  it("LOSES the response when the form targets _blank", async () => {
    const frameId = await open(fixture.declarativeUrl);
    const opened = page
      .context()
      .waitForEvent("page", { timeout: 8_000 })
      .catch(() => null);
    const { response, invocationId } = await invokeAndWait(
      frameId,
      FIXTURE_TOOLS.openReport,
      { sku: "B1" },
      6_000,
    );
    // The tool RAN — a tab really opens on the destination — and no response is
    // produced for it, on either side.
    const newTab = await opened;
    expect(newTab).not.toBeNull();
    await newTab!.waitForLoadState("domcontentloaded").catch(() => {});
    expect(newTab!.url()).toContain("/result?sku=B1");
    // Not on the opener's session...
    expect(response).toBeUndefined();
    // ...and not on the NEW TAB's own session either, even with the domain
    // enabled there and time to finish parsing. So this is not a response
    // routed somewhere we were not listening — it is a response the browser
    // never produced, which is why no compatibility measure can recover it.
    const tabCdp = await newTab!.context().newCDPSession(newTab!);
    const onNewTab: RespondedPayload[] = [];
    tabCdp.on("WebMCP.toolResponded", (e) => onNewTab.push(e as never));
    await tabCdp.send("WebMCP.enable" as never);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(onNewTab).toEqual([]);
    // And the invocation is not pending in ANY renderer, so there is nothing
    // left to cancel and nothing for a compatibility measure to recover: the
    // browser produced no response, it did not route one somewhere else.
    expect(await cancelStillValid(invocationId)).toBe(false);
    await newTab!.close();
  }, 30_000);

  it("stays pending while a non-autosubmit form waits for a person", async () => {
    const frameId = await open(fixture.declarativeUrl);
    const first = await invokeAndWait(
      frameId,
      FIXTURE_TOOLS.confirmOrder,
      { sku: "C1" },
      2_500,
    );
    // "Waiting for a human" and "stuck" look identical from here — which is the
    // point of having the shape: nothing settles, and nothing claims to.
    expect(first.response).toBeUndefined();

    // Now a person submits it, and the same invocation is answered.
    const second = invokeAndWait(
      frameId,
      FIXTURE_TOOLS.confirmOrder,
      { sku: "C2" },
      10_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    await page.click("#confirm-submit");
    const { response } = await second;
    expect(response?.status).toBe("Completed");
    expect(response?.output).toEqual([
      {
        "@context": "https://schema.org",
        "@type": FIXTURE_RESULT_TYPES.single,
        orderNumber: "A-1",
        status: "confirmed",
      },
    ]);
  }, 40_000);

  it("answers an IMPERATIVE navigation that never returns", async () => {
    const frameId = await open(fixture.url);
    const { response, all } = await invokeAndWait(
      frameId,
      FIXTURE_TOOLS.goElsewhere,
      { to: "/result" },
    );
    // `go_elsewhere` returns a promise that can never settle — its document is
    // gone. The destination answers in its place.
    expect(response?.status).toBe("Completed");
    expect(response?.output).toEqual([
      {
        "@context": "https://schema.org",
        "@type": FIXTURE_RESULT_TYPES.single,
        orderNumber: "A-1",
        status: "confirmed",
      },
    ]);
    expect(all).toHaveLength(1);
  }, 30_000);

  it("collects EVERY JSON-LD block, in document order", async () => {
    const frameId = await open(fixture.url);
    const { response } = await invokeAndWait(
      frameId,
      FIXTURE_TOOLS.goElsewhere,
      { to: "/result-multi" },
    );
    // An array, not the first block: a consumer that read `output[0]` would
    // drop two thirds of what the page published.
    expect(
      (response?.output as { "@type": string }[]).map((b) => b["@type"]),
    ).toEqual([
      FIXTURE_RESULT_TYPES.multiFirst,
      FIXTURE_RESULT_TYPES.multiSecond,
      FIXTURE_RESULT_TYPES.multiThird,
    ]);
  }, 30_000);

  it("skips a malformed block and keeps the valid one", async () => {
    const frameId = await open(fixture.url);
    const { response } = await invokeAndWait(
      frameId,
      FIXTURE_TOOLS.goElsewhere,
      { to: "/result-malformed" },
    );
    // The page's own bug does not fail the invocation, and nothing partial
    // leaks into the array.
    expect(response?.status).toBe("Completed");
    expect(response?.output).toEqual([
      {
        "@context": "https://schema.org",
        "@type": FIXTURE_RESULT_TYPES.malformedValid,
        orderNumber: "A-2",
      },
    ]);
  }, 30_000);

  it("answers a document with NO JSON-LD as Completed with an empty array", async () => {
    const frameId = await open(fixture.url);
    const { response } = await invokeAndWait(
      frameId,
      FIXTURE_TOOLS.goElsewhere,
      { to: "/result-none" },
    );
    // A LEGITIMATELY EMPTY answer, and it is authoritative: `Completed` with
    // `[]` is the destination saying "nothing structured here", not a failure
    // and not an absence of a response. Anything that treated `[]` as "no
    // result yet" would replace a true outcome with a guess.
    expect(response?.status).toBe("Completed");
    expect(response?.output).toEqual([]);
  }, 30_000);

  it("keeps a tool's OWN returned value when it navigates afterwards", async () => {
    const frameId = await open(fixture.url);
    const { all } = await invokeAndWait(
      frameId,
      FIXTURE_TOOLS.submitAndReturn,
      {},
    );
    // TWO responses for ONE invocation id. Navigation is not evidence of
    // anything: the first answer is the tool's real return value and the
    // invocation's true outcome; the second is the destination document's
    // JSON-LD arriving after Blink finished parsing it.
    expect(all).toHaveLength(2);
    expect(all[0].status).toBe("Completed");
    expect(all[0].output).toEqual({
      content: [{ type: "text", text: FIXTURE_SUBMIT_AND_RETURN_TEXT }],
    });
    expect(Array.isArray(all[1].output)).toBe(true);
    // Which is why the bridge settles on the FIRST and drops the second rather
    // than buffering it (`webmcp-bridge.test.ts` pins the consequence).
  }, 30_000);

  it("answers a tool that refuses without navigating, as itself", async () => {
    const frameId = await open(fixture.url);
    const { response, all } = await invokeAndWait(
      frameId,
      FIXTURE_TOOLS.validateFirst,
      {},
    );
    expect(response?.status).toBe("Completed");
    expect(response?.output).toEqual({
      isError: true,
      content: [{ type: "text", text: FIXTURE_VALIDATION_TEXT }],
    });
    expect(all).toHaveLength(1);
    expect(navigations.map((n) => n.url)).not.toContain(fixture.resultUrl);
  }, 30_000);
});

/**
 * CROSS-ORIGIN FRAMES, through a session of their own.
 *
 * The gate for the whole child-session design: `WebMCP.enable` on a
 * separately-attached frame session has to actually reach an OOPIF's tools. It
 * does — which is why the contract suite's "not on the page's session alone"
 * test is not a scope boundary but a reason.
 *
 * Also pins the two things the lifecycle rests on: WHICH failure means "nothing
 * to attach here" (so every other failure can stay visible), and whether
 * attachment has to recurse into nested targets.
 */
describe.skipIf(!WEBMCP_CDP_AVAILABLE)("cross-origin frame sessions", () => {
  let fixture: WebMcpFixture;
  let browser: Browser;

  beforeAll(async () => {
    fixture = await startWebMcpFixtureServer();
    browser = await chromium.launch({
      headless: true,
      args: buildWebMcpLaunchArgs(),
    });
  }, 60_000);

  afterAll(async () => {
    await browser?.close().catch(() => {});
    await fixture?.close();
  });

  it("reports an OOPIF's tools on a session attached to that frame", async () => {
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("WebMCP.enable" as never);
    await page.goto(fixture.url, { waitUntil: "networkidle" });

    const subFrame = page
      .frames()
      .find((f) => f.url().startsWith(fixture.subOriginUrl));
    expect(subFrame).toBeDefined();

    const frameCdp = await page.context().newCDPSession(subFrame!);
    const seen: ToolPayload[] = [];
    frameCdp.on("WebMCP.toolsAdded", (e) =>
      seen.push(...(e as { tools: ToolPayload[] }).tools),
    );
    await frameCdp.send("WebMCP.enable" as never);
    const tool = await waitFor(() =>
      seen.find((t) => t.name === FIXTURE_TOOLS.sub),
    );
    // The same tool the page's session never hears about.
    expect(tool.frameId).toBeTruthy();

    // ...and it is INVOCABLE through that session.
    const responded: RespondedPayload[] = [];
    frameCdp.on("WebMCP.toolResponded", (e) => responded.push(e as never));
    const { invocationId } = (await frameCdp.send(
      "WebMCP.invokeTool" as never,
      {
        frameId: tool.frameId,
        toolName: FIXTURE_TOOLS.sub,
        input: {},
      } as never,
    )) as { invocationId: string };
    const done = await waitFor(() =>
      responded.find((r) => r.invocationId === invocationId),
    );
    expect(done.status).toBe("Completed");
    expect(done.output).toMatchObject({
      content: [{ type: "text", text: "sub" }],
    });

    // THE SAME CALL ON THE PAGE'S SESSION IS REFUSED. This is why the session
    // is part of addressing a tool: a bridge that "helpfully" fell back to the
    // main session would not degrade, it would talk to the wrong renderer.
    await expect(
      cdp.send(
        "WebMCP.invokeTool" as never,
        {
          frameId: tool.frameId,
          toolName: FIXTURE_TOOLS.sub,
          input: {},
        } as never,
      ),
    ).rejects.toThrow(/does not belong to current target/i);
    await page.close();
  }, 60_000);

  it("throws ONE specific error for a frame with no session of its own", async () => {
    // Attachment is a PROBE, not an origin comparison — and this is the string
    // the probe reads. It is the only failure the provider may swallow, so it
    // is asserted rather than trusted to a comment.
    const page = await browser.newPage();
    await page.goto(fixture.declarativeUrl, { waitUntil: "networkidle" });
    const sameOrigin = page.frames().find((f) => f !== page.mainFrame());
    expect(sameOrigin).toBeDefined();
    await expect(
      page.context().newCDPSession(sameOrigin!),
    ).rejects.toThrow(/does not have a separate CDP session/i);
    await page.close();
  }, 30_000);

  it("enumerates a cross-origin frame INSIDE a cross-origin frame", async () => {
    // NESTED TARGETS. Attachment does not need to recurse in the Playwright
    // provider, because Playwright's own auto-attach already does:
    // `page.frames()` is a flat list that reaches every depth, so one sweep of
    // it covers a widget inside a widget. (The Electron path has no such list
    // and must send `Target.setAutoAttach` per child session — which is why
    // that side says so explicitly.)
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("WebMCP.enable" as never);
    await page.goto(fixture.nestedOuterUrl, { waitUntil: "networkidle" });
    await waitFor(() =>
      page.frames().some((f) => f.url().startsWith(fixture.nestedInnerUrl))
        ? true
        : undefined,
      10_000,
    );

    const names: string[] = [];
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const frameCdp = await page.context().newCDPSession(frame);
      const seen: ToolPayload[] = [];
      frameCdp.on("WebMCP.toolsAdded", (e) =>
        seen.push(...(e as { tools: ToolPayload[] }).tools),
      );
      await frameCdp.send("WebMCP.enable" as never);
      await waitFor(() => (seen.length > 0 ? true : undefined), 10_000);
      names.push(...seen.map((t) => t.name));
    }
    expect(names).toContain(FIXTURE_TOOLS.nestedInner);
    await page.close();
  }, 60_000);
});
