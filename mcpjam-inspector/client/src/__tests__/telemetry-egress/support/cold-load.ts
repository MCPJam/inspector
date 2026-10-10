/**
 * A cold load onto a credential URL, as one reusable scenario.
 *
 * The page's first URL is set per file (`@vitest-environment-options`), since
 * a cold load is exactly the case where every SDK initialises ON the secret:
 * PostHog's initial `$current_url`, Sentry's pageload transaction and request
 * URL, and the first privacy sync all read it. Three files cover the three
 * places a secret sits — path, query, fragment.
 *
 * Two tests, in order:
 *
 *  1. On the credential page: nothing records (no replay at all), the
 *     analytics and errors that DO leave are scrubbed, and a tab closed right
 *     there ships nothing planted in its beacon.
 *  2. Leaving for a normal page: recording starts, and what it records is the
 *     normal page — not the credential page that was on screen a moment ago.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  assertCorpusComplete,
  posthogEvents,
  posthogReplayEvents,
  sentryItems,
  sentryReplayEvents,
} from "../../../../../e2e/telemetry/egress";
import { bootTelemetryHarness, NORMAL_PAGE, type TelemetryHarness } from "./harness";
import { expectArrived, expectNoLeaks } from "./expect-egress";

/** See `session-egress.test.tsx`: Sentry drops a first segment under 5s. */
const SENTRY_MIN_SEGMENT_MS = 5_500;

/** Past `browserTracingIntegration`'s default 1s idle timeout. */
const PAGELOAD_IDLE_MS = 1_500;

export function describeColdLoad(options: {
  /** What kind of secret the file's URL carries, for the test names. */
  label: string;
  /** The sentinel the file's URL carries, to check the URL is what we think. */
  sentinel: string;
}): void {
  let harness: TelemetryHarness;

  beforeAll(async () => {
    assertCorpusComplete();
    // The environment option and the sentinel must agree, or the file proves
    // nothing about the URL it claims to test.
    expect(window.location.href).toContain(options.sentinel);
    harness = await bootTelemetryHarness();
    await harness.setLevel("full");
    await harness.idle(200);
  }, 60_000);

  describe(`a cold load onto ${options.label}`, () => {
    it("records nothing there, scrubs what leaves, and a tab closed there ships nothing planted", async () => {
      const mark = harness.mark();
      await harness.click();
      harness.posthog.capture("egress_cold_load_event");
      harness.posthog.captureException(new Error("cold load failure"));
      harness.Sentry.captureException(new Error("cold load sentry failure"));
      console.info("[egress] landed on", window.location.href);
      // The pageload span ends once the page has been idle for Sentry's idle
      // timeout (1s); only then is its transaction sent.
      await harness.idle(PAGELOAD_IDLE_MS);
      await harness.flush();
      // And a tab closed on the page, with whatever is buffered.
      harness.posthog.capture("egress_cold_load_unload");
      await harness.unload();
      window.dispatchEvent(
        new PageTransitionEvent("pageshow", { persisted: true }),
      );

      const scan = harness.scanSince(mark);
      expectNoLeaks(scan, options.label);
      expectArrived(scan, options.label, {
        posthogEvents: [
          "egress_cold_load_event",
          "egress_cold_load_unload",
          "$autocapture",
          "$exception",
        ],
        sentryItems: ["event", "transaction"],
      });
      // Analytics arrive; replay does not, from either recorder.
      expect(
        posthogReplayEvents(scan.decoded),
        "PostHog recorded on a credential page",
      ).toEqual([]);
      expect(
        sentryReplayEvents(scan.decoded),
        "Sentry Replay recorded on a credential page",
      ).toEqual([]);
      // The pageload transaction is named, not addressed.
      const pageload = sentryItems(scan.decoded).find(
        (item) =>
          item.type === "transaction" &&
          (item.payload as { contexts?: { trace?: { op?: string } } })
            .contexts?.trace?.op === "pageload",
      );
      expect(pageload, "no pageload transaction arrived").toBeDefined();
      expect(
        posthogEvents(scan.decoded).find(
          (event) => event.event === "egress_cold_load_event",
        )?.properties.$current_url,
      ).toMatch(/^https:\/\/app\.mcpjam\.com\//);
    }, 60_000);

    it("leaving for a normal page records the normal page, not the credential page", async () => {
      const mark = harness.mark();
      await harness.navigate(NORMAL_PAGE);
      await harness.click();
      harness.posthog.capture("egress_after_cold_load");
      await harness.idle(SENTRY_MIN_SEGMENT_MS);
      await harness.flush();

      const scan = harness.scanSince(mark);
      expectNoLeaks(scan, `leaving ${options.label}`);
      expectArrived(scan, `leaving ${options.label}`, {
        posthogEvents: ["egress_after_cold_load", "$snapshot"],
        posthogFullSnapshot: true,
        sentryFullSnapshot: true,
      });
    }, 60_000);
  });
}
