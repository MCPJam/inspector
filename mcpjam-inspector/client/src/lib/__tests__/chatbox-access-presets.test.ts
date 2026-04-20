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

  it("maps link mode without guests to workspace preset", () => {
    expect(
      chatboxAccessPresetFromSettings("any_signed_in_with_link", false),
    ).toBe("workspace");
  });

  it("maps link mode with guests to link_guests preset", () => {
    expect(
      chatboxAccessPresetFromSettings("any_signed_in_with_link", true),
    ).toBe("link_guests");
  });
});

describe("settingsFromChatboxAccessPreset", () => {
  it("round-trips with fromSettings for normal cases", () => {
    const presets = ["workspace", "invited_only", "link_guests"] as const;
    for (const preset of presets) {
      const s = settingsFromChatboxAccessPreset(preset);
      expect(chatboxAccessPresetFromSettings(s.mode, s.allowGuestAccess)).toBe(
        preset,
      );
    }
  });
});
