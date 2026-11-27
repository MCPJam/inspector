/**
 * The sign-in window is a plain browser with no automation switches, and a
 * turn's Playwright launch drops the automation flag.
 * Evidence: fixture (spawn and Playwright are mocked; no browser starts).
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const launchPersistentContext = vi.fn();
vi.mock("playwright", () => ({
  chromium: { launchPersistentContext, executablePath: () => "/pw/chromium" },
}));

import { launchTurnBrowser, openSignInWindow, signInBrowserArgs } from "../local-browser-launch";

describe("signInBrowserArgs", () => {
  it("uses Playwright's mock keychain on macOS and opens the sign-in page", () => {
    expect(signInBrowserArgs("/home/p", "https://claude.ai/login", "darwin")).toEqual([
      "--user-data-dir=/home/p",
      "--use-mock-keychain",
      "--no-first-run",
      "--no-default-browser-check",
      "https://claude.ai/login",
    ]);
  });

  it("has no automation or remote-control switch on any platform", () => {
    const args = signInBrowserArgs("/home/p", "https://claude.ai/login", "linux");
    expect(args).not.toContain("--use-mock-keychain");
    expect(args.join(" ")).not.toMatch(/automation|remote-debugging/);
  });
});

describe("openSignInWindow", () => {
  it("spawns Playwright's Chromium directly and resolves when it exits", async () => {
    const child = new EventEmitter();
    const spawn = vi.fn(() => child);
    let closed = false;
    const opened = openSignInWindow({
      profileDir: "/home/p",
      url: "https://claude.ai/login",
      platform: "darwin",
      spawn,
    }).then(() => (closed = true));
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    expect(spawn).toHaveBeenCalledWith(
      "/pw/chromium",
      signInBrowserArgs("/home/p", "https://claude.ai/login", "darwin"),
      { stdio: "ignore" },
    );
    expect(launchPersistentContext).not.toHaveBeenCalled();
    expect(closed).toBe(false);
    child.emit("exit", 0);
    await opened;
    expect(closed).toBe(true);
  });

  it("rejects when the browser can't start", async () => {
    const child = new EventEmitter();
    const opened = openSignInWindow({ profileDir: "/p", url: "https://x", executablePath: "/c", spawn: () => child });
    child.emit("error", new Error("ENOENT"));
    await expect(opened).rejects.toThrow("ENOENT");
  });
});

describe("launchTurnBrowser", () => {
  it("drops Playwright's automation flag on the profile", async () => {
    const page = {};
    const close = vi.fn();
    launchPersistentContext.mockResolvedValueOnce({ pages: () => [page], close });
    const browser = await launchTurnBrowser("/home/p", { headless: true });
    expect(launchPersistentContext).toHaveBeenCalledWith("/home/p", {
      headless: true,
      ignoreDefaultArgs: ["--enable-automation"],
      args: ["--disable-blink-features=AutomationControlled"],
    });
    expect(browser.page).toBe(page);
    await browser.close();
    expect(close).toHaveBeenCalled();
  });
});
