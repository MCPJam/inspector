import { describe, it, expect } from "vitest";
import type { EnrichedRegistryCatalogCard } from "@/hooks/useRegistryServers";
import { compareQuickConnectCatalogCards } from "../quick-connect-catalog-sort";

function card(
  displayName: string,
  opts: {
    catalogSortOrder: number;
    clientTypes: ("app" | "text")[];
  },
): EnrichedRegistryCatalogCard {
  const variants = opts.clientTypes.map((clientType, i) => ({
    _id: `${displayName}-${i}`,
    name: `mcp.${displayName}.${i}`,
    displayName,
    description: "",
    publisher: "x",
    publishStatus: "verified" as const,
    scope: "global" as const,
    transport: {
      transportType: "http" as const,
      url: "https://example.com",
      useOAuth: true,
    },
    status: "approved" as const,
    createdBy: "u",
    createdAt: 0,
    updatedAt: 0,
    connectionStatus: "not_connected" as const,
    clientType,
  }));
  return {
    registryCardKey: `card-${displayName}`,
    catalogSortOrder: opts.catalogSortOrder,
    variants,
    starCount: 0,
    isStarred: false,
    hasDualType: opts.clientTypes.length > 1,
  };
}

describe("compareQuickConnectCatalogCards", () => {
  it("orders App-capable cards before text-only when catalogSortOrder would disagree", () => {
    const textFirst = card("Zebra", {
      catalogSortOrder: 0,
      clientTypes: ["text"],
    });
    const appLater = card("Acme", {
      catalogSortOrder: 99,
      clientTypes: ["app"],
    });
    const sorted = [textFirst, appLater].sort(compareQuickConnectCatalogCards);
    expect(sorted[0].variants[0].displayName).toBe("Acme");
    expect(sorted[1].variants[0].displayName).toBe("Zebra");
  });

  it("places Excalidraw before Asana before other App servers", () => {
    const asana = card("Asana", { catalogSortOrder: 0, clientTypes: ["app"] });
    const notion = card("Notion", {
      catalogSortOrder: 0,
      clientTypes: ["app"],
    });
    const excalidraw = card("Excalidraw", {
      catalogSortOrder: 99,
      clientTypes: ["app"],
    });
    const sorted = [asana, notion, excalidraw].sort(
      compareQuickConnectCatalogCards,
    );
    expect(sorted.map((c) => c.variants[0].displayName)).toEqual([
      "Excalidraw",
      "Asana",
      "Notion",
    ]);
  });

  it("uses catalogSortOrder among non-pinned App servers", () => {
    const b = card("Bravo", { catalogSortOrder: 2, clientTypes: ["app"] });
    const a = card("Alpha", { catalogSortOrder: 1, clientTypes: ["app"] });
    const sorted = [b, a].sort(compareQuickConnectCatalogCards);
    expect(sorted.map((c) => c.variants[0].displayName)).toEqual([
      "Alpha",
      "Bravo",
    ]);
  });
});
