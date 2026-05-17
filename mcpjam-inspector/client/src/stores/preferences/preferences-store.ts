import { createStore } from "zustand/vanilla";

import {
  normalizeChatboxHostStyleId,
  type ChatboxHostStyle,
} from "@/lib/chatbox-host-style";
import { DEFAULT_HOST_STYLE, type ChatUiOverride } from "@/lib/host-styles";
import type { ThemeMode, ThemePreset } from "@/types/preferences/theme";

export type PreferencesState = {
  themeMode: ThemeMode;
  themePreset: ThemePreset;
  hostStyle: ChatboxHostStyle;
  /**
   * Direct-Chat scoped MCP Apps `hostCapabilities` override. Undefined means
   * "use the active host style's preset" (advertised in ui/initialize).
   *
   * Direct Chat is the working bench where users iterate on capability
   * mocks while testing widgets; this field is the "save the bench" target
   * so a tweaked configuration survives reloads. Chatbox / eval-suite /
   * project-default flows persist their own overrides through the v2
   * HostConfig row instead.
   */
  hostCapabilitiesOverride: Record<string, unknown> | undefined;
  /**
   * Snapshot of the active host config's `chatUiOverride` (logo, palette,
   * indicator, fonts). Wired into `ChatboxChatUiOverrideProvider` so
   * playground / chat surfaces render with the host's customizations on
   * top of its host style preset. Undefined means "no override; preset
   * wins" — same semantics as `HostConfigInputV2.chatUiOverride`.
   */
  chatUiOverride: ChatUiOverride | undefined;
  /**
   * When true (default), entering the Servers tab, a host page, or the
   * Playground triggers a one-shot batch connect of all project servers.
   * The toggle in the Servers tab header writes here. Disabling it leaves
   * every server untouched until the user manually flips its per-card
   * connect switch.
   */
  autoConnectServersEnabled: boolean;
  setThemeMode: (mode: ThemeMode) => void;
  setThemePreset: (preset: ThemePreset) => void;
  setHostStyle: (hostStyle: ChatboxHostStyle) => void;
  setHostCapabilitiesOverride: (
    next: Record<string, unknown> | undefined,
  ) => void;
  setChatUiOverride: (next: ChatUiOverride | undefined) => void;
  setAutoConnectServersEnabled: (next: boolean) => void;
};

export const THEME_MODE_KEY = "themeMode";
export const THEME_PRESET_KEY = "themePreset";
export const HOST_STYLE_KEY = "mcpjam-ui-playground-host-style";
export const HOST_CAPABILITIES_OVERRIDE_KEY =
  "mcpjam-ui-playground-host-capabilities-override";
export const CHAT_UI_OVERRIDE_KEY = "mcpjam-ui-playground-chat-ui-override";
export const AUTO_CONNECT_SERVERS_KEY = "mcpjam-auto-connect-servers";

function getStoredHostStyle(): ChatboxHostStyle {
  if (typeof window === "undefined") return DEFAULT_HOST_STYLE.id;

  try {
    const stored = localStorage.getItem(HOST_STYLE_KEY);
    const normalized = normalizeChatboxHostStyleId(stored);
    if (normalized) {
      return normalized;
    }
  } catch (error) {
    console.warn("Failed to read persisted host style:", error);
  }

  return DEFAULT_HOST_STYLE.id;
}

function getStoredAutoConnectServersEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = localStorage.getItem(AUTO_CONNECT_SERVERS_KEY);
    if (raw === null) return true;
    return raw !== "false";
  } catch (error) {
    console.warn("Failed to read persisted auto-connect setting:", error);
    return true;
  }
}

function getStoredChatUiOverride(): ChatUiOverride | undefined {
  if (typeof window === "undefined") return undefined;
  let raw: string | null;
  try {
    raw = localStorage.getItem(CHAT_UI_OVERRIDE_KEY);
  } catch (error) {
    console.warn("Failed to read persisted chat UI override:", error);
    return undefined;
  }
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ChatUiOverride;
    }
    return undefined;
  } catch (error) {
    console.warn("Failed to parse persisted chat UI override:", error);
    return undefined;
  }
}

