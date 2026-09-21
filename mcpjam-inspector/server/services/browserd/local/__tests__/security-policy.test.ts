import { describe, it, expect, vi } from "vitest";
import {
  createLocalBrowserSecurityPolicy,
  isMachineAddress,
  secureDriverContext,
} from "../security-policy.js";
import {
  createBrowserConsentLifetime,
  invalidateBrowserConsentLifetimes,
} from "../consent-lifetime.js";
import type { DriverContext, DriverPage } from "../../daemon/browser-page.js";

describe("local Browser destination policy", () => {
  const policy = createLocalBrowserSecurityPolicy({
    controllerUrls: ["http://localhost:62344"],
  });
  it.each([
    "file:///tmp/secret",
    " FILE:///tmp/secret",
    "javascript:void(0)",
    "data:text/plain,secret",
    "chrome://version",
    "app://launch",
    "about:blank",
  ])("refuses supplied navigation %s", (url) => {
    expect(() => policy.assertNavigation(url)).toThrow();
  });
  it.each([
    "http://localhost:3000/app",
    "https://example.test/path",
    "http://192.168.1.12:8080",
    "http://[::1]:3000/",
  ])("preserves website navigation %s", (url) =>
    expect(() => policy.assertNavigation(url)).not.toThrow(),
  );
  it.each([
    "http://localhost:62344/api/session-token",
    "ws://127.0.0.1:62344/frames",
    "http://[::1]:62344/",
    "http://2130706433:62344/",
    "http://[::ffff:127.0.0.1]:62344/",
  ])("blocks the controller via %s", (url) =>
    expect(policy.allowsRequest(url)).toBe(false),
  );
  it("preserves page-created resources", () => {
    for (const url of [
      "about:blank",
      "blob:https://example.test/id",
      "data:image/png;base64,a",
    ])
      expect(policy.allowsRequest(url)).toBe(true);
  });
  it("resolves once and refuses a DNS alias for the controller", async () => {
    const lookup = vi
      .fn()
      .mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const p = createLocalBrowserSecurityPolicy({
      controllerUrls: ["http://localhost:62344"],
      lookup,
    });
    await expect(p.resolveDestination("rebind.test", 62344)).rejects.toThrow();
    await expect(p.resolveDestination("dev.test", 3000)).resolves.toEqual([
      {
        address: "127.0.0.1",
        family: 4,
      },
    ]);
  });
  it("recognizes IPv4-mapped loopback", () =>
    expect(isMachineAddress("::ffff:7f00:1")).toBe(true));
});

describe("consent lifetime at dispatch", () => {
  it.each([null, "new-grant"])(
    "invalidates live and already-returned CDP access on %s",
    async (next) => {
      let consent: string | null = "original";
      const lifetime = await createBrowserConsentLifetime(
        "original",
        async () => consent,
      );
      const send = vi.fn().mockResolvedValue({});
      const close = vi.fn();
      const page = {
        url: () => "https://example.test/",
        cdp: async () => ({ send }),
        goto: vi.fn(),
        isClosed: () => false,
      } as unknown as DriverPage;
      const context = secureDriverContext(
        {
          newPage: async () => page,
          close,
          isConnected: () => true,
        } as unknown as DriverContext,
        createLocalBrowserSecurityPolicy(lifetime),
      );
      const tab = await context.newPage();
      const cdp = await tab.cdp();
      consent = next;
      await expect(cdp!.send("Input.dispatchMouseEvent", {})).rejects.toThrow(
        /permission/,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(send).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
      await expect(tab.goto("https://example.test")).rejects.toThrow();
      lifetime.dispose();
    },
  );
  it("in-process rotation waits for teardown and does not revoke the new grant", async () => {
    const old = await createBrowserConsentLifetime("old", async () => "old");
    const current = await createBrowserConsentLifetime(
      "new",
      async () => "new",
    );
    const closed = vi.fn();
    old.onRevoked(closed);
    await invalidateBrowserConsentLifetimes("new");
    expect(closed).toHaveBeenCalledOnce();
    expect(old.isActive()).toBe(false);
    expect(current.isActive()).toBe(true);
    current.dispose();
  });
});

it("closes an existing lifetime when rollout admission is withdrawn", async () => {
  let admitted = true;
  const lifetime = await createBrowserConsentLifetime(
    "grant",
    async () => "grant",
    async () => admitted,
  );
  const close = vi.fn();
  lifetime.onRevoked(close);
  admitted = false;
  await expect(lifetime.assertActive()).rejects.toThrow();
  await lifetime.revoke();
  expect(close).toHaveBeenCalledOnce();
  lifetime.dispose();
});

it("reports bounded reason counts once without retaining destination content", () => {
  const onAudit = vi.fn();
  const policy = createLocalBrowserSecurityPolicy({
    controllerUrls: ["http://localhost:62349"],
    onAudit,
  });
  expect(() =>
    policy.assertNavigation("file:///synthetic-sensitive-name"),
  ).toThrow();
  expect(
    policy.allowsRequest(
      "http://localhost:62349/api/session-token?secret=synthetic",
    ),
  ).toBe(false);
  policy.dispose?.();
  policy.dispose?.();
  expect(onAudit).toHaveBeenCalledExactlyOnceWith({
    navigationRefused: 1,
    networkRefused: 1,
    destinationRefused: 0,
  });
});

it("validates every fallback address before returning the pinned DNS answer", async () => {
  const addresses = [
    { address: "203.0.113.1", family: 4 },
    { address: "::1", family: 6 },
  ];
  const lookup = vi.fn().mockResolvedValue(addresses);
  const policy = createLocalBrowserSecurityPolicy({
    controllerUrls: ["http://localhost:62346"],
    lookup,
  });
  try {
    await expect(
      policy.resolveDestination("alias.test", 62346),
    ).rejects.toThrow(/browser_policy_refused/);
    await expect(
      policy.resolveDestination("alias.test", 3000),
    ).resolves.toEqual(addresses);
  } finally {
    policy.dispose?.();
  }
});
