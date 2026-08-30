/**
 * The whole server stack against a real browser: provider, runtime, registry.
 *
 * The spike test proves what the CDP domain does; this proves that our
 * translation of it is right — that tools become stable keys, that a hanging
 * tool times out, that navigation does not leave ghosts in the registry.
 *
 * Runs headless. A user-facing session is headed, but headed needs a display
 * and would make this suite unrunnable in CI.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { chromium } from "playwright";
import { isChromiumInstalled } from "../../../utils/browser-rendering-setup";
import { startWebMcpSession, WebMcpSessionRegistry } from "../session-registry";
import { PlaywrightWebMcpProvider } from "../playwright-provider";
import { WebMcpToolGoneError } from "../provider";
import type { WebMcpActivityEntry } from "@/shared/webmcp-inspector-protocol";
import { startWebMcpFixtureServer, type WebMcpFixture } from "./fixture-page";
import { buildWebMcpLaunchArgs } from "../launch-args";

const CHROMIUM_AVAILABLE = await isChromiumInstalled();
const WEBMCP_CDP_AVAILABLE = await (async () => {
  if (!CHROMIUM_AVAILABLE) return false;
  const browser = await chromium.launch({
    headless: true,
    args: buildWebMcpLaunchArgs(),
  });
  try {
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("WebMCP.enable" as never);
    return true;
  } catch {
    return false;
  } finally {
    await browser.close().catch(() => {});
  }
})();
if (process.env.CI && !CHROMIUM_AVAILABLE) {
  throw new Error(
    "WebMCP provider integration requires Chromium, preinstalled in the pinned CI image.",
  );
}
if (process.env.CI && CHROMIUM_AVAILABLE && !WEBMCP_CDP_AVAILABLE) {
  throw new Error(
    "WebMCP provider integration requires a Chromium build exposing the " +
      "WebMCP domain. Install the pinned Playwright browser before running CI.",
  );
}

/** Headless for tests; a real session opens a window the developer drives. */
class HeadlessProvider extends PlaywrightWebMcpProvider {
  async createSession(
    options: Parameters<PlaywrightWebMcpProvider["createSession"]>[0],
  ) {
    return super.createSession({ ...options, headless: true });
  }
}

