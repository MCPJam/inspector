import { describe, expect, it } from "vitest";
import { buildSuiteRunPlans, countSuiteRunPlans } from "../helpers";

/**
 * CONTRACT: `countSuiteRunPlans` is what the pre-run credit estimate sends to
 * the backend as `planCount`, so it MUST equal `buildSuiteRunPlans(...).length`
 * for every suite shape. A count that silently lags a new fan-out axis would
 * understate every estimate — exactly the "confidently low number" this feature
 * must never display.
 */

const hostAttachment = (namedHostId: string, servers: string[]) => ({
  namedHostId,
  enabledOptionalServerIds: [],
  hostName: `host-${namedHostId}`,
  resolvedServerNames: servers,
});

/**
 * Each shape pins its ABSOLUTE expected width as well as parity. Parity alone is
 * near-tautological while `countSuiteRunPlans` delegates to
 * `buildSuiteRunPlans(...).length` — it catches a future divergence between the
 * two, but not a shared fan-out bug inside `buildSuiteRunPlans` that would move
 * both numbers together and quietly change every estimate.
 */
const shapes: Array<{
  name: string;
  suite: Parameters<typeof buildSuiteRunPlans>[0];
  environments?: Parameters<typeof buildSuiteRunPlans>[1];
  fallbackServerIds?: string[];
  expected: number;
}> = [
  {
    name: "environment axis (wins over hosts)",
    expected: 3,
    suite: {
      environment: { servers: ["flat-1"] },
      hostAttachments: [hostAttachment("h1", ["srv-a"])],
      environmentIds: ["env-1", "env-2", "env-3"],
    },
    environments: [
      { environmentId: "env-1", name: "Alpha" },
      { environmentId: "env-2", name: "Beta" },
    ],
    fallbackServerIds: ["flat-1"],
  },
  {
    name: "environment axis with no environments list supplied",
    expected: 1,
    suite: { environmentIds: ["env-x"] },
  },
  {
    name: "host axis (multiple attachments)",
    expected: 2,
    suite: {
      environment: { servers: ["flat-1"] },
      hostAttachments: [
        hostAttachment("h1", ["srv-a"]),
        hostAttachment("h2", ["srv-b"]),
      ],
    },
    fallbackServerIds: ["flat-1"],
  },
  {
    name: "host axis (single attachment)",
    expected: 1,
    suite: { hostAttachments: [hostAttachment("h1", ["srv-a"])] },
  },
  {
    name: "flat default plan (no environments, no attachments)",
    expected: 1,
    suite: { environment: { servers: ["flat-1", "flat-2"] } },
    fallbackServerIds: ["flat-1", "flat-2"],
  },
  {
    name: "empty suite (still one default plan)",
    expected: 1,
    suite: {},
  },
  {
    name: "client × model cells already attached as environment ids",
    expected: 4,
    suite: {
      environmentIds: ["env-h1", "env-h1-gemini", "env-h2", "env-h2-gemini"],
    },
  },
  {
    name: "empty environmentIds array falls back to the host axis",
    expected: 2,
    suite: {
      environmentIds: [],
      hostAttachments: [
        hostAttachment("h1", ["srv-a"]),
        hostAttachment("h2", ["srv-b"]),
      ],
    },
  },
];

describe("countSuiteRunPlans", () => {
  for (const shape of shapes) {
    it(`matches buildSuiteRunPlans().length — ${shape.name}`, () => {
      expect(
        countSuiteRunPlans(
          shape.suite,
          shape.environments,
          shape.fallbackServerIds,
        ),
      ).toBe(
        buildSuiteRunPlans(
          shape.suite,
          shape.environments,
          shape.fallbackServerIds,
        ).length,
      );
      // ...and pin the absolute width, so a shared fan-out change in
      // `buildSuiteRunPlans` can't move both sides together unnoticed.
      expect(
        countSuiteRunPlans(
          shape.suite,
          shape.environments,
          shape.fallbackServerIds,
        ),
      ).toBe(shape.expected);
    });
  }

  it("never returns zero — a suite always launches at least one plan", () => {
    for (const shape of shapes) {
      expect(
        countSuiteRunPlans(
          shape.suite,
          shape.environments,
          shape.fallbackServerIds,
        ),
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it("counts environments without needing the environments list", () => {
    // The estimate only needs the COUNT, and the environments list contributes
    // display names only — so a caller that has not loaded it still sends the
    // right fan-out width.
    expect(countSuiteRunPlans({ environmentIds: ["a", "b", "c"] })).toBe(3);
  });
});
