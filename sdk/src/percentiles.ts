/**
 * Percentile calculation utilities for latency statistics
 */

/**
 * Calculate a specific percentile from sorted values.
 *
 * @param sortedValues - Array of numbers sorted in ascending order
 * @param percentile - The percentile to calculate (0-100)
 * @returns The percentile value
 * @throws Error if array is empty or percentile is out of range
 */
export function calculatePercentile(
  sortedValues: number[],
  percentile: number
): number {
  if (sortedValues.length === 0) {
    throw new Error("Cannot calculate percentile of empty array");
  }
  if (percentile < 0 || percentile > 100) {
    throw new Error("Percentile must be between 0 and 100");
  }

  const index = (percentile / 100) * (sortedValues.length - 1);
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);

  if (lowerIndex === upperIndex) {
    return sortedValues[lowerIndex];
  }

  // Linear interpolation between the two values
  const weight = index - lowerIndex;
  return (
    sortedValues[lowerIndex] * (1 - weight) + sortedValues[upperIndex] * weight
  );
}

/**
 * Statistics for latency values
 */
export interface LatencyStats {
  /** Minimum value */
  min: number;
  /** Maximum value */
  max: number;
  /** Mean (average) value */
  mean: number;
  /** 50th percentile (median) */
  p50: number;
  /** 95th percentile */
  p95: number;
  /** Number of values */
  count: number;
}

/**
 * Calculate comprehensive latency statistics for a set of values.
 *
 * @param values - Array of latency values (milliseconds)
 * @returns LatencyStats object with min, max, mean, p50, p95, and count
 * @throws Error if array is empty
 */
export function calculateLatencyStats(values: number[]): LatencyStats {
  if (values.length === 0) {
    throw new Error("Cannot calculate stats of empty array");
  }

  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((acc, val) => acc + val, 0);

  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / values.length,
    p50: calculatePercentile(sorted, 50),
    p95: calculatePercentile(sorted, 95),
    count: values.length,
  };
}
