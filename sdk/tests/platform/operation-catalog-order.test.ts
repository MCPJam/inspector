import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as conformanceOperations from "../../src/platform/conformance-operations";
import * as platformEntry from "../../src/platform/index";
import * as operations from "../../src/platform/operations";
import { ALL_OPERATIONS } from "../../src/platform/operations";

// Every surface (MCP tools, CLI bindings, the agent registry) reads the
// catalog in this order, so a move between modules must not reorder it. A
// deliberate change to the catalog updates the fixture in the same diff.
const expectedOrder = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/platform-operation-catalog-order.json",
      import.meta.url
    ),
    "utf8"
  )
) as string[];

describe("platform operation catalog", () => {
  it("keeps every operation's name and position", () => {
    expect(ALL_OPERATIONS.map((operation) => operation.name)).toEqual(
      expectedOrder
    );
  });

  it("serves the conformance operations from operations.ts and the platform entry", () => {
    const moved = Object.entries(conformanceOperations).filter(
      ([, value]) => typeof value === "object" && value !== null
    );
    expect(moved.map(([name]) => name).sort()).toEqual([
      "getConformanceReportOperation",
      "getConformanceRunOperation",
      "listConformanceRunsOperation",
      "startConformanceRunOperation",
    ]);
    for (const [name, value] of moved) {
      expect((operations as Record<string, unknown>)[name]).toBe(value);
      expect((platformEntry as Record<string, unknown>)[name]).toBe(value);
      expect(ALL_OPERATIONS).toContain(value);
    }
  });
});
