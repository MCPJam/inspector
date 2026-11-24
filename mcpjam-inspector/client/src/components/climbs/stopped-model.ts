/**
 * Words for the end of a climb: the confirmation's interval, the verification's
 * result and the grouping of kept changes. The numbers are the backend's and the
 * SDK's (the interval is found by resampling cases); these only say them.
 */
import type { ConfirmationInterval, VerificationEnvironment } from "@mcpjam/sdk/climbs";
import { COPY } from "./climb-copy";
import { percent, pointsChange } from "./climb-format";

const signed = (value: number, digits = 0): string => {
  const text = Math.abs(value).toFixed(digits).replace(/\.0+$/, "");
  return `${value < 0 ? "-" : "+"}${text}`;
};

/** "+27 points" or "12% fewer": the difference the confirmation measured, with its unit. */
export function differenceText(row: ConfirmationInterval): string {
  if (row.difference === null) return "No case to compare";
  if (row.unit === "points") return pointsChange(Math.round(row.difference * 100));
  return `${signed(row.difference, 1)}%`;
}

/** "Between +6 and +45 points", or why there is none. */
export function intervalText(row: ConfirmationInterval): string {
  if (row.low === null || row.high === null) return row.note ?? "Too few cases for an interval";
  const unit = row.unit === "points" ? " points" : "%";
  return `Between ${signed(row.low, row.unit === "points" ? 0 : 1)} and ${signed(row.high, row.unit === "points" ? 0 : 1)}${unit}`;
}

/** The gain a row's interval supports: it holds only when the interval is wholly on the good side of zero. */
export function intervalVerdict(row: ConfirmationInterval): "holds" | "within_noise" | "none" {
  if (row.difference === null || row.low === null || row.high === null) return "none";
  return row.includesZero ? "within_noise" : "holds";
}

export function verificationResult(env: VerificationEnvironment, holds: boolean): string {
  if (env.baselineNowBps !== undefined && env.baselineNowBps >= 10_000) return COPY.alreadyPasses;
  return holds ? COPY.holds : "Does not hold";
}

export const gainText = (bps: number | undefined): string => (bps === undefined ? "None" : pointsChange(bps));

export const rateText = (bps: number | null | undefined): string => (bps === null || bps === undefined ? "None" : percent(bps));
