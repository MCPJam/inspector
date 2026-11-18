import { randomUUID } from "node:crypto";
import type { Page, Route } from "playwright";
import {
  SANDBOX_VIEW_DENY_POLICY,
  sandboxViewHeaders,
} from "../sandbox-view-response.js";

/** A private, exact URL fulfilled by the host before any DNS/network access. */
export class HarnessViewDocument {
  private current?: { url: string; origin: string; policy: string };

  async serve(route: Route): Promise<boolean> {
    if (!this.current) return false;
    const url = new URL(route.request().url());
    if (url.origin !== this.current.origin) return false;
    const admitted =
      url.href === this.current.url && route.request().method() === "GET";
    await route.fulfill({
      status: admitted ? 200 : 404,
      headers: sandboxViewHeaders(
        admitted ? this.current.policy : SANDBOX_VIEW_DENY_POLICY,
      ),
      body: admitted
        ? "<!doctype html><html><head><meta charset='utf-8'></head><body></body></html>"
        : "Not Found",
    });
    return true;
  }

  async load(page: Page, policy: string, scripts: string[]): Promise<void> {
    const origin = `https://${randomUUID()}.mcpjam-view.invalid`;
    this.current = { origin, url: `${origin}/view`, policy };
    await page.goto(this.current.url, { waitUntil: "domcontentloaded" });
    for (const content of scripts) await page.addScriptTag({ content });
  }
}