describe.skipIf(!WEBMCP_CDP_AVAILABLE)("WebMCP provider — real browser", () => {
  let fixture: WebMcpFixture;
  let registry: WebMcpSessionRegistry;
  const provider = new HeadlessProvider();

  beforeAll(async () => {
    fixture = await startWebMcpFixtureServer();
  }, 60_000);

  afterAll(async () => {
    await registry?.disposeAll({ permanent: true });
    await fixture?.close();
  });

  afterEach(async () => {
    await registry?.disposeAll();
  });

  async function open() {
    registry = new WebMcpSessionRegistry({ sweepIntervalMs: 0 });
    const session = await startWebMcpSession({
      url: fixture.url,
      provider,
      registry,
      headless: true,
    });
    const runtime = registry.get(session.sessionId);
    const activity: WebMcpActivityEntry[] = [];
    runtime.hub.subscribe((event) => {
      if (event.type === "activity") activity.push(event.entry);
    }, 0);
    return { session, runtime, activity };
  }

  it("discovers the page's tools with stable keys and provenance", async () => {
    const { runtime } = await open();
    await vi.waitFor(() =>
      expect(runtime.currentTools().length).toBeGreaterThanOrEqual(5),
    );

    const tools = runtime.currentTools();
    const echo = tools.find((tool) => tool.name === "echo");
    expect(echo).toBeDefined();
    expect(echo!.toolKey).toBe(`${new URL(fixture.url).origin}::echo`);
    expect(echo!.fromSubframe).toBe(false);
    expect(echo!.registrationKind).toBe("imperative");
    expect(echo!.inputSchema).toMatchObject({ type: "object" });

    // The cross-origin subframe's tool is invisible to this session, as the
    // spike established. V1 scope is main frame plus same-process frames.
    expect(tools.map((tool) => tool.name)).not.toContain("sub_tool");
    await registry.disposeAll();
  }, 60_000);

  it("invokes a tool and reports the result on the timeline", async () => {
    const { runtime, activity } = await open();
    await vi.waitFor(() =>
      expect(runtime.currentTools().length).toBeGreaterThan(0),
    );

    const origin = new URL(fixture.url).origin;
    const { invokeId, settled } = runtime.invoke(
      `${origin}::echo`,
      { text: "hello" },
      "manual",
    );
    const result = await settled;
    // The MCP-shaped result object survives the CDP hop intact.
    expect(result.output).toMatchObject({
      content: [{ type: "text", text: 'echo:{"text":"hello"}' }],
    });

    await vi.waitFor(() => {
      const done = activity.find(
        (entry) =>
          entry.kind === "invocation_settled" && entry.invokeId === invokeId,
      );
      expect(done).toBeDefined();
      expect(done && "state" in done ? done.state : undefined).toBe(
        "succeeded",
      );
    });
    await registry.disposeAll();
  }, 60_000);

  it("surfaces a thrown page tool as a failure with its message", async () => {
    const { runtime } = await open();
    await vi.waitFor(() =>
      expect(runtime.currentTools().length).toBeGreaterThan(0),
    );
    const origin = new URL(fixture.url).origin;

    await expect(
      runtime.invoke(`${origin}::boom`, {}, "manual").settled,
    ).rejects.toThrow(/intentional failure/);
    await registry.disposeAll();
  }, 60_000);

  it("times out a tool that never responds, and stays usable afterwards", async () => {
    registry = new WebMcpSessionRegistry({ sweepIntervalMs: 0 });
    const session = await startWebMcpSession({
      url: fixture.url,
      provider,
      registry,
      headless: true,
    });
    const runtime = registry.get(session.sessionId);
    // A short timeout keeps the suite quick; the production default is 60s.
    Reflect.set(runtime, "invokeTimeoutMs", 2_000);
    await vi.waitFor(() =>
      expect(runtime.currentTools().length).toBeGreaterThan(0),
    );
    const origin = new URL(fixture.url).origin;

    await expect(
      runtime.invoke(`${origin}::slow`, {}, "manual").settled,
    ).rejects.toThrow(/did not respond in time|cancel/i);

    // The session must survive a hung tool: the next call still works.
    const after = await runtime.invoke(
      `${origin}::echo`,
      { text: "after" },
      "manual",
    ).settled;
    expect(JSON.stringify(after.output)).toContain("after");
    await registry.disposeAll();
  }, 60_000);

  it("truncates an oversized result at the cap", async () => {
    const { runtime } = await open();
    await vi.waitFor(() =>
      expect(runtime.currentTools().length).toBeGreaterThan(0),
    );
    const origin = new URL(fixture.url).origin;

    const { truncated, output } = await runtime.invoke(
      `${origin}::big`,
      {},
      "manual",
    ).settled;
    expect(truncated).toBe(true);
    expect(String(output)).toContain("truncated");
    await registry.disposeAll();
  }, 60_000);

  it("drops the old page's tools on navigation", async () => {
    const { runtime } = await open();
    await vi.waitFor(() =>
      expect(runtime.currentTools().length).toBeGreaterThan(0),
    );

    await runtime.navigateCommand({ type: "navigate", url: fixture.nextUrl });

    // Chromium reports no removal here, so this only passes because the
    // provider synthesizes it. Without that, `echo` would linger forever and
    // invoking it would fail against a page that no longer has it.
    await vi.waitFor(() => {
      const names = runtime.currentTools().map((tool) => tool.name);
      expect(names).toContain("page2_tool");
      expect(names).not.toContain("echo");
    });

    const origin = new URL(fixture.url).origin;
    await expect(
      runtime.invoke(`${origin}::echo`, {}, "manual").settled,
    ).rejects.toBeInstanceOf(WebMcpToolGoneError);
    await registry.disposeAll();
  }, 60_000);

  it("reports a headless session as having no viewport", async () => {
    const { session } = await open();
    // The UI reads this to decide whether to tell someone to go look at a
    // window. Claiming `native-window` here would point them at one that does
    // not exist — the state an inspector reached over SSH is always in.
    expect(session.viewportTransport).toEqual({ kind: "headless" });
    await registry.disposeAll();
  }, 60_000);

  it("records session_started before the navigation it caused", async () => {
    const { runtime } = await open();
    await vi.waitFor(() =>
      expect(runtime.currentTools().length).toBeGreaterThan(0),
    );
    const kinds = runtime.hub
      .buffered()
      .flatMap((event) =>
        event.type === "activity" ? [event.entry.kind] : [],
      );
    // The browser navigates and registers tools while starting up, so an entry
    // written after `attach` would land behind them and the timeline would read
    // "navigated, tools added, session started".
    expect(kinds[0]).toBe("session_started");
    expect(kinds).toContain("navigated");
    await registry.disposeAll();
  }, 60_000);

  it("captures a screenshot for the timeline", async () => {
    const { runtime } = await open();
    const shot = await runtime.screenshotNow();
    expect(typeof shot).toBe("string");
    expect((shot ?? "").length).toBeGreaterThan(100);
    await registry.disposeAll();
  }, 60_000);
});
