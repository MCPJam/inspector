import { describe, expect, it, vi } from "vitest";
import { buildBrowserdStack } from "../server";
import { HandoffLease } from "../lease";
import { ChromiumDriver } from "../chromium-driver";
import { guardStaleness, type BrowserDriver } from "../browser-driver";
import { fakeContext, fakePage } from "./fake-page";
import type {
  BrowserPaneCommand,
  InteractionAnchor,
} from "../../../../../shared/browser-pane-command";

const driverStub = (): BrowserDriver => ({
  execute: vi.fn(async () => ({ ok: true })),
  currentStateToken: async () => undefined,
  health: async () => ({ ok: true }),
  close: async () => {},
});
const post = (
  stack: ReturnType<typeof buildBrowserdStack>,
  path: string,
  body: unknown,
) =>
  stack.handler.handle({
    method: "POST",
    path,
    origin: undefined,
    authorization: "Bearer test",
    body: JSON.stringify(body),
  });

describe("workspace production guard composition", () => {
  it.each<BrowserPaneCommand>([
    { op: "navigate", url: "https://example.test" },
    { op: "create_tab" },
    { op: "activate_tab", tabId: "t1" },
    { op: "close_tab", tabId: "t1" },
    { op: "back" },
    { op: "forward" },
    { op: "reload" },
  ])(
    "executes an authenticated pane $op through the real queue",
    async (command) => {
      const driver = driverStub();
      const stack = buildBrowserdStack(driver, { token: "test" });
      const response = await post(stack, "/v1/pane-command", {
        holder: "pane",
        command,
      });
      expect(response.status).toBe(200);
      expect(driver.execute).toHaveBeenCalledWith(
        expect.objectContaining({ source: "manual", holder: "pane" }),
      );
    },
  );

  it("fences commands and acquisitions throughout export, including lease expiry", async () => {
    let now = 1000;
    const lease = new HandoffLease({ now: () => now });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const driver = driverStub();
    const stack = buildBrowserdStack(driver, {
      token: "test",
      lease,
      profileExport: async () => {
        await gate;
        return new Uint8Array([31, 139]);
      },
    });
    const exporting = post(stack, "/v1/profile/export", {});
    now += 1_000_000;
    expect(
      (
        await post(stack, "/v1/commands", {
          command: {
            source: "chat",
            commandId: "c1",
            action: { kind: "reload" },
          },
        })
      ).status,
    ).not.toBe(200);
    await post(stack, "/v1/lease", { action: "acquire", holder: "pane" });
    expect(lease.state()).not.toMatchObject({ holder: "pane" });
    expect(driver.execute).not.toHaveBeenCalled();
    release();
    expect((await exporting).status).toBe(200);
    expect(lease.state().state).toBe("free");
  });

  it("releases the export fence after a failed snapshot", async () => {
    const lease = new HandoffLease();
    const stack = buildBrowserdStack(driverStub(), {
      token: "test",
      lease,
      profileExport: async () => {
        throw new Error("flush failed");
      },
    });
    expect((await post(stack, "/v1/profile/export", {})).status).toBe(500);
    expect(lease.state().state).toBe("free");
  });

  it.each([
    "tabId",
    "url",
    "navCounter",
    "viewportRevision",
    "bootId",
  ] as const)("drops takeover input when %s changed", async (field) => {
    const lease = new HandoffLease();
    lease.acquire("pane");
    const current = {
      tabId: "t1",
      url: "https://example.test",
      navCounter: 1,
      viewportRevision: 2,
    };
    const dispatchInput = vi.fn(async () => {});
    const driver = {
      ...driverStub(),
      interactionAnchor: () => current,
      viewport: async () => ({ dispatchInput }),
    } as unknown as BrowserDriver;
    const stack = buildBrowserdStack(driver, { token: "test", lease });
    const anchor: InteractionAnchor = { ...current, bootId: stack.bootId };
    Object.assign(anchor, {
      [field]: typeof anchor[field] === "number" ? 99 : "changed",
    });
    expect(
      (
        await post(stack, "/v1/input", {
          holder: "pane",
          anchor,
          events: [{ type: "mouse_down", x: 10, y: 10, button: "left" }],
        })
      ).status,
    ).toBe(409);
    expect(dispatchInput).not.toHaveBeenCalled();
  });

  it("revalidates an anchor after the viewport await and before each event", async () => {
    const lease = new HandoffLease();
    lease.acquire("pane");
    const current = {
      tabId: "t1",
      url: "https://example.test",
      navCounter: 1,
      viewportRevision: 2,
    };
    let delivered = 0;
    const driver = {
      ...driverStub(),
      interactionAnchor: () => current,
      viewport: async () => ({
        dispatchInput: async (_events: unknown, allowed: () => boolean) => {
          if (allowed()) delivered++;
          current.navCounter++;
          if (allowed()) delivered++;
        },
      }),
    } as unknown as BrowserDriver;
    const stack = buildBrowserdStack(driver, { token: "test", lease });
    const anchor = { ...current, bootId: stack.bootId };
    const result = await post(stack, "/v1/input", {
      holder: "pane",
      anchor,
      events: [],
    });
    expect(result.status).toBe(409);
    expect(delivered).toBe(1);
  });

  it.each(["pane-first", "agent-first"])(
    "negotiates %s sessions and restores fixed mode",
    async (order) => {
      const { context } = fakeContext({ pages: [fakePage()] });
      const driver = new ChromiumDriver(context, {
        viewport: { policy: "fixed", allowPaneResize: true, debounceMs: 0 },
      });
      const stack = buildBrowserdStack(driver, { token: "test" });
      const command = {
        source: "chat" as const,
        commandId: "initial",
        action: { kind: "navigate" as const, url: "https://example.test" },
      };
      if (order === "agent-first")
        expect((await guardStaleness(driver)(command)).ok).toBe(true);
      expect(
        (
          await post(stack, "/v1/viewport", {
            width: 1400,
            height: 900,
            policy: "followPane",
          })
        ).status,
      ).toBe(200);
      expect(driver.sessionViewportState()).toMatchObject({
        width: 1400,
        height: 900,
      });
      expect(
        await guardStaleness(driver)({ ...command, commandId: "legacy" }),
      ).toMatchObject({
        ok: false,
        error: expect.stringContaining("responsive_viewport_required"),
      });
      expect(
        (
          await guardStaleness(driver)({
            ...command,
            commandId: "aware",
            responsiveViewport: true,
          })
        ).ok,
      ).toBe(true);
      await post(stack, "/v1/viewport", {
        width: 1024,
        height: 768,
        policy: "fixed",
      });
      expect(driver.sessionViewportPolicy()).toBe("fixed");
      expect(driver.sessionViewportState()).toMatchObject({
        width: 1024,
        height: 768,
      });
      expect(
        (
          await guardStaleness(driver)({
            ...command,
            commandId: "legacy-again",
          })
        ).ok,
      ).toBe(true);
    },
  );

  it("preserves a newer responsive request during a fixed-mode reset", async () => {
    const page = fakePage();
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, {
      viewport: { policy: "fixed", allowPaneResize: true, debounceMs: 0 },
    });
    await driver.execute({
      source: "chat",
      commandId: "open",
      action: { kind: "navigate", url: "https://example.test" },
    });
    await driver.requestViewport({
      width: 1400,
      height: 900,
      policy: "followPane",
    });
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resize = page.setViewportSize!.bind(page);
    page.setViewportSize = async (size) => {
      if (size.width === 1024) {
        started();
        await gate;
      }
      await resize(size);
    };
    const reset = driver.requestViewport({
      width: 1024,
      height: 768,
      policy: "fixed",
    });
    await entered;
    const newer = driver.requestViewport({
      width: 1200,
      height: 800,
      policy: "followPane",
    });
    release();
    await Promise.all([reset, newer]);
    expect(driver.sessionViewportPolicy()).toBe("followPane");
    expect(driver.sessionViewportState()).toMatchObject({
      width: 1200,
      height: 800,
    });
  });

  it("cannot enable responsiveness on an eval or an old display", async () => {
    const { context } = fakeContext({ pages: [fakePage()] });
    const driver = new ChromiumDriver(context);
    await driver.requestViewport({
      width: 1400,
      height: 900,
      policy: "followPane",
    });
    expect(driver.sessionViewportPolicy()).toBe("fixed");
    expect(driver.sessionViewportState()).toMatchObject({
      width: 1024,
      height: 768,
    });
  });
});
