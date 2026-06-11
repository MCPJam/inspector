import { describe, expect, it } from "vitest";
import {
  attachComputerPatch,
  catalogHasComputerBackedTool,
  computerBackedToolIds,
  detachComputerPatch,
  sanitizeHostConfigForEvalSuite,
  shouldShowComputerToggle,
  visibleBuiltInToolCatalog,
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

  it("detachComputerPatch strips bash even when the catalog is undefined or omits it (disabled/loading)", () => {
    // The bot's case: catalog hasn't loaded (or omits the disabled `bash`
    // row), so the live `requiresComputer` flag can't identify it — the known
    // floor must still clear it so the draft can't violate requiresComputer.
    const value = emptyHostConfigInputV2({
      builtInToolIds: ["web_search", "bash"],
      computer: { kind: "personal" },
    });
    expect(detachComputerPatch(value, undefined)).toEqual({
      computer: undefined,
      builtInToolIds: ["web_search"],
    });
    // Same when the catalog is present but excludes bash (only web_search).
    expect(detachComputerPatch(value, [CATALOG[0]])).toEqual({
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

describe("visibleBuiltInToolCatalog", () => {
  it("returns the catalog unchanged when the computers flag is on", () => {
    expect(
      visibleBuiltInToolCatalog(CATALOG, {
        computersEnabled: true,
        selectedIds: [],
      })
    ).toBe(CATALOG);
  });

  it("hides computer-backed rows when the flag is off (enabled bash row stays invisible pre-rollout)", () => {
    expect(
      visibleBuiltInToolCatalog(CATALOG, {
        computersEnabled: false,
        selectedIds: [],
      })
    ).toEqual([CATALOG[0]]);
  });

  it("keeps a computer-backed row that is already selected, so a stale id stays removable", () => {
    expect(
      visibleBuiltInToolCatalog(CATALOG, {
        computersEnabled: false,
        selectedIds: ["bash"],
      })
    ).toEqual(CATALOG);
  });

  it("passes `undefined` through (catalog still loading)", () => {
    expect(
      visibleBuiltInToolCatalog(undefined, {
        computersEnabled: false,
        selectedIds: [],
      })
    ).toBeUndefined();
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

  it("clears the computer AND strips known computer-backed ids even before the catalog loads", () => {
    const value = emptyHostConfigInputV2({
      builtInToolIds: ["web_search", "bash"],
      computer: { kind: "personal" },
    });
    const out = sanitizeHostConfigForEvalSuite(value, undefined);
    expect(out.computer).toBeUndefined();
    // `bash` is stripped via the known floor even with no catalog loaded.
    expect(out.builtInToolIds).toEqual(["web_search"]);
  });

  it("returns the same reference when already clean (no spurious dirty state)", () => {
    const value = emptyHostConfigInputV2({ builtInToolIds: ["web_search"] });
    expect(sanitizeHostConfigForEvalSuite(value, CATALOG)).toBe(value);
  });
});
