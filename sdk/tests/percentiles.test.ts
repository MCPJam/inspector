import { calculatePercentile, calculateLatencyStats } from "../src/percentiles";

describe("percentiles", () => {
  describe("calculatePercentile", () => {
    it("should calculate p50 (median) for odd-length array", () => {
      const values = [1, 2, 3, 4, 5];
      expect(calculatePercentile(values, 50)).toBe(3);
    });

    it("should calculate p50 (median) for even-length array", () => {
      const values = [1, 2, 3, 4];
      expect(calculatePercentile(values, 50)).toBe(2.5);
    });

    it("should calculate p0 (minimum)", () => {
      const values = [10, 20, 30, 40, 50];
      expect(calculatePercentile(values, 0)).toBe(10);
    });

    it("should calculate p100 (maximum)", () => {
      const values = [10, 20, 30, 40, 50];
      expect(calculatePercentile(values, 100)).toBe(50);
    });

    it("should calculate p95", () => {
      const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      // p95 index = 0.95 * 9 = 8.55, interpolate between values[8]=9 and values[9]=10
      expect(calculatePercentile(values, 95)).toBeCloseTo(9.55, 2);
    });

    it("should calculate p25", () => {
      const values = [1, 2, 3, 4, 5];
      // p25 index = 0.25 * 4 = 1, which is exactly values[1]=2
      expect(calculatePercentile(values, 25)).toBe(2);
    });

    it("should handle single-element array", () => {
      const values = [42];
      expect(calculatePercentile(values, 0)).toBe(42);
      expect(calculatePercentile(values, 50)).toBe(42);
      expect(calculatePercentile(values, 100)).toBe(42);
    });

    it("should throw for empty array", () => {
      expect(() => calculatePercentile([], 50)).toThrow(
        "Cannot calculate percentile of empty array"
      );
    });

    it("should throw for percentile < 0", () => {
      expect(() => calculatePercentile([1, 2, 3], -1)).toThrow(
        "Percentile must be between 0 and 100"
      );
    });

    it("should throw for percentile > 100", () => {
      expect(() => calculatePercentile([1, 2, 3], 101)).toThrow(
        "Percentile must be between 0 and 100"
      );
    });

    it("should interpolate correctly between values", () => {
      const values = [100, 200];
      // p50 should be 150 (midpoint)
      expect(calculatePercentile(values, 50)).toBe(150);
      // p25 should be 125
      expect(calculatePercentile(values, 25)).toBe(125);
      // p75 should be 175
      expect(calculatePercentile(values, 75)).toBe(175);
    });
  });

  describe("calculateLatencyStats", () => {
    it("should calculate all stats correctly", () => {
      const values = [100, 200, 150, 300, 250];
      const stats = calculateLatencyStats(values);

      expect(stats.min).toBe(100);
      expect(stats.max).toBe(300);
      expect(stats.mean).toBe(200); // (100+200+150+300+250)/5 = 1000/5 = 200
      expect(stats.p50).toBe(200); // sorted: [100,150,200,250,300], median is 200
      expect(stats.count).toBe(5);
    });

    it("should calculate p95 correctly", () => {
      // Create array of 100 values from 1 to 100
      const values = Array.from({ length: 100 }, (_, i) => i + 1);
      const stats = calculateLatencyStats(values);

      expect(stats.min).toBe(1);
      expect(stats.max).toBe(100);
      expect(stats.mean).toBe(50.5); // average of 1-100
      expect(stats.p50).toBe(50.5); // median
      expect(stats.p95).toBeCloseTo(95.05, 1); // close to 95
      expect(stats.count).toBe(100);
    });

    it("should handle single-element array", () => {
      const stats = calculateLatencyStats([42]);

      expect(stats.min).toBe(42);
      expect(stats.max).toBe(42);
      expect(stats.mean).toBe(42);
      expect(stats.p50).toBe(42);
      expect(stats.p95).toBe(42);
      expect(stats.count).toBe(1);
    });

    it("should throw for empty array", () => {
      expect(() => calculateLatencyStats([])).toThrow(
        "Cannot calculate stats of empty array"
      );
    });

    it("should not modify the original array", () => {
      const values = [300, 100, 200];
      const original = [...values];

      calculateLatencyStats(values);

      expect(values).toEqual(original);
    });

    it("should handle decimal values", () => {
      const values = [1.5, 2.5, 3.5, 4.5, 5.5];
      const stats = calculateLatencyStats(values);

      expect(stats.min).toBe(1.5);
      expect(stats.max).toBe(5.5);
      expect(stats.mean).toBe(3.5);
      expect(stats.p50).toBe(3.5);
    });

    it("should handle duplicate values", () => {
      const values = [100, 100, 100, 100, 100];
      const stats = calculateLatencyStats(values);

      expect(stats.min).toBe(100);
      expect(stats.max).toBe(100);
      expect(stats.mean).toBe(100);
      expect(stats.p50).toBe(100);
      expect(stats.p95).toBe(100);
    });

    it("should handle realistic latency values", () => {
      // Simulated realistic latency distribution
      const values = [
        45,
        52,
        48,
        55,
        49,
        51,
        53,
        47,
        120,
        46, // mostly 45-55ms with one outlier
      ];
      const stats = calculateLatencyStats(values);

      expect(stats.min).toBe(45);
      expect(stats.max).toBe(120);
      expect(stats.mean).toBeCloseTo(56.6, 1);
      expect(stats.count).toBe(10);
    });
  });
});
