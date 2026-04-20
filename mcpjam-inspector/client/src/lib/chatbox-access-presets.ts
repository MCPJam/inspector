import type { ChatboxMode } from "@/hooks/useChatboxes";

/** UI preset for chatbox access (maps to `mode` + `allowGuestAccess`). */
export type ChatboxAccessPreset =
  | "workspace"
  | "invited_only"
  | "link_guests";

export function chatboxAccessPresetFromSettings(
  mode: ChatboxMode,
  allowGuestAccess: boolean,
): ChatboxAccessPreset {
  if (mode === "invited_only") {
    return "invited_only";
  }
  return allowGuestAccess ? "link_guests" : "workspace";
}

export function settingsFromChatboxAccessPreset(
  preset: ChatboxAccessPreset,
): { mode: ChatboxMode; allowGuestAccess: boolean } {
  switch (preset) {
    case "workspace":
      return { mode: "any_signed_in_with_link", allowGuestAccess: false };
    case "link_guests":
      return { mode: "any_signed_in_with_link", allowGuestAccess: true };
    case "invited_only":
      return { mode: "invited_only", allowGuestAccess: false };
  }
}
