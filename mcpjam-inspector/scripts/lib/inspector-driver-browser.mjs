/**
 * The browser half of the inspector driver: one Chromium context signed in
 * the way the e2e suite signs in (the local-access key in localStorage, the
 * guest session minted by the app itself), with every console message, page
 * error and failed or 4xx/5xx response recorded per page.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  describeStep,
  parseSelector,
  redactUrl,
} from "./inspector-driver-core.mjs";

/** Mirrors `LOCAL_ACCESS_KEY` in client/src/lib/access-link.ts. */
const LOCAL_ACCESS_KEY = "mcpjam.local-access";

/**
 * The first-run flow redirects every screen until it is done; the e2e specs
 * mark it complete the same way. `--fresh` leaves these out to verify it.
 */
const ONBOARDING_DONE = {
  "mcp-onboarding-state": JSON.stringify({
    status: "completed",
    completedAt: 1,
  }),
  "mcp-first-run-server-choice-state": JSON.stringify({
    status: "completed",
    completedAt: 1,
    shownAt: 1,
  }),
};

export async function openContext({ baseUrl, token, theme, fresh, headed }) {
  // Imported here so `surfaces`, `start` and `stop` work without Playwright.
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const origin = new URL(baseUrl).origin;
  const force = {
    ...(token ? { [LOCAL_ACCESS_KEY]: token } : {}),
    ...(theme ? { themeMode: theme } : {}),
  };
  const ifAbsent = fresh ? {} : ONBOARDING_DONE;
  await context.addInitScript(
    ({ origin, force, ifAbsent }) => {
      // Sandboxed widget frames run on other origins; seed only the app.
      if (window.location.origin !== origin) return;
      for (const [key, value] of Object.entries(force)) {
        window.localStorage.setItem(key, value);
      }
      for (const [key, value] of Object.entries(ifAbsent)) {
        if (window.localStorage.getItem(key) === null) {
          window.localStorage.setItem(key, value);
        }
      }
    },
    { origin, force, ifAbsent },
  );
  return {
    context,
    close: () => browser.close(),
  };
}

/** Everything a page emits that a reviewer would call broken or noisy. */
export function recordEvents(page) {
  const events = [];
  page.on("console", (message) => {
    const type = message.type();
    if (type !== "error" && type !== "warning") return;
    const where = message.location()?.url;
    events.push({
      kind: type === "error" ? "console-error" : "console-warning",
      text: where ? `${message.text()} @ ${redactUrl(where)}` : message.text(),
    });
  });
  page.on("pageerror", (error) => {
    events.push({ kind: "page-error", text: error.stack ?? error.message });
  });
  page.on("requestfailed", (request) => {
    events.push({
      kind: "request-failed",
      text: `${request.method()} ${redactUrl(request.url())} ${request.failure()?.errorText ?? ""}`,
    });
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    events.push({
      kind: `http-${response.status()}`,
      text: `${response.request().method()} ${redactUrl(response.url())}`,
    });
  });
  return events;
}

/**
 * Load a URL and wait for the app shell, the same readiness the e2e smoke
 * test uses. A missing shell or the not-found screen is itself an event.
 */
export async function loadAndSettle(page, url, events, timeoutMs) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  await settle(page, events, timeoutMs);
}

async function settle(page, events, timeoutMs) {
  const shell = page.getByTestId("app-shell");
  const shown = await shell
    .waitFor({ state: "visible", timeout: timeoutMs })
    .then(
      () => true,
      () => false,
    );
  if (!shown) {
    events.push({
      kind: "no-app-shell",
      text: `app-shell not visible within ${timeoutMs}ms`,
    });
    return;
  }
  // Lazy screens fetch after the shell mounts; give them a moment, but a
  // page that never goes quiet (polling, streams) is not a failure.
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).then(
    () => undefined,
    () => undefined,
  );
  if ((await page.getByTestId("route-not-found").count()) > 0) {
    events.push({
      kind: "not-found",
      text: `route-not-found at ${page.url()}`,
    });
  }
}

export function locate(page, selector) {
  const { by, value } = parseSelector(selector);
  if (by === "testid") return page.getByTestId(value);
  if (by === "label") return page.getByLabel(value);
  if (by === "placeholder") return page.getByPlaceholder(value);
  return page.locator(value);
}

/**
 * Run the steps in order and stop at the first failure. `resolveUrl` turns
 * a `goto` target (surface, path or URL) into a URL.
 */
export async function runSteps({
  page,
  steps,
  events,
  resolveUrl,
  stepTimeoutMs,
  loadTimeoutMs,
  shoot,
}) {
  const results = [];
  for (const [i, step] of steps.entries()) {
    const index = i + 1;
    const started = Date.now();
    try {
      await runStep({
        page,
        step,
        events,
        resolveUrl,
        stepTimeoutMs,
        loadTimeoutMs,
        shoot,
        index,
      });
      results.push({
        ...step,
        index,
        ok: true,
        seconds: (Date.now() - started) / 1_000,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        ...step,
        index,
        ok: false,
        error: message,
        seconds: (Date.now() - started) / 1_000,
      });
      events.push({
        kind: "step-failed",
        text: `step ${index} (${describeStep(step)}): ${message.split("\n")[0]}`,
      });
      break;
    }
  }
  return results;
}

async function runStep({
  page,
  step,
  events,
  resolveUrl,
  stepTimeoutMs,
  loadTimeoutMs,
  shoot,
  index,
}) {
  const options = { timeout: stepTimeoutMs };
  switch (step.action) {
    case "goto":
      return loadAndSettle(
        page,
        resolveUrl(step.target),
        events,
        loadTimeoutMs,
      );
    case "click":
      return locate(page, step.target).click(options);
    case "hover":
      return locate(page, step.target).hover(options);
    case "fill":
      return locate(page, step.target).fill(step.value, options);
    case "press":
      return step.on
        ? locate(page, step.on).press(step.target, options)
        : page.keyboard.press(step.target);
    case "waitFor":
      return locate(page, step.target).waitFor({
        state: step.state ?? "visible",
        ...options,
      });
    case "screenshot":
      return shoot(`step-${index}-${step.target}`);
    default:
      throw new Error(`Unknown action ${step.action}`);
  }
}

/** Screenshot, ARIA snapshot and the full JSON report next to each other. */
export async function captureArtifacts(page, outDir, slug) {
  const screenshot = join(outDir, `${slug}.png`);
  const aria = join(outDir, `${slug}.aria.yml`);
  await page.screenshot({ path: screenshot, fullPage: false });
  writeFileSync(aria, await page.locator("body").ariaSnapshot());
  return { shot: screenshot, aria };
}
