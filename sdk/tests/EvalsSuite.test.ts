import { EvalsSuite } from "../src/EvalsSuite";

describe("EvalsSuite", () => {
  describe("constructor", () => {
    it("should create an instance with default name", () => {
      const suite = new EvalsSuite();
      expect(suite.getName()).toBe("EvalsSuite");
    });

    it("should accept custom name", () => {
      const suite = new EvalsSuite({ name: "CustomSuite" });
      expect(suite.getName()).toBe("CustomSuite");
    });
  });

  describe("run", () => {
    it("should run iterations and track results", async () => {
      const suite = new EvalsSuite();
      let counter = 0;

      const result = await suite.run({
        func: () => {
          counter++;
          return true;
        },
        iterations: 5,
      });

      expect(counter).toBe(5);
      expect(result.iterations).toBe(5);
      expect(result.successes).toBe(5);
      expect(result.failures).toBe(0);
      expect(result.results).toEqual([true, true, true, true, true]);
    });

    it("should handle mixed results", async () => {
      const suite = new EvalsSuite();
      let counter = 0;

      const result = await suite.run({
        func: () => {
          counter++;
          return counter % 2 === 0; // true on even iterations
        },
        iterations: 4,
      });

      expect(result.successes).toBe(2);
      expect(result.failures).toBe(2);
      expect(result.results).toEqual([false, true, false, true]);
    });

    it("should handle async functions", async () => {
      const suite = new EvalsSuite();

      const result = await suite.run({
        func: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          return true;
        },
        iterations: 3,
      });

      expect(result.successes).toBe(3);
    });

    it("should treat thrown errors as failures", async () => {
      const suite = new EvalsSuite();

      const result = await suite.run({
        func: () => {
          throw new Error("Test error");
        },
        iterations: 3,
      });

      expect(result.failures).toBe(3);
      expect(result.results).toEqual([false, false, false]);
    });
  });

  describe("metrics", () => {
    it("should calculate accuracy correctly", async () => {
      const suite = new EvalsSuite();
      let counter = 0;

      await suite.run({
        func: () => {
          counter++;
          return counter <= 8; // 8 successes, 2 failures
        },
        iterations: 10,
      });

      expect(suite.accuracy()).toBe(0.8);
    });

    it("should throw if metrics called before run", () => {
      const suite = new EvalsSuite();

      expect(() => suite.accuracy()).toThrow(
        "No run results available. Call run() first."
      );
      expect(() => suite.recall()).toThrow(
        "No run results available. Call run() first."
      );
      expect(() => suite.precision()).toThrow(
        "No run results available. Call run() first."
      );
      expect(() => suite.falsePositiveRate()).toThrow(
        "No run results available. Call run() first."
      );
      expect(() => suite.averageTokenUse()).toThrow(
        "No run results available. Call run() first."
      );
    });

    it("should calculate falsePositiveRate correctly", async () => {
      const suite = new EvalsSuite();

      await suite.run({
        func: () => false,
        iterations: 10,
      });

      expect(suite.falsePositiveRate()).toBe(1.0);
    });
  });

  describe("getResults", () => {
    it("should return null before run", () => {
      const suite = new EvalsSuite();
      expect(suite.getResults()).toBeNull();
    });

    it("should return results after run", async () => {
      const suite = new EvalsSuite();

      await suite.run({
        func: () => true,
        iterations: 3,
      });

      const results = suite.getResults();
      expect(results).not.toBeNull();
      expect(results?.iterations).toBe(3);
    });
  });
});
