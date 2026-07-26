import { describe, expect, it } from "vitest";
import { buildSuiteRunPlans } from "../helpers";

const hostAttachment = (namedHostId: string, servers: string[]) => ({
  namedHostId,
  enabledOptionalServerIds: [],
  hostName: `host-${namedHostId}`,
  resolvedServerNames: servers,
});

describe("buildSuiteRunPlans", () => {
  it("replaces the host axis with the environment axis when environmentIds is set", () => {
    const plans = buildSuiteRunPlans(
      {
        environment: { servers: ["flat-1"] },
        hostAttachments: [hostAttachment("h1", ["srv-a"])],
        environmentIds: ["env-1", "env-2"],
      },
      [
        { environmentId: "env-2", name: "Beta" },
        { environmentId: "env-1", name: "Alpha" },
      ],
      ["flat-1"]
    );
    expect(plans).toHaveLength(2);
    expect(plans.map((p) => p.environmentId)).toEqual(["env-1", "env-2"]);
    expect(plans.map((p) => p.environmentName)).toEqual(["Alpha", "Beta"]);
    // Environment plans never carry host pointers.
    expect(plans.every((p) => p.namedHostId === undefined)).toBe(true);
  });

  it("preserves the suite's attach order, not the environments list order", () => {
    const plans = buildSuiteRunPlans({ environmentIds: ["env-b", "env-a"] }, [
      { environmentId: "env-a", name: "A" },
      { environmentId: "env-b", name: "B" },
    ]);
    expect(plans.map((p) => p.environmentId)).toEqual(["env-b", "env-a"]);
  });

  it("never guesses server ids for environment plans", () => {
    const plans = buildSuiteRunPlans(
      {
        environment: { servers: ["flat-1", "flat-2"] },
        serverAttachment: {
          _id: "sa-1",
          name: "group",
          serverIds: ["s1"],
          resolvedServerNames: ["srv-standalone"],
        },
        environmentIds: ["env-1"],
      },
      [{ environmentId: "env-1", name: "Solo" }],
      ["flat-1", "flat-2"]
    );
    expect(plans).toHaveLength(1);
    expect(plans[0].serverIds).toEqual([]);
  });

  it("carries an explicit environmentId even for a single-env suite", () => {
    const plans = buildSuiteRunPlans({ environmentIds: ["env-only"] }, []);
    expect(plans).toEqual([
      {
        namedHostId: undefined,
        hostName: null,
        serverIds: [],
        environmentId: "env-only",
        environmentName: "env-only",
      },
    ]);
  });

  it("falls back to id when the environment list has no matching name", () => {
    const plans = buildSuiteRunPlans({ environmentIds: ["env-x"] }, undefined);
    expect(plans[0].environmentName).toBe("env-x");
  });

  it("delegates to host plans when the suite has no environments", () => {
    const plans = buildSuiteRunPlans(
      {
        environment: { servers: ["flat-1"] },
        hostAttachments: [
          hostAttachment("h1", ["srv-a"]),
          hostAttachment("h2", ["srv-b"]),
        ],
      },
      [],
      ["flat-1"]
    );
    expect(plans).toHaveLength(2);
    expect(plans.map((p) => p.namedHostId)).toEqual(["h1", "h2"]);
    expect(plans[0].serverIds).toEqual(["srv-a"]);
    expect(plans.every((p) => p.environmentId === undefined)).toBe(true);
  });

  it("treats an empty environmentIds array as legacy (host/flat) fan-out", () => {
    const plans = buildSuiteRunPlans(
      { environment: { servers: ["flat-1"] }, environmentIds: [] },
      [],
      ["flat-1"]
    );
    expect(plans).toEqual([
      { namedHostId: undefined, hostName: null, serverIds: ["flat-1"] },
    ]);
  });
});
