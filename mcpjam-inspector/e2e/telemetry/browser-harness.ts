/**
 * The hosted app in a real Chromium with every byte that leaves the page
 * intercepted — the browser half of the egress proof (the jsdom half is
 * `client/src/__tests__/telemetry-egress/`).
 *
 * No server, no backend, no vendor. The page runs on `https://app.mcpjam.com`
 * — the hosted origin, so PostHog's network capture is on (it is off on
 * localhost) and every same-origin rule is the production one — and
 * `page.route` answers every request:
 *
 *  - the PostHog relay (`/tlm/**`, `/relay/**`) and Sentry ingest
 *    (`*.ingest.*sentry.io`): recorded with their bytes, then fulfilled. Never
 *    forwarded.
 *  - the app's own files: served from the telemetry build
 *    (`npm run build:client:telemetry-e2e`, hosted mode, Sentry and PostHog
 *    on), with the SPA fallback to `index.html`.
 *  - AuthKit and Convex: a signed-in member with a resolved, open context,
 *    which permits full recording. Convex is `convex-stand-in.ts`.
 *  - anything else (fonts, the app's other API routes, third parties): 404,
 *    and listed, so a new outbound host is visible in a failure.
 *
 * Three things make the session look like a real visitor's rather than a test
 * runner's. All are declared, not hidden:
 *
 *  - Chromium runs with `--disable-blink-features=AutomationControlled`
 *    (`playwright.telemetry.config.ts`). posthog-js drops EVERY event when
 *    `navigator.webdriver` is true (its bot filter), which under Playwright
 *    it always is; without the flag the PostHog half of this proof would
 *    observe nothing.
 *  - It is the full Chromium (`channel: "chromium"`), not Playwright's
 *    default headless shell, whose `navigator.userAgentData` brand
 *    `HeadlessChrome` trips the same filter.
 *  - `Math.random` is pinned low (an init script), so Sentry's 10% replay and
 *    trace sampling take the sampled branch every run — the same pin the
 *    jsdom harness uses.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import {
  authenticatedSessionBody,
  installConvexStandIn,
  standInTelemetryPolicy,
} from "./convex-stand-in";
import { recordRelayEgress } from "../relay-recorder";
import {
  containsSentinel,
  posthogEvents,
  posthogRemoteConfigScript,
  RRWEB,
  scanAll,
  SENTINEL_STEM,
  sinkOf,
  type CapturedRequest,
} from "./egress";

export const ORIGIN = "https://app.mcpjam.com";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/** Where `build:client:telemetry-e2e` writes the bundle under test. */
export const CLIENT_DIR = path.resolve(
  packageRoot,
  process.env.TELEMETRY_CLIENT_DIR ?? "dist/telemetry-client",
);

/** Fail with the remedy, not with a page that never loads. */
export function assertTelemetryBuild(): void {
  if (!fs.existsSync(path.join(CLIENT_DIR, "index.html"))) {
    throw new Error(
      `No telemetry build at ${CLIENT_DIR}. Run ` +
        "`npm run build:client:telemetry-e2e -w @mcpjam/inspector` first " +
        "(hosted mode, Sentry and PostHog on).",
    );
  }
}

export interface EgressRecorder {
  /** Raw first-party requests, used only to verify capture stamps. */
  ingress: CapturedRequest[];
  /** Every vendor PostHog and Sentry request, with its bytes. */
  telemetry: CapturedRequest[];
  /** Same-origin API requests the app made (answered 404 or stubbed). */
  api: string[];
  /** Every other host the page tried to reach. */
  external: string[];
  /** Page errors and console errors, for a failure message. */
  diagnostics: string[];
  /**
   * The telemetry SDKs' own client-side storage, as last read by `drain`:
   * cookies and Web Storage entries whose name is PostHog's or Sentry's.
   */
  storage: Array<{ where: string; name: string; value: string }>;
  mark(): number;
  scanSince(mark: number): ReturnType<typeof scanAll>;
}

function staticFile(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const file = path.resolve(CLIENT_DIR, `.${decoded}`);
  if (!file.startsWith(CLIENT_DIR + path.sep)) return null;
  return fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
}

/** Deterministic, always below the app's 0.1 sample rates. */
function pinRandomScript() {
  let state = 0x2545f491;
  Math.random = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return (state / 0x7fffffff) * 0.05;
  };
}

export interface EgressRecorderOptions {
  /**
   * How long Sentry's ingest takes to answer. A real one is not instant, and
   * a slow answer is what keeps a replay `stop()` flushing while the visitor
   * moves on.
   */
  sentryLatencyMs?: number;
}

