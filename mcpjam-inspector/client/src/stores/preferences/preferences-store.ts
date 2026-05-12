import { createStore } from "zustand/vanilla";

import {
  normalizeChatboxHostStyleId,
  type ChatboxHostStyle,
} from "@/lib/chatbox-host-style";
import { DEFAULT_HOST_STYLE } from "@/lib/host-styles";
import type { HostConfigMcpProfileV1 } from "@/lib/host-config-v2";
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
   * Direct-Chat scoped MCP profile envelope (clientInfo, supported
   * protocol versions, MCP Apps sandbox policy). Undefined means "use
   * SDK defaults / no host-level sandbox override" — matches the
   * backend's tri-state contract (undefined / empty-envelope /
   * fully-populated all hash distinctly).
   *
   * Chatbox / eval-suite / project-default flows persist their own
   * profiles on the v2 hostConfig row; this is the Direct Chat
   * working-bench's analog so a tweaked profile survives reloads.
   */
  mcpProfile: HostConfigMcpProfileV1 | undefined;
  setThemeMode: (mode: ThemeMode) => void;
  setThemePreset: (preset: ThemePreset) => void;
  setHostStyle: (hostStyle: ChatboxHostStyle) => void;
  setHostCapabilitiesOverride: (
    next: Record<string, unknown> | undefined,
  ) => void;
  setMcpProfile: (next: HostConfigMcpProfileV1 | undefined) => void;
};

export const THEME_MODE_KEY = "themeMode";
export const THEME_PRESET_KEY = "themePreset";
export const HOST_STYLE_KEY = "mcpjam-ui-playground-host-style";
export const HOST_CAPABILITIES_OVERRIDE_KEY =
  "mcpjam-ui-playground-host-capabilities-override";
export const MCP_PROFILE_KEY = "mcpjam-ui-playground-mcp-profile";

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

function getStoredMcpProfile(): HostConfigMcpProfileV1 | undefined {
  if (typeof window === "undefined") return undefined;
  let raw: string | null;
  try {
    raw = localStorage.getItem(MCP_PROFILE_KEY);
  } catch (error) {
    console.warn("Failed to read persisted MCP profile:", error);
    return undefined;
  }
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    // Guard against the same "future profileVersion" trap the backend
    // canonicalizer guards: a corrupted or future-version envelope
    // must not be silently re-used as if it were v1.
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed as { profileVersion?: unknown }).profileVersion === 1
    ) {
      return parsed as HostConfigMcpProfileV1;
    }
    return undefined;
  } catch (error) {
    console.warn("Failed to parse persisted MCP profile:", error);
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
    mcpProfile:
      init?.mcpProfile !== undefined
        ? init.mcpProfile
        : getStoredMcpProfile(),
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
    setMcpProfile: (next) => {
      try {
        if (next === undefined) {
          // Same rationale as setHostCapabilitiesOverride: clear the
          // storage entry so a future getStoredMcpProfile resolves to
          // undefined too. Keeping `{ profileVersion: 1 }` stored
          // would re-hydrate as "user opted in" on the next reload —
          // a distinct backend hash from "use SDK defaults."
          localStorage.removeItem(MCP_PROFILE_KEY);
        } else {
          localStorage.setItem(MCP_PROFILE_KEY, JSON.stringify(next));
        }
      } catch (error) {
        console.warn("Failed to persist MCP profile:", error);
      }
      set({ mcpProfile: next });
    },
  }));
