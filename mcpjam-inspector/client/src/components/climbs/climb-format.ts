/**
 * Words and numbers the climb screens share. The backend settles every number
 * (the keep rule, the noise, the verdicts); these only say them. Rates are
 * whole basis points: 100 is one percent.
 */
import type { PlatformClimbMeasure } from "@mcpjam/sdk/platform";

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

/** 7_850 becomes "78.5%"; whole percents drop the decimal. */
export function percent(bps: number): string {
  const value = Math.round(bps / 10) / 10;
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

/** A change in points of pass rate: "+17 points", "-5 points", or "No change". */
export function pointsChange(deltaBps: number): string {
  const points = Math.round(deltaBps / 10) / 10;
  if (points === 0) return "No change";
  const text = Number.isInteger(points) ? String(Math.abs(points)) : Math.abs(points).toFixed(1);
  return `${points > 0 ? "+" : "-"}${text} ${Math.abs(points) === 1 ? "point" : "points"}`;
}

/** The change in a measure as the ratio of the candidate to the best: 8_800 is "12% lower". */
export function ratioChange(ratioBps: number): string {
  const delta = Math.round((ratioBps - 10_000) / 10) / 10;
  if (delta === 0) return "No change";
  const text = Number.isInteger(delta) ? String(Math.abs(delta)) : Math.abs(delta).toFixed(1);
  return `${text}% ${delta < 0 ? "lower" : "higher"}`;
}

export const MEASURE_NAMES: Record<PlatformClimbMeasure, string> = {
  pass_rate: "pass rate",
  tokens: "tokens",
  cost: "cost",
  tool_calls: "tool calls",
};

export function measureTitle(measure: PlatformClimbMeasure): string {
  const name = MEASURE_NAMES[measure];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** The keep rule for a climb, in one sentence a person can check a round against. */
export function ruleSentence(measure: PlatformClimbMeasure, minImprovementBps: number): string {
  if (measure === "pass_rate") {
    return "Measures pass rate. A change is kept when pass rate goes up in at least one environment and nothing goes down, validation cases included.";
  }
  const name = MEASURE_NAMES[measure];
  const verb = measure === "cost" ? "falls" : "fall";
  const least = `${percent(minImprovementBps)}`;
  return `Measures ${name}. A change is kept when ${name} ${verb} by ${least} or more in at least one environment and every case still passes.`;
}

export function shortDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Whole numbers typed with or without commas; anything else is not a number. */
export function parseWhole(text: string): number | null {
  const cleaned = text.trim().replace(/,/g, "");
  if (!/^\d+$/.test(cleaned)) return null;
  return Number(cleaned);
}
