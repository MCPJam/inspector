import { describe, it, expect } from "vitest";
import { extractCatalogCards } from "../registry-http";

describe("extractCatalogCards", () => {
  it("reads cards from cards, catalog, or top-level array", () => {
    const row = {
      registryCardKey: "k",
      catalogSortOrder: 0,
      variants: [],
      starCount: 0,
      isStarred: false,
    };
    expect(extractCatalogCards({ cards: [row] })).toEqual([row]);
    expect(extractCatalogCards({ catalog: [row] })).toEqual([row]);
    expect(extractCatalogCards([row])).toEqual([row]);
    expect(extractCatalogCards({})).toEqual([]);
    expect(extractCatalogCards(null)).toEqual([]);
  });
});
