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
  fireUnloadFlush,
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
  LINK_ONLY_EGRESS_URLS,
  leakReport,
  missingArrivals,
  pageCorpus,
  posthogReplayEvents,
  recordedText,
  RRWEB,
  sentinel,
  sentryItems,
  sentryReplayEvents,
  type Arrivals,
} from "./egress";

/**
 * How long a visitor stays on a credential page and then on the normal page
 * it returns to, in the round-trip test, in rotation:
 *
 *  - a short stay both ways;
 *  - a long return, so Sentry keeps the replay segment (it discards a
 *    session shorter than about 5s) and the guard's next `stop()` really
 *    flushes one;
 *  - a quick in-and-out right after it: back on the normal page while that
 *    flush is still waiting on Sentry (`SENTRY_LATENCY_MS`), the race
 *    `syncSentryReplay` waits out before it resumes.
 *
 * Every return outlasts the slowest flush, so a recorder that resumed is
 * recording by the time the return is checked. The corpus has 11 pages, so
 * the last return is a long one.
 */
const ROUND_TRIP_DWELLS_MS: ReadonlyArray<{ away: number; back: number }> = [
  { away: 400, back: 1_200 },
  { away: 2_500, back: 5_500 },
  { away: 250, back: 1_500 },
];
const SENTRY_LATENCY_MS = 800;

/**
 * Credential pages that are share links. A share link is recorded `masked`,
 * and the way back to `full` waits `MASKED_TO_FULL_SETTLE_MS` (3s,
 * hooks/useSessionPrivacy.ts) — Sentry Replay, which records only at `full`,
 * is held off until then. A return from one lasts past that.
 */
const SHARE_LINK_ROUTES = new Set<string>(["tester-link"]);
const SHARE_LINK_RETURN_MS = 4_500;

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
async function throwUncaught(
  page: Page,
  message: string,
  settleMs = 200,
): Promise<void> {
  await page.evaluate((text) => {
    setTimeout(() => {
      throw new Error(text);
    }, 0);
  }, message);
  await page.waitForTimeout(settleMs);
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
    [
      ...Object.values(EGRESS_CORPUS),
      ...GENERIC_EGRESS_URLS,
      ...LINK_ONLY_EGRESS_URLS,
    ],
  );
  await interact(page);
  await page.evaluate(
    (url) => console.log("[egress] copied", url),
    EGRESS_CORPUS["tester-link"],
  );
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

/** The page's clock: what rrweb stamps its events with. */
function pageNow(page: Page): Promise<number> {
  return page.evaluate(() => Date.now());
}

test("SPA navigation from a normal page onto every credential page and back", async ({
  page,
}) => {
  const recorder = await installEgressRecorder(page, {
    sentryLatencyMs: SENTRY_LATENCY_MS,
  });
  await openNormalPage(page);
  // One entry per return to the normal page: from the moment the visitor
  // left the credential page until they leave the normal page again.
  const returns: Array<{
    id: string;
    from: number;
    until: number;
    mark: number;
    error: string;
  }> = [];
  for (const [index, [id, url]] of pageCorpus().entries()) {
    const dwell = ROUND_TRIP_DWELLS_MS[index % ROUND_TRIP_DWELLS_MS.length]!;
    await spaNavigate(page, url);
    await page.mouse.click(5, 5);
    await page.waitForTimeout(dwell.away);
    const mark = recorder.mark();
    const from = await pageNow(page);
    await page.goBack();
    // Some credential pages hand off to another page (`/home`); back from
    // there is not the normal page, so go to it.
    if (new URL(page.url()).pathname !== NORMAL_PAGE) {
      await spaNavigate(page, NORMAL_PAGE);
    }
    // An interaction straight away: posthog-js holds a new recording's
    // first flush until there is one.
    await page.mouse.click(5, 5);
    await page.waitForTimeout(
      SHARE_LINK_ROUTES.has(id)
        ? Math.max(dwell.back, SHARE_LINK_RETURN_MS)
        : dwell.back,
    );
    const error = `liveness check after ${id}`;
    await throwUncaught(page, error);
    returns.push({ id, from, until: await pageNow(page), mark, error });
  }
  await interact(page);
  await throwUncaught(page, "after the round trip");
  await drain(page, recorder);
  const scan = expectClean(recorder, "SPA navigation", {
    posthogEvents: ["$snapshot"],
    posthogFullSnapshot: true,
    sentryItems: ["event"],
    sentryFullSnapshot: true,
  });

  // Not just somewhere in the run: BOTH recorders came back after EVERY
  // visit. PostHog shows it with DOM events recorded during that return
  // (a full snapshot on resume, the click straight after it) and sent after
  // it began; Sentry with the replay it tags an error thrown during that
  // return with — a quick return's own segment is too short for Sentry to
  // keep, so the tag is what a resumed replay leaves.
  const errors = sentryItems(scan.decoded).filter(
    (item) => item.type === "event",
  );
  for (const visit of returns) {
    const recorded = posthogReplayEvents(
      recorder.scanSince(visit.mark).decoded,
    ).filter((event) => {
      const at = (event as { timestamp?: unknown }).timestamp;
      return (
        (event.type === RRWEB.FullSnapshot ||
          event.type === RRWEB.IncrementalSnapshot) &&
        typeof at === "number" &&
        at >= visit.from &&
        at <= visit.until
      );
    });
    expect
      .soft(
        recorded.length,
        `PostHog replay was not recording after leaving ${visit.id}`,
      )
      .toBeGreaterThan(0);
    const error = errors.find((item) =>
      JSON.stringify(item.payload).includes(visit.error),
    );
    expect
      .soft(
        (error?.payload as { tags?: { replayId?: unknown } } | undefined)?.tags
          ?.replayId,
        `Sentry Replay was not recording after leaving ${visit.id}`,
      )
      .toEqual(expect.any(String));
  }
  // The last return lasts past Sentry's minimum, so what it recorded there
  // is sent, not only tagged.
  const last = returns.at(-1)!;
  expect(
    sentryReplayEvents(scan.decoded).some((event) => {
      const at = (event as { timestamp?: unknown }).timestamp;
      return (
        (event.type === RRWEB.FullSnapshot ||
          event.type === RRWEB.IncrementalSnapshot) &&
        typeof at === "number" &&
        at >= last.from &&
        at <= last.until
      );
    }),
    "Sentry sent nothing it recorded during the last return",
  ).toBe(true);
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
  // Only long enough for both SDKs to take the error. A longer wait let
  // PostHog's 3s request-queue timer empty the queue first now and then,
  // leaving the unload flush nothing to send.
  await throwUncaught(page, "just before closing", 20);
  // No waiting: the tab goes with PostHog's queue and replay buffer full.
  // Its unload flush runs first from the live page, so the beacon it sends
  // is one the route can read (`fireUnloadFlush`).
  await fireUnloadFlush(page);
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

test("a visitor who reads a page, then opens a share link", async ({
  page,
}) => {
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
