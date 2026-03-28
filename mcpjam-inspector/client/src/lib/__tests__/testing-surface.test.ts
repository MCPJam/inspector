import { describe, expect, it } from "vitest";
import {
  readTestingSurfaceFromHash,
  withTestingSurface,
} from "../testing-surface";

describe("testing-surface", () => {
  describe("readTestingSurfaceFromHash", () => {
    it("returns runs for ci-evals paths", () => {
      expect(readTestingSurfaceFromHash("#/ci-evals")).toBe("runs");
      expect(readTestingSurfaceFromHash("#/ci-evals/create")).toBe("runs");
      expect(readTestingSurfaceFromHash("#/ci-evals/suite/s_1")).toBe("runs");
    });

    it("returns explore for evals without legacy suites surface", () => {
      expect(readTestingSurfaceFromHash("#/evals")).toBe("explore");
      expect(readTestingSurfaceFromHash("#/evals?foo=bar")).toBe("explore");
    });

    it("maps legacy ?surface=suites to explore", () => {
      expect(readTestingSurfaceFromHash("#/evals?surface=suites")).toBe(
        "explore",
      );
    });
  });

  describe("withTestingSurface", () => {
    it("strips surface query param", () => {
      expect(withTestingSurface("#/evals?surface=runs&x=1")).toBe(
        "#/evals?x=1",
      );
    });

    it("preserves hash without surface param", () => {
      expect(withTestingSurface("#/evals?iteration=i_1")).toBe(
        "#/evals?iteration=i_1",
      );
    });
  });
});
