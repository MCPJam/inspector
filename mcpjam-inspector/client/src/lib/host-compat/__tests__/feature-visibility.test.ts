import { describe, expect, it } from "vitest";
import {
  FLAG_GATED_HOST_IDS,
  excludedFlagGatedHostIds,
  filterHostsByFeatureFlags,
  filterProfilesByFeatureFlags,
  filterReportsByFeatureFlags,
  hostFeatureFlagState,
  isHostVisibleByFeatureFlags,
  type HostFeatureVisibility,
} from "../feature-visibility";

/**
 * This module is the ONLY thing standing between an unlaunched host and every
 * user, on six surfaces at once. Two failure directions matter and they are not
 * symmetric: showing a gated host to someone outside the launch audience is a
 * leak, while hiding an ungated host makes a shipped product vanish.
 */
const ALL_ON: HostFeatureVisibility = {
  claudeCode: true,
  codex: true,
  cursorCli: true,
};
const ALL_OFF: HostFeatureVisibility = {
  claudeCode: false,
  codex: false,
  cursorCli: false,
};

describe("which hosts are gated at all", () => {
  it("gates the Cursor CLI host and NOT the emulated cursor template", () => {
    // The trap this file is worth the most for. `cursor` is the IDE chat-panel
    // host style, ungated and shipped for months; `cursor-cli` is the new
    // runtime. A gate keyed on the wrong id either leaks the new host or
    // deletes the old one from every picker.
    expect(FLAG_GATED_HOST_IDS.has("cursor-cli")).toBe(true);
    expect(FLAG_GATED_HOST_IDS.has("cursor")).toBe(false);
  });

  it("leaves an ungated host visible no matter what the flags say", () => {
    for (const hostId of ["cursor", "vscode", "windsurf", "anything-else"]) {
      expect(isHostVisibleByFeatureFlags(hostId, ALL_OFF), hostId).toBe(true);
      expect(
        hostFeatureFlagState(hostId, {
          claudeCode: undefined,
          codex: undefined,
          cursorCli: undefined,
        }),
        hostId,
      ).toBe(true);
    }
  });
});

describe("cursor-cli visibility", () => {
  it("is hidden when the flag is off", () => {
    expect(isHostVisibleByFeatureFlags("cursor-cli", ALL_OFF)).toBe(false);
    expect(
      isHostVisibleByFeatureFlags("cursor-cli", {
        ...ALL_ON,
        cursorCli: false,
      }),
    ).toBe(false);
  });

  it("is shown only when its OWN flag is on", () => {
    // Not "any harness flag": a user in the Claude Code audience is not
    // thereby in the Cursor audience.
    expect(
      isHostVisibleByFeatureFlags("cursor-cli", {
        ...ALL_OFF,
        cursorCli: true,
      }),
    ).toBe(true);
    expect(
      isHostVisibleByFeatureFlags("cursor-cli", {
        claudeCode: true,
        codex: true,
        cursorCli: false,
      }),
    ).toBe(false);
  });

  it("reads UNRESOLVED as unresolved, never as visible", () => {
    // The tri-state exists so a deep link can wait rather than guess. The
    // boolean gate must treat "still loading" as not-yet-visible: guessing
    // `true` for the few hundred milliseconds before PostHog answers would show
    // the host to everyone.
    const loading = {
      claudeCode: undefined,
      codex: undefined,
      cursorCli: undefined,
    };
    expect(hostFeatureFlagState("cursor-cli", loading)).toBeUndefined();
    expect(
      isHostVisibleByFeatureFlags(
        "cursor-cli",
        loading as HostFeatureVisibility,
      ),
    ).toBe(false);
  });
});

describe("every surface reads the same map", () => {
  // The regression the module was extracted for: the exclusion set used to be
  // hand-typed per host in one view, so a newly gated host was gated on five
  // surfaces and offered on the sixth.
  const hosts = [
    { id: "cursor-cli" },
    { id: "cursor" },
    { id: "claude-code" },
    { id: "codex" },
  ];

  it("hides Claude Code and Codex from gated pickers when flags are off", () => {
    expect(
      filterHostsByFeatureFlags(hosts, ALL_OFF).map((host) => host.id)
    ).toEqual(["cursor"]);
  });

  it("hides cursor-cli from the host picker, the reports, and the profiles alike", () => {
    const visibility = { ...ALL_ON, cursorCli: false };
    expect(
      filterHostsByFeatureFlags(hosts, visibility).map((h) => h.id),
    ).toEqual(["cursor", "claude-code", "codex"]);
    expect(
      filterProfilesByFeatureFlags(hosts, visibility).map((h) => h.id),
    ).toEqual(["cursor", "claude-code", "codex"]);
    expect(
      filterReportsByFeatureFlags(
        hosts.map((h) => ({ hostId: h.id })),
        visibility,
      ).map((r) => r.hostId),
    ).toEqual(["cursor", "claude-code", "codex"]);
  });

  it("derives the exclusion set from the same map, for every combination", () => {
    expect(excludedFlagGatedHostIds(ALL_ON)).toEqual(new Set());
    expect(excludedFlagGatedHostIds(ALL_OFF)).toEqual(
      new Set(FLAG_GATED_HOST_IDS),
    );
    expect(excludedFlagGatedHostIds({ ...ALL_ON, cursorCli: false })).toEqual(
      new Set(["cursor-cli"]),
    );
  });

  it("keeps the exclusion set and the filters agreeing", () => {
    // Two ways of asking the same question, on six surfaces between them. If
    // they ever disagree, one surface shows what another hides.
    for (const visibility of [
      ALL_ON,
      ALL_OFF,
      { ...ALL_ON, cursorCli: false },
      { ...ALL_OFF, cursorCli: true },
    ]) {
      const excluded = excludedFlagGatedHostIds(visibility);
      const shown = new Set(
        filterHostsByFeatureFlags(hosts, visibility).map((h) => h.id),
      );
      for (const id of FLAG_GATED_HOST_IDS) {
        expect(excluded.has(id), `${id} in ${JSON.stringify(visibility)}`).toBe(
          !shown.has(id),
        );
      }
    }
  });
});
