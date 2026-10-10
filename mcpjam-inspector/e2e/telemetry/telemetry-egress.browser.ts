/**
 * The telemetry egress proof against the real hosted build in a real
 * Chromium. Same corpus, same decoding, same two-sided assertions as the
 * jsdom harness (`client/src/__tests__/telemetry-egress/`), on what jsdom
 * cannot run: real layout for rrweb, PostHog's network capture (resource
 * timing), Sentry's compression worker, real `sendBeacon` on unload, real
 * `popstate`, and the app's own pages and boot paths instead of a stand-in
 * page.
 *
 * The visitor is a signed-out hosted guest — the `full` level — so both
 * recorders run (`resolveSessionPrivacy`). `full` → `masked` needs a signed-in
 * member of an enterprise organization, which needs WorkOS; that switch is
 * covered in jsdom (`session-egress.test.tsx`).
 *
 * Every test reads every PostHog and Sentry request its page made, decoded
 * all the way down, and fails on any planted sentinel, naming the sink and
 * the payload path — and fails too when the telemetry it drove never
 * arrived, so a run that observed nothing cannot pass.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  assertTelemetryBuild,
  drain,
  installEgressRecorder,
  interact,
  ORIGIN,
  spaNavigate,
  storageReport,
  type EgressRecorder,
} from "./browser-harness";
import {
  apiCorpus,
  assertCorpusComplete,
  EGRESS_CORPUS,
  GENERIC_EGRESS_URLS,
  leakReport,
  missingArrivals,
  pageCorpus,
  posthogReplayEvents,
  recordedText,
  sentinel,
  type Arrivals,
} from "./egress";

/**
 * How long a visitor stays on each page in the round-trip test. Realistic,
 * and long enough for Sentry Replay's asynchronous stop to finish before the
 * guard starts it again: with sub-second hops Sentry Replay ends up stopped
 * for good (no leak — it fails closed — but nothing left to observe).
 */
const DWELL_MS = 2_500;

/** A public page every signed-out visitor can open: the score landing. */
const NORMAL_PAGE = "/embed/score";
const NORMAL_PAGE_TEXT = "Know where your MCP server stands";

test.beforeAll(() => {
  assertTelemetryBuild();
  assertCorpusComplete();
});

function expectClean(
  recorder: EgressRecorder,
  label: string,
  wanted: Arrivals,
): ReturnType<EgressRecorder["scanSince"]> {
  const scan = recorder.scanSince(0);
  const report = leakReport(scan.hits);
  expect
    .soft(report.posthog, `${label}: a planted credential reached PostHog`)
    .toBe("");
  expect
    .soft(report.sentry, `${label}: a planted credential reached Sentry`)
    .toBe("");
  expect
    .soft(
      storageReport(recorder),
      `${label}: a planted credential is persisted in PostHog/Sentry storage`,
    )
    .toBe("");
  expect(
    missingArrivals(scan.decoded, wanted),
    `${label}: expected telemetry never arrived. Diagnostics:\n${recorder.diagnostics
      .slice(0, 20)
      .join("\n")}`,
  ).toEqual([]);
  return scan;
}

async function openNormalPage(page: Page): Promise<void> {
  await page.goto(`${ORIGIN}${NORMAL_PAGE}`);
  await expect(page.getByText(NORMAL_PAGE_TEXT)).toBeVisible({
    timeout: 30_000,
  });
  await interact(page);
}

/** An uncaught error, the way a real one reaches both SDKs' handlers. */
async function throwUncaught(page: Page, message: string): Promise<void> {
  await page.evaluate((text) => {
    setTimeout(() => {
      throw new Error(text);
    }, 0);
  }, message);
  await page.waitForTimeout(200);
}

test("share links on a normal page at full: text, href and iframe src", async ({
  page,
}) => {
  const recorder = await installEgressRecorder(page);
  await openNormalPage(page);
  await page.evaluate(
    (urls) => {
      const section = document.createElement("section");
      section.id = "egress-share-links";
      for (const url of urls) {
        const absolute = new URL(url, window.location.origin).toString();
        const line = document.createElement("p");
        line.append(`Share link: ${absolute} `);
        const link = document.createElement("a");
        link.href = absolute;
        link.title = `Open ${absolute}`;
        link.textContent = "open";
        line.append(link);
        section.append(line);
      }
      const frame = document.createElement("iframe");
      frame.src = new URL(urls[0], window.location.origin).toString();
      section.append(frame);
      document.body.append(section);
    },
    [...Object.values(EGRESS_CORPUS), ...GENERIC_EGRESS_URLS],
  );
  await interact(page);
  await page.evaluate((url) => console.log("[egress] copied", url), EGRESS_CORPUS["tester-link"]);
  // The app's own requests carrying credentials: PostHog's network capture
  // records them (on this non-localhost origin), Sentry's breadcrumbs too.
  await page.evaluate(
    async (urls) => {
      for (const url of urls) await fetch(url).catch(() => undefined);
    },
    [...apiCorpus().map(([, url]) => url), ...GENERIC_EGRESS_URLS],
  );
  await throwUncaught(page, `failed GET ${EGRESS_CORPUS["api-score-run"]}`);
  await drain(page, recorder);

  const scan = expectClean(recorder, "share links at full", {
    posthogEvents: ["$autocapture", "$exception"],
    posthogFullSnapshot: true,
    posthogPlugins: ["rrweb/console@1", "rrweb/network@1"],
    sentryItems: ["event"],
    sentryFullSnapshot: true,
  });
  // A guest, at `full`: the guest session was minted and the replay shows
  // the page's words, unmasked.
  expect(recorder.api).toContain("POST /api/web/guest-session");
  expect(recordedText(posthogReplayEvents(scan.decoded))).toContain(
    NORMAL_PAGE_TEXT,
  );
});

