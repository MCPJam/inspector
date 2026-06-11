import { describe, expect, it } from "vitest";
import {
  attachComputerPatch,
  catalogHasComputerBackedTool,
  computerBackedToolIds,
  detachComputerPatch,
  sanitizeHostConfigForEvalSuite,
  shouldShowComputerToggle,
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

describe("shouldShowComputerToggle", () => {
  it("shows when the catalog has a computer-backed tool", () => {
    expect(
      shouldShowComputerToggle({
        catalogHasComputerBackedTool: true,
        computerAttached: false,
      })
    ).toBe(true);
  });

  it("shows when a computer is already attached, even with no backed tool (so it's detachable)", () => {
    expect(
      shouldShowComputerToggle({
        catalogHasComputerBackedTool: false,
        computerAttached: true,
      })
    ).toBe(true);
  });

  it("hides when neither holds", () => {
    expect(
      shouldShowComputerToggle({
        catalogHasComputerBackedTool: false,
        computerAttached: false,
      })
    ).toBe(false);
  });

  it("always hides when disallowed (eval suites), even if a computer is attached", () => {
    expect(
      shouldShowComputerToggle({
        catalogHasComputerBackedTool: true,
        computerAttached: true,
        disallowed: true,
      })
    ).toBe(false);
  });
});

describe("sanitizeHostConfigForEvalSuite", () => {
  it("clears the computer and strips computer-backed ids", () => {
    const value = emptyHostConfigInputV2({
      builtInToolIds: ["web_search", "bash"],
      computer: { kind: "personal", workdir: "/srv" },
    });
    const out = sanitizeHostConfigForEvalSuite(value, CATALOG);
    expect(out.computer).toBeUndefined();
    expect(out.builtInToolIds).toEqual(["web_search"]);
  });

  it("clears the computer even before the catalog has loaded (catalog-independent)", () => {
    const value = emptyHostConfigInputV2({
      builtInToolIds: ["web_search", "bash"],
      computer: { kind: "personal" },
    });
    const out = sanitizeHostConfigForEvalSuite(value, undefined);
    expect(out.computer).toBeUndefined();
    // bash not stripped without the catalog, but it's inert in evals (the
    // resolver skips it without a computer, and the run-start guard keys on
    // `computer`, now cleared).
    expect(out.builtInToolIds).toEqual(["web_search", "bash"]);
  });

  it("returns the same reference when already clean (no spurious dirty state)", () => {
    const value = emptyHostConfigInputV2({ builtInToolIds: ["web_search"] });
    expect(sanitizeHostConfigForEvalSuite(value, CATALOG)).toBe(value);
  });
});
