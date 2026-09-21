/**
 * The rule that decides which scenario rows are SCENARIOS.
 *
 * The bug it exists for: `hosts.createHost` mints a scenario per client, and an
 * empty project gets four of them before anyone opens User Testing (three
 * seeded by the Playground, one by the host bar). The surface listed all of
 * them, so a brand-new project showed scenarios nobody made.
 */
import { describe, expect, it } from "vitest";
import type { ScenarioListItem } from "@/hooks/useScenarios";
import { isDeliberateScenario } from "@/lib/user-testing-scenarios";

const row = (over: Partial<ScenarioListItem> = {}): ScenarioListItem => ({
  scenarioId: "cb-1",
  projectId: "p1",
  name: "Claude Code",
  hostStyle: "claude",
  // What every auto-mint path produces: the backend default.
  mode: "project_members",
  allowGuestAccess: false,
  serverCount: 0,
  serverNames: [],
  namedHostId: "host-1",
  namedHostName: "Claude Code",
  createdAt: 1,
  updatedAt: 2,
  ...over,
});

describe("isDeliberateScenario", () => {
  it("hides an untouched auto-minted client row", () => {
    // The exact shape of a Playground- or host-bar-seeded client.
    expect(isDeliberateScenario(row())).toBe(false);
  });

  it("keeps every environment-backed row", () => {
    // These exist ONLY because someone published an environment.
    expect(isDeliberateScenario(row({ environmentId: "env-1" }))).toBe(true);
  });

  it("keeps a row whose access was deliberately changed", () => {
    expect(isDeliberateScenario(row({ mode: "invited_only" }))).toBe(true);
    expect(isDeliberateScenario(row({ mode: "anyone_with_link" }))).toBe(true);
  });

  it("keeps a legacy row that real testers actually used", () => {
    expect(isDeliberateScenario(row({ uniqueTesterCount: 2 }))).toBe(true);
    expect(isDeliberateScenario(row({ sessionCount: 1 }))).toBe(true);
    expect(isDeliberateScenario(row({ lastSessionAt: 1700000000000 }))).toBe(
      true,
    );
  });

  it("treats absent counters as no evidence, not as zero evidence", () => {
    // A deployment predating the counters omits them. Absence must not be read
    // as "used" — that would put every seeded client back in the list.
    expect(
      isDeliberateScenario(
        row({
          uniqueTesterCount: undefined,
          sessionCount: undefined,
          lastSessionAt: undefined,
        }),
      ),
    ).toBe(false);
    // ...and an explicit zero is not evidence either.
    expect(
      isDeliberateScenario(
        row({ uniqueTesterCount: 0, sessionCount: 0, lastSessionAt: null }),
      ),
    ).toBe(false);
  });

  it("keeps an environment-backed row even when it is unresolvable", () => {
    // Its share link is minted; the owner has to see it to retire it.
    expect(
      isDeliberateScenario(
        row({
          environmentId: "env-1",
          environmentError: { code: "ENV_ARCHIVED", message: "archived" },
        }),
      ),
    ).toBe(true);
  });
});
