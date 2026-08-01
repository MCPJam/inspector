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

const shapes: Array<{
  name: string;
  suite: Parameters<typeof buildSuiteRunPlans>[0];
  environments?: Parameters<typeof buildSuiteRunPlans>[1];
  fallbackServerIds?: string[];
}> = [
  {
    name: "environment axis (wins over hosts)",
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
    suite: { environmentIds: ["env-x"] },
  },
  {
    name: "host axis (multiple attachments)",
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
    suite: { hostAttachments: [hostAttachment("h1", ["srv-a"])] },
  },
  {
    name: "flat default plan (no environments, no attachments)",
    suite: { environment: { servers: ["flat-1", "flat-2"] } },
    fallbackServerIds: ["flat-1", "flat-2"],
  },
  {
    name: "empty suite (still one default plan)",
    suite: {},
  },
  {
    name: "empty environmentIds array falls back to the host axis",
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
