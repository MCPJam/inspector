/**
 * The two halves of every egress assertion, kept together so no test can
 * make one without the other:
 *
 *  - nothing planted got out (`expectNoLeaks`), reported per sink with the
 *    exact payload path of each hit, so a failure names the field to fix;
 *  - what should have arrived did (`expectArrived`), so a harness that
 *    captured nothing — a stub that swallowed requests, a recorder that never
 *    started, a decoder that skipped a body — fails instead of passing.
 *
 * The checks themselves are `leakReport` and `missingArrivals` in
 * `e2e/telemetry/egress.ts`, shared with the Playwright job.
 */
import { expect } from "vitest";
import {
  leakReport,
  missingArrivals,
  scanAll,
  type Arrivals,
} from "../../../../../e2e/telemetry/egress";

type Scan = ReturnType<typeof scanAll>;

export function expectNoLeaks(scan: Scan, label: string): void {
  const report = leakReport(scan.hits);
  for (const sink of ["posthog", "sentry"] as const) {
    expect
      .soft(
        report[sink],
        `${label}: a planted credential reached ${sink} (payload path per line)`,
      )
      .toBe("");
  }
}

export function expectArrived(
  scan: Scan,
  label: string,
  wanted: Arrivals,
): void {
  expect(
    missingArrivals(scan.decoded, wanted),
    `${label}: expected telemetry never arrived`,
  ).toEqual([]);
}