export async function installEgressRecorder(
  page: Page,
  options: EgressRecorderOptions = {},
): Promise<EgressRecorder> {
  const recorder: EgressRecorder = {
    ingress: [],
    telemetry: [],
    api: [],
    external: [],
    diagnostics: [],
    storage: [],
    mark: () => recorder.telemetry.length,
    scanSince: (mark) => scanAll(recorder.telemetry.slice(mark)),
  };
  page.on("pageerror", (error) =>
    recorder.diagnostics.push(`pageerror: ${error.message}`),
  );
  await page.addInitScript(pinRandomScript);
  await page.context().addCookies([
    {
      name: "workos-has-session",
      value: "client_telemetry_e2e",
      url: ORIGIN,
    },
  ]);
  await installConvexStandIn(page, {
    log: (line) => recorder.diagnostics.push(line),
  });

  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const sink = sinkOf(request.url());
    if (sink !== "other") {
      const body = request.postDataBuffer();
      const captured: CapturedRequest = {
        url: request.url(),
        method: request.method(),
        transport: request.resourceType(),
        headers: await request.allHeaders(),
        body: body ? new Uint8Array(body) : null,
      };
      recorder.ingress.push(captured);
      if (sink === "sentry") recorder.telemetry.push(captured);
      if (
        sink === "posthog" &&
        /\/array\/[^/]+\/config\.js$/.test(url.pathname)
      ) {
        return route.fulfill({
          status: 200,
          contentType: "application/javascript",
          body: posthogRemoteConfigScript(),
        });
      }
      if (sink === "posthog" && /^\/(?:tlm|relay)\/(?:e|i\/v0\/e|s)\/?$/.test(url.pathname)) {
        await recordRelayEgress({ url: request.url(), method: request.method(), headers: captured.headers, body }, async (context) => standInTelemetryPolicy(context), (vendor) => recorder.telemetry.push({
          url: vendor.url.href, method: "POST", transport: "fetch", headers: vendor.headers, body: vendor.body,
        }));
      }
      if (sink === "sentry" && options.sentryLatencyMs) {
        await new Promise((resolve) =>
          setTimeout(resolve, options.sentryLatencyMs),
        );
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: sink === "posthog" ? '{"status":1}' : "{}",
      });
    }
    if (url.origin === ORIGIN) {
      if (url.pathname === "/user_management/authenticate") {
        recorder.api.push(`${request.method()} ${url.pathname}`);
        return route.fulfill({ json: JSON.parse(authenticatedSessionBody()) });
      }
      if (url.pathname.startsWith("/api/")) {
        recorder.api.push(`${request.method()} ${url.pathname}`);
        return route.fulfill({
          status: 404,
          contentType: "application/json",
          body: "{}",
        });
      }
      const file = url.pathname === "/" ? null : staticFile(url.pathname);
      return route.fulfill({
        status: 200,
        path: file ?? path.join(CLIENT_DIR, "index.html"),
        ...(file ? {} : { contentType: "text/html" }),
      });
    }
    recorder.external.push(`${request.method()} ${url.origin}${url.pathname}`);
    return route.fulfill({ status: 404, body: "" });
  });
  return recorder;
}

/**
 * In-app navigation the way the router performs it: `history.pushState`
 * (through the app's guard, which wraps it) and the `popstate` react-router
 * listens to. The app has no global navigation handle, and a link click
 * would need a link to exist on every page.
 */
export async function spaNavigate(page: Page, to: string): Promise<void> {
  await page.evaluate((target) => {
    window.history.pushState({}, "", target);
    window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
  }, to);
  await page.waitForTimeout(300);
}

/** An interaction PostHog counts (it holds replay until there is one). */
export async function interact(page: Page): Promise<void> {
  await page.mouse.move(200, 200);
  await page.mouse.click(200, 200);
  const button = page.getByRole("button").first();
  if (await button.isVisible().catch(() => false)) {
    await button.click({ timeout: 2_000 }).catch(() => undefined);
  }
}

/** PostHog's and Sentry's storage keys (`ph_<token>_posthog`, `sentryReplaySession`, …). */
const SDK_STORAGE_KEY = /^ph_|posthog|sentry/i;