for (const [id, url] of pageCorpus()) {
  test(`a cold load onto ${id}, then leaving for a normal page`, async ({
    page,
  }) => {
    const recorder = await installEgressRecorder(page);
    await page.goto(`${ORIGIN}${url}`);
    await page.waitForTimeout(3_000);
    await interact(page);
    await throwUncaught(page, `failure on ${id}`);
    await page.waitForTimeout(1_000);
    await spaNavigate(page, NORMAL_PAGE);
    await page.waitForTimeout(1_500);
    await interact(page);
    await drain(page, recorder);
    // Some credential URLs boot pages without the analytics provider (the
    // connection handoff, the OAuth popup); Sentry runs on every one.
    expectClean(recorder, `cold load onto ${id}`, { sentryItems: ["event"] });
  });
}

test("SPA navigation from a normal page onto every credential page and back", async ({
  page,
}) => {
  const recorder = await installEgressRecorder(page);
  await openNormalPage(page);
  for (const [, url] of pageCorpus()) {
    await spaNavigate(page, url);
    await page.mouse.click(5, 5);
    await page.waitForTimeout(DWELL_MS);
    await page.goBack();
    await page.waitForTimeout(DWELL_MS);
    await page.mouse.click(5, 5);
  }
  await interact(page);
  await throwUncaught(page, "after the round trip");
  await drain(page, recorder);
  expectClean(recorder, "SPA navigation", {
    posthogEvents: ["$snapshot"],
    posthogFullSnapshot: true,
    sentryItems: ["event"],
    sentryFullSnapshot: true,
  });
});

test("a secret query key and fragment on a normal page", async ({ page }) => {
  const recorder = await installEgressRecorder(page);
  await openNormalPage(page);
  await spaNavigate(page, `${NORMAL_PAGE}?code=${sentinel("pwquery")}`);
  await interact(page);
  await page.goBack();
  await page.waitForTimeout(300);
  await page.evaluate((token) => {
    window.location.hash = `#token=${token}`;
  }, sentinel("pwhash"));
  await page.waitForTimeout(300);
  await interact(page);
  await page.evaluate(() => {
    window.location.hash = "";
  });
  await page.waitForTimeout(300);
  await interact(page);
  await throwUncaught(page, "after query and fragment");
  await drain(page, recorder);
  expectClean(recorder, "query and fragment", {
    posthogFullSnapshot: true,
    sentryItems: ["event"],
  });
});

test("a tab closed on a credential page ships nothing planted", async ({
  page,
}) => {
  const recorder = await installEgressRecorder(page);
  await openNormalPage(page);
  await page.waitForTimeout(2_500);
  await spaNavigate(page, EGRESS_CORPUS["score-results"]);
  await page.mouse.click(5, 5);
  await throwUncaught(page, "just before closing");
  // No waiting: the tab goes with PostHog's queue and replay buffer full.
  await page.goto("about:blank");
  await page.waitForTimeout(1_500);
  const scan = expectClean(recorder, "closed on a credential page", {
    posthogEvents: ["$snapshot"],
    sentryItems: ["event"],
  });
  expect(
    scan.decoded.some((entry) => entry.request.transport === "ping"),
    "the unload flush must leave by sendBeacon",
  ).toBe(true);
});

test("a visitor who reads a page, then opens a share link", async ({ page }) => {
  // Long enough on the normal page that Sentry keeps the replay segment the
  // guard stops on the way in (it drops a first segment under 5s) — so the
  // segment, and the replay event that describes it, are actually sent.
  const recorder = await installEgressRecorder(page);
  await openNormalPage(page);
  await page.waitForTimeout(3_500);
  await interact(page);
  await page.waitForTimeout(3_500);
  await spaNavigate(page, EGRESS_CORPUS["score-results"]);
  await page.mouse.click(5, 5);
  await throwUncaught(page, "on the share link");
  await drain(page, recorder);
  expectClean(recorder, "opening a share link", {
    posthogFullSnapshot: true,
    sentryItems: ["event", "replay_event"],
    sentryFullSnapshot: true,
  });
});
