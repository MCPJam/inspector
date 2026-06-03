import { describe, expect, it } from "vitest";
import { median, percentile } from "../use-cross-host-data";

describe("median", () => {
  it("returns null for an empty array", () => {
    expect(median([])).toBeNull();
  });

  it("returns the single value for a one-element array", () => {
    expect(median([42])).toBe(42);
  });

  it("returns the middle value for an odd-length sorted array", () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 5, 100])).toBe(5);
  });

  it("returns the mean of the two middle values for an even-length array", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([10, 20])).toBe(15);
  });

  it("does not require pre-sorted input — sorts internally", () => {
    expect(median([5, 1, 3, 2, 4])).toBe(3);
    expect(median([100, 1, 50])).toBe(50);
  });

  it("does not mutate the caller's array", () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });

  it("median dampens a single tail-latency outlier (the main motivation)", () => {
    // Five samples around 1s, one at 10s. Mean would be ~2.5s, median is ~1s.
    // This is exactly the cross-host case where one host gets a slow run.
    const samples = [900, 1000, 1100, 950, 1050, 10000];
    const med = median(samples);
    // Sorted: [900, 950, 1000, 1050, 1100, 10000] — even length, middle two are 1000 and 1050
    expect(med).toBe(1025);
  });
});

describe("percentile", () => {
  it("returns null for an empty array", () => {
    expect(percentile([], 95)).toBeNull();
  });

  it("returns the single value for a one-element array", () => {
    expect(percentile([42], 95)).toBe(42);
  });

  it("interpolates p95 for multiple samples", () => {
    expect(percentile([1, 2, 3, 4, 5], 95)).toBeCloseTo(4.8, 5);
  });
});
