/**
 * The few things a page module may do to a page.
 *
 * Page modules (`claude-web.ts`, `chatgpt-web.ts`, `fixture-web.ts`) are
 * written against this interface only, so the same module drives a
 * Playwright page (the local engine and tests) and the hosted conversation
 * browser's command API. Keep it small: every method here is one more thing
 * both drivers must do the same way.
 */

export type PageDriverErrorCode =
  /** This driver cannot do it at all (the hosted driver has no `evaluate`). */
  | "unsupported"
  | "timeout"
  /** Nothing on the page matches the selector. */
  | "not_found"
  /** The URL is outside the sites this browser may open. */
  | "site_blocked"
  /** The command may or may not have run. Never retry it blindly. */
  | "unknown_outcome"
  /**
   * A person has the browser: they took control in its pane, or their hold
   * lapsed without being handed back. Nothing ran and nothing was read.
   */
  | "person_has_browser"
  | "failed";

export class PageDriverError extends Error {
  constructor(
    readonly code: PageDriverErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PageDriverError";
  }
}

export type WaitOptions = {
  timeoutMs: number;
  intervalMs?: number;
  signal?: AbortSignal;
  /** What is awaited, for the timeout's message. */
  what: string;
};

/** What `evaluate` hands the page: plain JSON, nothing of the server's. */
export type EvaluateArg = Record<string, string | Record<string, string>>;

export interface PageDriver {
  readonly kind: "playwright" | "hosted";
  /** Whether `evaluate` can run code in the page's own session. */
  readonly canEvaluate: boolean;
  /**
   * Whether `readText` takes Playwright's own selectors (`role=`, `text=`,
   * `>>` chains) as well as CSS. A driver without them refuses those reads.
   */
  readonly playwrightSelectors: boolean;
  /**
   * False where `press` refuses a key meant for one element, as the hosted
   * browser does: it presses only where focus is. Absent means it can.
   */
  readonly pressesOnElement?: boolean;
  navigate(url: string): Promise<void>;
  url(): Promise<string>;
  /** Runs `fn` in the page. Throws `unsupported` where `canEvaluate` is false. */
  evaluate<T>(fn: (arg: EvaluateArg) => T | Promise<T>, arg: EvaluateArg): Promise<T>;
  waitFor(condition: () => Promise<boolean>, options: WaitOptions): Promise<void>;
  click(selector: string): Promise<void>;
  /** Replaces the field's text with `text`. */
  type(selector: string, text: string): Promise<void>;
  press(key: string, selector?: string): Promise<void>;
  /** The first match's text, or `undefined` when nothing matches. */
  readText(selector: string): Promise<string | undefined>;
  /**
   * The whole page's text as a person would copy it, `<pre>` blocks
   * verbatim. Only a driver that runs no script needs one: `readText` there
   * is the page's accessibility tree, which a JSON page doesn't survive.
   */
  pageText?(): Promise<string>;
}

/** Polls `condition` until it holds; the shared `waitFor` both drivers use. */
export async function pollUntil(
  condition: () => Promise<boolean>,
  { timeoutMs, intervalMs = 250, signal, what }: WaitOptions,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    if (await condition()) return;
    if (Date.now() >= deadline) {
      throw new PageDriverError("timeout", `Timed out waiting for ${what}.`);
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      // A caller's signal can outlive many waits, so each sleep removes the
      // listener it added.
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, intervalMs);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/** Whether `url` is on one of `sites` (origins such as `https://claude.ai`). */
export function urlOnSites(url: string, sites: readonly string[]): boolean {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }
  return sites.some((site) => new URL(site).origin === origin);
}

/** Refuses a navigation off the allowed sites before the driver tries it. */
export function assertOnSites(url: string, sites: readonly string[]): void {
  if (!urlOnSites(url, sites)) {
    throw new PageDriverError(
      "site_blocked",
      `This browser may only open ${sites.join(", ")}.`,
    );
  }
}