function getStoredHostCapabilitiesOverride():
  | Record<string, unknown>
  | undefined {
  if (typeof window === "undefined") return undefined;
  let raw: string | null;
  try {
    raw = localStorage.getItem(HOST_CAPABILITIES_OVERRIDE_KEY);
  } catch (error) {
    console.warn(
      "Failed to read persisted host capabilities override:",
      error,
    );
    return undefined;
  }
  if (!raw) return undefined;
  // Stored as JSON. Anything malformed is treated as "no override" rather
  // than throwing — we don't want a corrupt localStorage entry to brick
  // the chat tab. A failed parse silently falls back to the preset.
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch (error) {
    console.warn(
      "Failed to parse persisted host capabilities override:",
      error,
    );
    return undefined;
  }
}

export const createPreferencesStore = (init?: Partial<PreferencesState>) =>
  createStore<PreferencesState>()((set) => ({
    themeMode: init?.themeMode ?? "light",
    themePreset: init?.themePreset ?? "default",
    hostStyle: init?.hostStyle ?? getStoredHostStyle(),
    hostCapabilitiesOverride:
      init?.hostCapabilitiesOverride !== undefined
        ? init.hostCapabilitiesOverride
        : getStoredHostCapabilitiesOverride(),
    chatUiOverride:
      init?.chatUiOverride !== undefined
        ? init.chatUiOverride
        : getStoredChatUiOverride(),
    autoConnectServersEnabled:
      init?.autoConnectServersEnabled ?? getStoredAutoConnectServersEnabled(),
    setThemeMode: (mode) => {
      try {
        localStorage.setItem(THEME_MODE_KEY, mode);
      } catch (error) {
        console.warn("Failed to persist theme mode:", error);
      }
      set({ themeMode: mode });
    },
    setThemePreset: (preset) => {
      try {
        localStorage.setItem(THEME_PRESET_KEY, preset);
      } catch (error) {
        console.warn("Failed to persist theme preset:", error);
      }
      set({ themePreset: preset });
    },
    setHostStyle: (hostStyle) => {
      try {
        localStorage.setItem(HOST_STYLE_KEY, hostStyle);
      } catch (error) {
        console.warn("Failed to persist host style:", error);
      }
      set({ hostStyle });
    },
    setHostCapabilitiesOverride: (next) => {
      try {
        if (next === undefined) {
          // Treat undefined as "reset to host style preset". Remove the
          // localStorage entry so a future getStoredHostCapabilitiesOverride
          // returns undefined too — keeping an empty {} stored would be
          // semantically different ("advertise nothing") and trap the user
          // on the next reload.
          localStorage.removeItem(HOST_CAPABILITIES_OVERRIDE_KEY);
        } else {
          localStorage.setItem(
            HOST_CAPABILITIES_OVERRIDE_KEY,
            JSON.stringify(next),
          );
        }
      } catch (error) {
        console.warn(
          "Failed to persist host capabilities override:",
          error,
        );
      }
      set({ hostCapabilitiesOverride: next });
    },
    setChatUiOverride: (next) => {
      try {
        if (next === undefined) {
          localStorage.removeItem(CHAT_UI_OVERRIDE_KEY);
        } else {
          localStorage.setItem(CHAT_UI_OVERRIDE_KEY, JSON.stringify(next));
        }
      } catch (error) {
        console.warn("Failed to persist chat UI override:", error);
      }
      set({ chatUiOverride: next });
    },
    setAutoConnectServersEnabled: (next) => {
      try {
        localStorage.setItem(AUTO_CONNECT_SERVERS_KEY, next ? "true" : "false");
      } catch (error) {
        console.warn("Failed to persist auto-connect setting:", error);
      }
      set({ autoConnectServersEnabled: next });
    },
  }));
