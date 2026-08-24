import { describe, expect, it } from "vitest";
import {
  applyShareCeilingToScenarioOptions,
  clampScenarioAccessPreset,
  SCENARIO_ACCESS_OPTIONS,
  scenarioAccessPresetFromSettings,
  settingsFromScenarioAccessPreset,
  shareModeForScenarioPreset,
} from "../scenario-access-presets";

describe("scenarioAccessPresetFromSettings", () => {
  it("maps invited-only mode regardless of legacy guest flag", () => {
    expect(
      scenarioAccessPresetFromSettings("invited_only", true),
    ).toBe("invited_only");
  });

  it("maps project_members mode to the project preset", () => {
    expect(
      scenarioAccessPresetFromSettings("project_members", false),
    ).toBe("project");
  });

  it("treats legacy anyone_with_link + guests-off rows as project", () => {
    // Back-compat: rows persisted before the project_members split
    // should still surface as the project preset in the UI.
    expect(
      scenarioAccessPresetFromSettings("anyone_with_link", false),
    ).toBe("project");
  });

  it("maps link mode with guests to link_guests preset", () => {
    expect(
      scenarioAccessPresetFromSettings("anyone_with_link", true),
    ).toBe("link_guests");
  });
});

describe("settingsFromScenarioAccessPreset", () => {
  it("project preset persists as project_members, not anyone_with_link", () => {
    expect(settingsFromScenarioAccessPreset("project")).toEqual({
      mode: "project_members",
      allowGuestAccess: false,
    });
  });

  it("link_guests preset persists as anyone_with_link with guests on", () => {
    expect(settingsFromScenarioAccessPreset("link_guests")).toEqual({
      mode: "anyone_with_link",
      allowGuestAccess: true,
    });
  });

  it("translates presets onto the share-mode rank scale", () => {
    expect(shareModeForScenarioPreset("project")).toBe("project_members");
    expect(shareModeForScenarioPreset("invited_only")).toBe("invited_only");
    expect(shareModeForScenarioPreset("link_guests")).toBe("anyone_with_link");
  });

  it("round-trips with fromSettings for normal cases", () => {
    const presets = ["project", "invited_only", "link_guests"] as const;
    for (const preset of presets) {
      const s = settingsFromScenarioAccessPreset(preset);
      expect(scenarioAccessPresetFromSettings(s.mode, s.allowGuestAccess)).toBe(
        preset,
      );
    }
  });
});

describe("scenario access ceiling", () => {
  it("never disables the project preset", () => {
    const options = applyShareCeilingToScenarioOptions(
      SCENARIO_ACCESS_OPTIONS,
      "project_members",
    );
    expect(options.find((o) => o.value === "project")?.disabled).toBeUndefined();
    expect(options.find((o) => o.value === "invited_only")?.disabled).toBe(true);
    expect(options.find((o) => o.value === "link_guests")?.disabled).toBe(true);
  });

  it("treats an undefined ceiling as fully permissive", () => {
    const options = applyShareCeilingToScenarioOptions(SCENARIO_ACCESS_OPTIONS);
    expect(options.every((o) => !o.disabled)).toBe(true);
  });

  it("snaps an over-ceiling create-flow choice down", () => {
    expect(clampScenarioAccessPreset("link_guests", "invited_only")).toBe(
      "invited_only",
    );
    expect(clampScenarioAccessPreset("invited_only", "project_members")).toBe(
      "project",
    );
    expect(clampScenarioAccessPreset("invited_only")).toBe("invited_only");
  });
});
