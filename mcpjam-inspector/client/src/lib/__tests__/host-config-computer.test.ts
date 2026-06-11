import { describe, expect, it } from "vitest";
import {
  attachComputerPatch,
  catalogHasComputerBackedTool,
  computerBackedToolIds,
  detachComputerPatch,
} from "../host-config-computer";
import { emptyHostConfigInputV2 } from "../client-config-v2";
import type { BuiltInToolCatalogEntry } from "@/hooks/useBuiltInToolCatalog";

const CATALOG: BuiltInToolCatalogEntry[] = [
  {
    id: "web_search",
    displayLabel: "Web Search",
    description: "",
    category: "search",
    billable: true,
  },
  {
    id: "bash",
    displayLabel: "Bash",
    description: "",
    category: "code",
    billable: false,
    requiresComputer: true,
  },
];

describe("host-config-computer helpers", () => {
  it("detects a computer-backed tool in the catalog", () => {
    expect(catalogHasComputerBackedTool(CATALOG)).toBe(true);
    expect(catalogHasComputerBackedTool([CATALOG[0]])).toBe(false);
    expect(catalogHasComputerBackedTool(undefined)).toBe(false);
  });

  it("collects computer-backed ids", () => {
    expect([...computerBackedToolIds(CATALOG)]).toEqual(["bash"]);
  });

  it("attachComputerPatch attaches the resource shape", () => {
    expect(attachComputerPatch()).toEqual({ computer: { kind: "personal" } });
  });

  it("detachComputerPatch clears the computer AND strips computer-backed ids", () => {
    const value = emptyHostConfigInputV2({
      builtInToolIds: ["web_search", "bash"],
      computer: { kind: "personal" },
    });
    expect(detachComputerPatch(value, CATALOG)).toEqual({
      computer: undefined,
      builtInToolIds: ["web_search"],
    });
  });

  it("detachComputerPatch leaves non-computer ids untouched when none are backed", () => {
    const value = emptyHostConfigInputV2({ builtInToolIds: ["web_search"] });
    expect(detachComputerPatch(value, CATALOG)).toEqual({
      computer: undefined,
      builtInToolIds: ["web_search"],
    });
  });
});
