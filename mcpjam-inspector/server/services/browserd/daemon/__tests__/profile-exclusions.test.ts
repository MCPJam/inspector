/**
 * A profile exported after its browser cleared a site carries none of that
 * site's cookies or storage, and keeps every other site's: the guarantee a
 * saved web-account sign-in relies on to leave MCPJam's own sign-in session
 * behind.
 *
 * Evidence: a real Chromium profile, archived and restored the way a hosted
 * box does it. The sites are served by request routing, not the network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { adaptContext, cookieDomainsFor } from "../chromium-launch";
import {
  exportBrowserProfileArchive,
  importBrowserProfileArchive,
} from "../../profile-archive";

const SIGN_IN = "https://signin.authkit.test";
const VENDOR = "https://chat.vendor.test";

const dirs: string[] = [];
async function profileDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "profile-exclusions-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function open(dir: string): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext(dir, { headless: true });
  await context.route("**/*", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>t</title>" }),
  );
  return context;
}

/** What a page on `origin` finds in its own storage. */
async function storageAt(context: BrowserContext, origin: string) {
  const page = await context.newPage();
  await page.goto(`${origin}/`);
  const found = await page.evaluate(async () => ({
    local: localStorage.getItem("session"),
    databases: (await indexedDB.databases()).map((db) => db.name),
  }));
  await page.close();
  return found;
}

describe("clearing a site before a profile export", { timeout: 60_000 }, () => {
  it("leaves none of its cookies or storage in the restored profile, and keeps the rest", async () => {
    const dir = await profileDir();
    const context = await open(dir);
    const expires = Math.floor(Date.now() / 1000) + 3600;
    await context.addCookies([
      { name: "session", value: "s", domain: "signin.authkit.test", path: "/", expires, secure: true, sameSite: "Lax" },
      { name: "wide", value: "w", domain: ".authkit.test", path: "/", expires, secure: true, sameSite: "Lax" },
      { name: "account", value: "a", domain: "chat.vendor.test", path: "/", expires, secure: true, sameSite: "Lax" },
      { name: "device", value: "d", domain: ".vendor.test", path: "/", expires, secure: true, sameSite: "Lax" },
    ]);
    for (const origin of [SIGN_IN, VENDOR]) {
      const page = await context.newPage();
      await page.goto(`${origin}/`);
      await page.evaluate(async () => {
        localStorage.setItem("session", location.host);
        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.open("sessions");
          request.onupgradeneeded = () => request.result.createObjectStore("s");
          request.onsuccess = () => {
            request.result.close();
            resolve();
          };
          request.onerror = () => reject(request.error);
        });
      });
      await page.close();
    }

    await adaptContext(context as never).clearOriginData!([SIGN_IN]);
    await context.close();
    const restored = await profileDir();
    await importBrowserProfileArchive(restored, await exportBrowserProfileArchive(dir));

    const reopened = await open(restored);
    try {
      const cookies = (await reopened.cookies()).map((cookie) => `${cookie.domain} ${cookie.name}`).sort();
      expect(cookies).toEqual([".vendor.test device", "chat.vendor.test account"]);
      expect(await storageAt(reopened, SIGN_IN)).toEqual({ local: null, databases: [] });
      expect(await storageAt(reopened, VENDOR)).toEqual({
        local: "chat.vendor.test",
        databases: ["sessions"],
      });
    } finally {
      await reopened.close();
    }
  });

  it("stops every page before it clears a site, so none writes it back before the export", async () => {
    const dir = await profileDir();
    const context = await open(dir);
    const page = await context.newPage();
    await page.goto(`${SIGN_IN}/`);
    // A page left running on the site keeps writing its session back.
    await page.evaluate(() => {
      setInterval(() => {
        localStorage.setItem("session", "written again");
        document.cookie = "session=again; path=/; max-age=3600; secure";
      }, 1);
    });

    await adaptContext(context as never).clearOriginData!([SIGN_IN]);
    expect(page.isClosed()).toBe(true);
    // Time a page still running would have used to write.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await context.close();
    const restored = await profileDir();
    await importBrowserProfileArchive(restored, await exportBrowserProfileArchive(dir));

    const reopened = await open(restored);
    try {
      expect((await reopened.cookies()).map((cookie) => cookie.domain)).not.toContain("signin.authkit.test");
      expect(await storageAt(reopened, SIGN_IN)).toEqual({ local: null, databases: [] });
    } finally {
      await reopened.close();
    }
  });

  it("fails the export when a page won't close in time, before clearing anything", async () => {
    vi.useFakeTimers();
    try {
      const cleared: string[] = [];
      const adapted = adaptContext({
        newPage: async () => ({}) as never,
        // A page that never finishes closing, as a renderer stuck in a dialog can.
        pages: () => [{ close: () => new Promise<void>(() => {}) }] as never,
        browser: () => null,
        close: async () => {},
        newCDPSession: async () => ({ send: async () => cleared.push("cdp") }) as never,
        clearCookies: async () => {
          cleared.push("cookies");
        },
      });
      const clearing = adapted.clearOriginData!([SIGN_IN]);
      const outcome = expect(clearing).rejects.toThrow("profile_export_pages_did_not_close");
      await vi.advanceTimersByTimeAsync(10_000);
      await outcome;
      expect(cleared).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens its blank page before closing the others, as a headed browser needs", async () => {
    // A headed Chromium whose last tab closed refuses a new one.
    const blank = { close: vi.fn(async () => {}) };
    const open = new Set<{ close: () => Promise<void> }>();
    const site = { close: vi.fn(async () => void open.delete(site)) };
    open.add(site);
    const sent: string[] = [];
    const adapted = adaptContext({
      newPage: async () => {
        if (open.size === 0) throw new Error("Target.createTarget: Failed to open a new tab");
        open.add(blank);
        return blank as never;
      },
      pages: () => [...open] as never,
      browser: () => null,
      close: async () => {},
      newCDPSession: async () => ({ send: async (method: string) => void sent.push(method) }) as never,
      clearCookies: async () => {},
    });
    await adapted.clearOriginData!([SIGN_IN]);
    expect(site.close).toHaveBeenCalledOnce();
    expect(blank.close).not.toHaveBeenCalled();
    expect(sent.length).toBeGreaterThan(0);
  });

  it("refuses to clear in a browser that can't, rather than archive the site", async () => {
    const adapted = adaptContext({
      newPage: async () => ({}) as never,
      pages: () => [],
      browser: () => null,
      close: async () => {},
    });
    await expect(adapted.clearOriginData!([SIGN_IN])).rejects.toThrow("can't clear");
    // Nothing to leave out asks nothing of the browser.
    await expect(adapted.clearOriginData!([])).resolves.toBeUndefined();
  });

  it("matches the cookie domains a host's pages are sent, and no others", () => {
    const domains = cookieDomainsFor("signin.authkit.test");
    for (const domain of ["signin.authkit.test", ".signin.authkit.test", "authkit.test", ".authkit.test"]) {
      expect(domains.test(domain)).toBe(true);
    }
    for (const domain of [".test", "test", "chat.vendor.test", "evilauthkit.test", "other.signin.authkit.test"]) {
      expect(domains.test(domain)).toBe(false);
    }
    expect(cookieDomainsFor("127.0.0.1").test("0.0.1")).toBe(false);
  });
});
