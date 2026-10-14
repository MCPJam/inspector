import { expect, type Page } from "@playwright/test";
import type { EgressRecorder } from "./browser-harness";
import { RRWEB, sentryReplayEvents } from "./egress";

/** Capture through the installed browser SDK and return its real event ID. */
export async function captureSentryProof(
  page: Page,
  message: string,
): Promise<string> {
  return page.evaluate((text) => {
    const carrier = (
      window as Window & {
        __SENTRY__?: { version?: string; [key: string]: unknown };
      }
    ).__SENTRY__;
    const sdk = carrier?.[carrier.version ?? ""] as
      | { stack?: { getScope(): { captureException(error: Error): string } } }
      | undefined;
    const scope = sdk?.stack?.getScope();
    if (!scope)
      throw new Error("The installed Sentry SDK scope is unavailable");
    const id = scope.captureException(new Error(text));
    if (!/^[0-9a-f]{32}$/.test(id))
      throw new Error("The SDK did not mint an event ID");
    return id;
  }, message);
}

/** Prove the recorder resumed from fresh vendor recording bytes, not an error tag. */
export async function waitForSentryReplay(
  page: Page,
  recorder: EgressRecorder,
  mark: number,
  from: number,
): Promise<void> {
  let step = 0;
  await expect
    .poll(
      async () => {
        await page.mouse.move(30 + (step++ % 40), 30);
        return sentryReplayEvents(recorder.scanSince(mark).decoded).some(
          (event) => {
            const timestamp = (event as { timestamp?: unknown }).timestamp;
            return (
              (event.type === RRWEB.FullSnapshot ||
                event.type === RRWEB.IncrementalSnapshot) &&
              typeof timestamp === "number" &&
              timestamp >= from
            );
          },
        );
      },
      { timeout: 30_000, intervals: [500] },
    )
    .toBe(true);
}

/** A fresh eligible scope proves full diagnostics before restrictive history. */
export async function captureFreshSentryProof(page: Page): Promise<string> {
  return page.evaluate(() => {
    type Scope = {
      clearBreadcrumbs(): void;
      captureException(error: Error): string;
    };
    const carrier = (
      window as Window & {
        __SENTRY__?: { version?: string; [key: string]: unknown };
      }
    ).__SENTRY__;
    const sdk = carrier?.[carrier.version ?? ""] as
      | {
          defaultCurrentScope?: Scope;
          defaultIsolationScope?: Scope;
          stack?: { getScope(): Scope };
        }
      | undefined;
    sdk?.defaultCurrentScope?.clearBreadcrumbs();
    sdk?.defaultIsolationScope?.clearBreadcrumbs();
    const scope = sdk?.stack?.getScope();
    if (!scope)
      throw new Error("The installed Sentry SDK scope is unavailable");
    scope.clearBreadcrumbs();
    const id = scope.captureException(new Error("full diagnostic control"));
    if (!/^[0-9a-f]{32}$/.test(id))
      throw new Error("The SDK did not mint an event ID");
    return id;
  });
}