/** Read the SDKs' cookies and Web Storage, while the page is still there. */
async function readSdkStorage(page: Page, recorder: EgressRecorder) {
  const cookies = await page.context().cookies();
  const web = await page
    .evaluate(() => {
      const out: Array<{ where: string; name: string; value: string }> = [];
      for (const [where, store] of [
        ["localStorage", window.localStorage],
        ["sessionStorage", window.sessionStorage],
      ] as const) {
        for (let index = 0; index < store.length; index++) {
          const name = store.key(index) ?? "";
          out.push({ where, name, value: store.getItem(name) ?? "" });
        }
      }
      return out;
    })
    .catch(() => []);
  recorder.storage = [
    ...cookies.map((cookie) => ({
      where: `cookie (${cookie.domain})`,
      name: cookie.name,
      value: cookie.value,
    })),
    ...web,
  ].filter((entry) => SDK_STORAGE_KEY.test(entry.name));
}

/**
 * SDK storage entries holding a planted sentinel, one per line. Not ingest:
 * the PostHog relay strips the `Cookie` header before forwarding. But a
 * credential persisted here outlives the page — PostHog's cookie lives a
 * year and rides along on every request to this site.
 */
export function storageReport(recorder: EgressRecorder): string {
  return recorder.storage
    .filter((entry) => containsSentinel(entry.value))
    .map((entry) => {
      const value = decodeURIComponentSafe(entry.value);
      const index = value.search(new RegExp(SENTINEL_STEM, "i"));
      return `[storage] ${entry.where} ${entry.name}: …${value.slice(
        Math.max(0, index - 60),
        index + 40,
      )}…`;
    })
    .join("\n");
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Run the page's unload flush while the page is still alive: dispatch the
 * `pagehide` posthog-js listens for, so its request queue and replay buffer
 * leave by `sendBeacon` exactly as on a real unload — but from a live
 * document, where `page.route` sees (and contains) the beacon. A beacon sent
 * by a document that is already going away can leave outside the page's
 * request interception (CI's Chromium recorded none from a real unload), and
 * an unobserved request proves nothing.
 */
export async function fireUnloadFlush(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: false }),
    );
  });
  await page.waitForTimeout(500);
}

/**
 * Ship what is buffered the way a real session does: wait past PostHog's
 * request-queue (3s) and replay-buffer (2s) timers and Sentry's replay flush
 * delay (5s), read the SDKs' storage, run the unload flush, then unload the
 * page.
 */
/**
 * Waits until PostHog is sending replay captured at `full`. The level starts
 * `pending` until the backend answers, records `masked` until the page has
 * loaded, and reaches `full` only after `MASKED_TO_FULL_SETTLE_MS`
 * (hooks/useSessionPrivacy.ts), so a test that drives the page sooner would
 * be checking a masked recording. posthog-js holds a recording that started
 * without user activity until there is some, so the mouse keeps moving.
 */
export async function waitForFullReplay(
  page: Page,
  recorder: EgressRecorder,
  timeoutMs = 30_000,
  since = 0,
  recordedSince = 0,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (let step = 0; Date.now() < deadline; step++) {
    const atFull = posthogEvents(recorder.scanSince(since).decoded).some(
      (event) => {
        const frames = event.properties.$snapshot_data;
        return (
          event.event === "$snapshot" &&
          Array.isArray(frames) &&
          frames.some((frame: unknown) => {
            if (!frame || typeof frame !== "object") return false;
            const value = frame as { type?: unknown; timestamp?: unknown };
            return (
              (value.type === RRWEB.FullSnapshot ||
                value.type === RRWEB.IncrementalSnapshot) &&
              typeof value.timestamp === "number" &&
              value.timestamp >= recordedSince
            );
          })
        );
      },
    );
    if (atFull) return;
    await page.mouse.move(20 + (step % 40), 20 + (step % 40));
    await page.waitForTimeout(500);
  }
  throw new Error("PostHog never sent replay recorded at full: " + JSON.stringify({
    ingress: posthogEvents(scanAll(recorder.ingress).decoded).map(event => ({ event: event.event, context: event.properties.$mcpjam_telemetry_context })),
    vendor: posthogEvents(recorder.scanSince(0).decoded).map(event => event.event),
    headers: recorder.ingress.filter(request => sinkOf(request.url) === "posthog").map(request => ({ auth: !!request.headers.authorization, policy: request.headers["x-mcpjam-telemetry-policy"] })),
  }));
}

export async function drain(
  page: Page,
  recorder: EgressRecorder,
): Promise<void> {
  await page.waitForTimeout(7_000);
  await readSdkStorage(page, recorder);
  await fireUnloadFlush(page);
  const before = recorder.telemetry.length;
  await page.goto("about:blank");
  await page.waitForTimeout(1_000);
  // Beacons are fire-and-forget; give the route a moment to see them.
  if (recorder.telemetry.length === before) await page.waitForTimeout(1_000);
}
