import { describe, it, expect } from "vitest";
import { formatRegistryStarCount } from "../format-registry-star-count";

describe("formatRegistryStarCount", () => {
  it("shows exact integers below 1000", () => {
    expect(formatRegistryStarCount(0)).toBe("0");
    expect(formatRegistryStarCount(999)).toBe("999");
  });

  it("buckets at 1k+ and 2k+", () => {
    expect(formatRegistryStarCount(1000)).toBe("1k+");
    expect(formatRegistryStarCount(1999)).toBe("1k+");
    expect(formatRegistryStarCount(2000)).toBe("2k+");
  });
});
