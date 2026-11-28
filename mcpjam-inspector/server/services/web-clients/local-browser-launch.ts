/**
 * How a local Inspector starts Chromium on a vendor profile: a plain browser
 * for the person's sign-in, and Playwright for turns. Neither answers a human
 * check; they only keep a person's window from looking automated.
 */
import { spawn as nodeSpawn } from "node:child_process";
import type { Page } from "playwright";

/**
 * Playwright's launch for a turn, minus its automation switch, so the turn can
 * reuse the profile's sign-in and human-check cookies.
 */
export const TURN_LAUNCH_OPTIONS = {
  ignoreDefaultArgs: ["--enable-automation"],
  args: ["--disable-blink-features=AutomationControlled"],
} as const;

export async function launchTurnBrowser(
  profileDir: string,
  options: { headless: boolean },
): Promise<{ page: Page; close(): Promise<void> }> {
  const { chromium } = await import("playwright");
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: options.headless,
    ignoreDefaultArgs: [...TURN_LAUNCH_OPTIONS.ignoreDefaultArgs],
    args: [...TURN_LAUNCH_OPTIONS.args],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  return { page, close: () => context.close() };
}

/**
 * Arguments for the sign-in window. On macOS Playwright encrypts cookies with
 * a mock keychain, so the sign-in window must too or turns can't read them.
 */
export function signInBrowserArgs(profileDir: string, url: string, platform: NodeJS.Platform): string[] {
  return [
    `--user-data-dir=${profileDir}`,
    ...(platform === "darwin" ? ["--use-mock-keychain"] : []),
    "--no-first-run",
    "--no-default-browser-check",
    url,
  ];
}

type Spawn = (command: string, args: string[], options: { stdio: "ignore" }) => {
  once(event: "exit", listener: (code: number | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
};

/**
 * Opens Playwright's Chromium as a plain browser, with no automation or
 * remote control, and resolves when the person closes it.
 */
export async function openSignInWindow(options: {
  profileDir: string;
  url: string;
  executablePath?: string;
  platform?: NodeJS.Platform;
  spawn?: Spawn;
}): Promise<void> {
  const executablePath = options.executablePath ?? (await import("playwright")).chromium.executablePath();
  const child = (options.spawn ?? nodeSpawn)(
    executablePath,
    signInBrowserArgs(options.profileDir, options.url, options.platform ?? process.platform),
    { stdio: "ignore" },
  );
  await new Promise<void>((done, reject) => {
    child.once("exit", () => done());
    child.once("error", reject);
  });
}
