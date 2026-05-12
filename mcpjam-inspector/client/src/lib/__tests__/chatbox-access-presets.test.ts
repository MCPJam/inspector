import { describe, expect, it } from "vitest";
import {
  chatboxAccessPresetFromSettings,
  settingsFromChatboxAccessPreset,
} from "../chatbox-access-presets";

describe("chatboxAccessPresetFromSettings", () => {
  it("maps invited-only mode regardless of legacy guest flag", () => {
    expect(
      chatboxAccessPresetFromSettings("invited_only", true),
    ).toBe("invited_only");
  });

  it("maps project_members mode to the project preset", () => {
    expect(
      chatboxAccessPresetFromSettings("project_members", false),
    ).toBe("project");
  });

  it("treats legacy anyone_with_link + guests-off rows as project", () => {
    // Back-compat: rows persisted before the project_members split
    // should still surface as the project preset in the UI.
    expect(
      chatboxAccessPresetFromSettings("anyone_with_link", false),
    ).toBe("project");
  });

  it("maps link mode with guests to link_guests preset", () => {
    expect(
      chatboxAccessPresetFromSettings("anyone_with_link", true),
    ).toBe("link_guests");
  });
});

describe("settingsFromChatboxAccessPreset", () => {
  it("project preset persists as project_members, not anyone_with_link", () => {
    expect(settingsFromChatboxAccessPreset("project")).toEqual({
      mode: "project_members",
      allowGuestAccess: false,
    });
  });

  it("link_guests preset persists as anyone_with_link with guests on", () => {
    expect(settingsFromChatboxAccessPreset("link_guests")).toEqual({
      mode: "anyone_with_link",
      allowGuestAccess: true,
    });
  });

  it("round-trips with fromSettings for normal cases", () => {
    const presets = ["project", "invited_only", "link_guests"] as const;
    for (const preset of presets) {
      const s = settingsFromChatboxAccessPreset(preset);
      expect(chatboxAccessPresetFromSettings(s.mode, s.allowGuestAccess)).toBe(
        preset,
      );
    }
  });
});
