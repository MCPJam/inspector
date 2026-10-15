/**
 * The telemetry egress proof against the real hosted build in a real
 * Chromium. Same corpus, same decoding, same two-sided assertions as the
 * jsdom harness (`client/src/__tests__/telemetry-egress/`), on what jsdom
 * cannot run: real layout for rrweb, PostHog's network capture (resource
 * timing), Sentry's compression worker, real keepalive fetch on unload, real
 * `popstate`, and the app's own pages and boot paths instead of a stand-in
 * page.
 *
 * The visitor is an authenticated member the backend answers `full` for
 * (the Convex stand-in answers `telemetryPrivacy:getContext`), so both
 * recorders run at the level where the most reaches the vendors
 * (`resolveSessionPrivacy`). The strict and unresolved contexts are covered in
 * jsdom (`session-egress.test.tsx`) and by the telemetry privacy browser test.
 *
 * Every test reads every PostHog and Sentry request its page made, decoded
 * all the way down, and fails on any planted sentinel, naming the sink and
 * the payload path — and fails too when the telemetry it drove never
 * arrived, so a run that observed nothing cannot pass.
 */
import { expect, test, type Page } from "@playwright/test";
import { captureSentryProof, waitForSentryReplay } from "./replay-resume-proof";
import { observeFetchOptions } from "./tests/fetch-observer";
import { TELEMETRY_ACTOR_ID, standInTelemetryPolicy } from "./convex-stand-in";
import {
  assertTelemetryBuild,
  drain,
  fireUnloadFlush,
  installEgressRecorder,
  interact,
  ORIGIN,
  spaNavigate,
  storageReport,
  waitForFullReplay,
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
  posthogEvents,
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

/** A public page every signed-out visitor can open: the score landing. */
const NORMAL_PAGE = "/";
const NORMAL_PAGE_TEXT = "Telemetry";

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

async function openNormalPage(
  page: Page,
  recorder: EgressRecorder,
): Promise<void> {
  await page.goto(`${ORIGIN}${NORMAL_PAGE}`);
  await expect(page.getByText(NORMAL_PAGE_TEXT).first()).toBeVisible({
    timeout: 30_000,
  });
  await interact(page);
  await waitForFullReplay(page, recorder);
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

test("a resolved open context delivers the permitted account identity", async ({ page }) => {
  expect(standInTelemetryPolicy({ projectIds: [], organizationIds: [] })).toEqual({
    recording: "off", identity: "id_only", content: "strict", telemetryActorId: TELEMETRY_ACTOR_ID,
  });
  const recorder = await installEgressRecorder(page);
  await openNormalPage(page, recorder);
  await drain(page, recorder);
  const scan = expectClean(recorder, "open-context identity", {
    posthogFullSnapshot: true,
  });
  // PostHog sends $set instead of another $identify after resolving the actor.
  expect(posthogEvents(scan.decoded)).toEqual(expect.arrayContaining([
    expect.objectContaining({
      properties: expect.objectContaining({ distinct_id: TELEMETRY_ACTOR_ID }),
      $set: expect.objectContaining({ email: "telemetry@example.invalid", name: "Telemetry Member" }),
    }),
  ]));
});

test("share links on a normal page at full: text, href and iframe src", async ({
  page,
}) => {
  const recorder = await installEgressRecorder(page);
  await openNormalPage(page, recorder);
  // A clean console frame is a positive control. The later credential-bearing
  // console frame is deliberately dropped at the relay's final serializer.
  await page.evaluate(() => console.log("[egress] full recording control"));
  await expect.poll(() => posthogReplayEvents(recorder.scanSince(0).decoded).some(
    event => event.type === RRWEB.Plugin &&
      (event.data as { plugin?: unknown })?.plugin === "rrweb/console@1",
  )).toBe(true);
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
  // A member, at `full`: AuthKit resolved and the replay shows
  // the page's words, unmasked.
  expect(recorder.api).toContain("POST /user_management/authenticate");

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
  await openNormalPage(page, recorder);
  // One entry per return to the normal page: from the moment the visitor
  // left the credential page until they leave the normal page again.
  const returns: Array<{
    id: string;
    from: number;
    until: number;
    mark: number;
    eventId: string;
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
    await expect(page.getByText(NORMAL_PAGE_TEXT).first()).toBeVisible();
    // An interaction straight away: posthog-js holds a new recording's
    // first flush until there is one.
    await page.mouse.click(5, 5);
    await page.waitForTimeout(dwell.back);
    // Every unresolved destination can stop replay. Require a new full
    // recording after this return, beyond the conservative settling delay.
    await waitForFullReplay(page, recorder, 30_000, mark, from);
    await waitForSentryReplay(page, recorder, mark, from);
    const eventId = await captureSentryProof(page, `liveness check after ${id}`);
    returns.push({ id, from, until: await pageNow(page), mark, eventId });
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

  // Both recorders must send fresh recording bytes after every return.
  // Retained strict breadcrumbs can keep later errors strict, so correlate
  // diagnostic arrival by the SDK's minted event ID, not free text/replay tags.
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
    expect.soft(errors.some((item) =>
      (item.payload as { event_id?: unknown }).event_id === visit.eventId),
      `Sentry diagnostic did not arrive after leaving ${visit.id}`).toBe(true);
    expect.soft(sentryReplayEvents(recorder.scanSince(visit.mark).decoded).some((event) => {
      const at = (event as { timestamp?: unknown }).timestamp;
      return (event.type === RRWEB.FullSnapshot || event.type === RRWEB.IncrementalSnapshot)
        && typeof at === "number" && at >= visit.from && at <= visit.until;
    }), `Sentry replay did not resume after leaving ${visit.id}`).toBe(true);
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
  await openNormalPage(page, recorder);
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

test("a normal-page unload delivers buffered events by authenticated keepalive fetch", async ({ page }) => {
  const fetches = await observeFetchOptions(page);
  const recorder = await installEgressRecorder(page);
  await openNormalPage(page, recorder);
  const ingressMark = recorder.ingress.length;
  const vendorMark = recorder.mark();
  const fetchMark = fetches.length;
  await interact(page);
  await fireUnloadFlush(page);
  await page.goto("about:blank");
  await page.waitForTimeout(1_500);
  expectClean(recorder, "normal-page unload", {
    posthogEvents: ["$autocapture"],
    posthogFullSnapshot: true,
  });
  expect(missingArrivals(recorder.scanSince(vendorMark).decoded, {
    posthogEvents: ["$autocapture"],
  })).toEqual([]);
  const ingress = recorder.ingress.slice(ingressMark).filter(
    (request) => request.url.includes("/tlm/") && request.method === "POST",
  );
  expect(ingress.length).toBeGreaterThan(0);
  for (const request of ingress) {
    expect(request.transport).toBe("fetch");
    expect(request.headers.authorization).toMatch(/^Bearer \S+$/);
    expect(request.headers["x-mcpjam-telemetry-policy"]).toBe("full");
  }
  expect(
    fetches.slice(fetchMark).some((request) =>
      request.url.includes("/tlm/") && request.keepalive &&
      request.authenticated && request.policy === "full",
    ),
  ).toBe(true);
});

test("a tab closed on a credential page ships nothing planted", async ({
  page,
}) => {
  const recorder = await installEgressRecorder(page);
  await openNormalPage(page, recorder);
  await page.waitForTimeout(2_500);
  await spaNavigate(page, EGRESS_CORPUS["score-results"]);
  await page.mouse.click(5, 5);
  await throwUncaught(page, "just before closing", 20);
  await fireUnloadFlush(page);
  await page.goto("about:blank");
  await page.waitForTimeout(1_500);
  expectClean(recorder, "closed on a credential page", {
    posthogEvents: ["$snapshot"],
    sentryItems: ["event"],
  });
});

test("a visitor who reads a page, then opens a share link", async ({
  page,
}) => {
  // Long enough on the normal page that Sentry keeps the replay segment the
  // guard stops on the way in (it drops a first segment under 5s) — so the
  // segment, and the replay event that describes it, are actually sent.
  const recorder = await installEgressRecorder(page);
  await openNormalPage(page, recorder);
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
