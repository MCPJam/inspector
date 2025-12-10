/**
 * UI Playground Store
 *
 * Zustand store for managing the UI Playground tab state.
 * This includes tool selection, form fields, execution state,
 * device emulation settings, and globals configuration.
 */

import { create } from "zustand";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { FormField } from "@/lib/tool-form";

export type DeviceType = "mobile" | "tablet" | "desktop";

/** Device viewport configurations - shared across playground and MCP apps renderer */
export const DEVICE_VIEWPORT_CONFIGS: Record<
  DeviceType,
  { width: number; height: number }
> = {
  mobile: { width: 430, height: 932 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1280, height: 800 },
};
export type DisplayMode = "inline" | "pip" | "fullscreen";
export type CspMode = "permissive" | "widget-declared";
export type AppProtocol = "openai-apps" | "mcp-apps" | null;

export interface DeviceCapabilities {
  hover: boolean;
  touch: boolean;
}

export interface SafeAreaInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export type SafeAreaPreset =
  | "none"
  | "iphone-notch"
  | "iphone-dynamic-island"
  | "android-gesture"
  | "custom";

/** Preset safe area configurations for common devices */
export const SAFE_AREA_PRESETS: Record<
  Exclude<SafeAreaPreset, "custom">,
  SafeAreaInsets
> = {
  none: { top: 0, bottom: 0, left: 0, right: 0 },
  "iphone-notch": { top: 44, bottom: 34, left: 0, right: 0 },
  "iphone-dynamic-island": { top: 59, bottom: 34, left: 0, right: 0 },
  "android-gesture": { top: 24, bottom: 16, left: 0, right: 0 },
};

export interface UserLocation {
  country: string;
  region: string;
  city: string;
  timezone: string;
}

export interface PlaygroundGlobals {
  theme: "light" | "dark";
  locale: string;
  timeZone: string; // IANA timezone (e.g., "America/New_York") per SEP-1865
  deviceType: DeviceType;
  displayMode: DisplayMode;
  userLocation: UserLocation | null;
}

export interface FollowUpMessage {
  id: string;
  text: string;
  timestamp: number;
}

interface UIPlaygroundState {
  // Active flag - true when UI Playground is mounted
  isPlaygroundActive: boolean;

  // Tool selection
  selectedTool: string | null;
  tools: Record<string, Tool>;
  formFields: FormField[];

  // Execution
  isExecuting: boolean;
  toolOutput: unknown;
  toolResponseMetadata: Record<string, unknown> | null;
  executionError: string | null;

  // Widget
  widgetUrl: string | null;
  widgetState: unknown;
  isWidgetTool: boolean;

  // Emulation
  deviceType: DeviceType;
  displayMode: DisplayMode;
  globals: PlaygroundGlobals;

  // Tool call tracking
  lastToolCallId: string | null;

  // Follow-up messages from widget
  followUpMessages: FollowUpMessage[];

  // Panel visibility
  isSidebarVisible: boolean;

  // CSP enforcement mode for widget sandbox (ChatGPT Apps)
  cspMode: CspMode;

  // CSP enforcement mode for MCP Apps (SEP-1865)
  mcpAppsCspMode: CspMode;

  // Currently selected app protocol (detected from tool metadata)
  selectedProtocol: AppProtocol;

  // Device capabilities (hover/touch support)
  capabilities: DeviceCapabilities;

  // Safe area insets (for device notches, rounded corners, etc.)
  safeAreaPreset: SafeAreaPreset;
  safeAreaInsets: SafeAreaInsets;

  // Actions
  setTools: (tools: Record<string, Tool>) => void;
  setSelectedTool: (tool: string | null) => void;
  setFormFields: (fields: FormField[]) => void;
  updateFormField: (name: string, value: unknown) => void;
  updateFormFieldIsSet: (name: string, isSet: boolean) => void;
  setIsExecuting: (executing: boolean) => void;
  setToolOutput: (output: unknown) => void;
  setToolResponseMetadata: (meta: Record<string, unknown> | null) => void;
  setExecutionError: (error: string | null) => void;
  setWidgetUrl: (url: string | null) => void;
  setWidgetState: (state: unknown) => void;
  setIsWidgetTool: (isWidget: boolean) => void;
  setDeviceType: (type: DeviceType) => void;
  setDisplayMode: (mode: DisplayMode) => void;
  updateGlobal: <K extends keyof PlaygroundGlobals>(
    key: K,
    value: PlaygroundGlobals[K],
  ) => void;
  setLastToolCallId: (id: string | null) => void;
  addFollowUpMessage: (text: string) => void;
  clearFollowUpMessages: () => void;
  toggleSidebar: () => void;
  setSidebarVisible: (visible: boolean) => void;
  setPlaygroundActive: (active: boolean) => void;
  setCspMode: (mode: CspMode) => void;
  setMcpAppsCspMode: (mode: CspMode) => void;
  setSelectedProtocol: (protocol: AppProtocol) => void;
  setCapabilities: (capabilities: Partial<DeviceCapabilities>) => void;
  setSafeAreaPreset: (preset: SafeAreaPreset) => void;
  setSafeAreaInsets: (insets: Partial<SafeAreaInsets>) => void;
  reset: () => void;
}

const getInitialGlobals = (): PlaygroundGlobals => ({
  theme: "dark",
  locale: navigator.language || "en-US",
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  deviceType: "desktop",
  displayMode: "inline",
  userLocation: null,
});

const STORAGE_KEY_SIDEBAR = "mcpjam-ui-playground-sidebar-visible";

const getStoredVisibility = (key: string, defaultValue: boolean): boolean => {
  if (typeof window === "undefined") return defaultValue;
  const stored = localStorage.getItem(key);
  return stored === null ? defaultValue : stored === "true";
};

/** Get default capabilities based on device type */
const getDefaultCapabilities = (
  deviceType: DeviceType = "desktop",
): DeviceCapabilities => {
  switch (deviceType) {
    case "mobile":
      return { hover: false, touch: true };
    case "tablet":
      return { hover: false, touch: true };
    case "desktop":
    default:
      return { hover: true, touch: false };
  }
};

const initialState = {
  isPlaygroundActive: false,
  selectedTool: null,
  tools: {},
  formFields: [],
  isExecuting: false,
  toolOutput: null,
  toolResponseMetadata: null,
  executionError: null,
  widgetUrl: null,
  widgetState: null,
  isWidgetTool: false,
  deviceType: "desktop" as DeviceType,
  displayMode: "inline" as DisplayMode,
  globals: getInitialGlobals(),
  lastToolCallId: null,
  followUpMessages: [] as FollowUpMessage[],
  isSidebarVisible: getStoredVisibility(STORAGE_KEY_SIDEBAR, true),
  cspMode: "permissive" as CspMode,
  mcpAppsCspMode: "permissive" as CspMode,
  selectedProtocol: null as AppProtocol,
  capabilities: getDefaultCapabilities("desktop"),
  safeAreaPreset: "none" as SafeAreaPreset,
  safeAreaInsets: SAFE_AREA_PRESETS["none"],
};

export const useUIPlaygroundStore = create<UIPlaygroundState>((set) => ({
  ...initialState,

  setTools: (tools) => set({ tools }),

  setSelectedTool: (selectedTool) =>
    set({
      selectedTool,
      toolOutput: null,
      toolResponseMetadata: null,
      executionError: null,
      widgetUrl: null,
      widgetState: null,
      isWidgetTool: false,
      selectedProtocol: null, // Reset protocol on tool change, will be set by UIPlaygroundTab
    }),

  setFormFields: (formFields) => set({ formFields }),

  updateFormField: (name, value) =>
    set((state) => ({
      formFields: state.formFields.map((field) =>
        field.name === name ? { ...field, value } : field,
      ),
    })),

  updateFormFieldIsSet: (name, isSet) =>
    set((state) => ({
      formFields: state.formFields.map((field) =>
        field.name === name ? { ...field, isSet } : field,
      ),
    })),

  setIsExecuting: (isExecuting) => set({ isExecuting }),

  setToolOutput: (toolOutput) => set({ toolOutput }),

  setToolResponseMetadata: (toolResponseMetadata) =>
    set({ toolResponseMetadata }),

  setExecutionError: (executionError) => set({ executionError }),

  setWidgetUrl: (widgetUrl) => set({ widgetUrl }),

  setWidgetState: (widgetState) => set({ widgetState }),

  setIsWidgetTool: (isWidgetTool) => set({ isWidgetTool }),

  setDeviceType: (deviceType) =>
    set((state) => ({
      deviceType,
      globals: { ...state.globals, deviceType },
      // Auto-update capabilities based on device type
      capabilities: getDefaultCapabilities(deviceType),
    })),

  setDisplayMode: (displayMode) =>
    set((state) => ({
      displayMode,
      globals: { ...state.globals, displayMode },
    })),

  updateGlobal: (key, value) =>
    set((state) => ({
      globals: { ...state.globals, [key]: value },
      // Sync top-level state for deviceType and displayMode
      ...(key === "deviceType" ? { deviceType: value as DeviceType } : {}),
      ...(key === "displayMode" ? { displayMode: value as DisplayMode } : {}),
    })),

  setLastToolCallId: (lastToolCallId) => set({ lastToolCallId }),

  addFollowUpMessage: (text) =>
    set((state) => ({
      followUpMessages: [
        ...state.followUpMessages,
        {
          id: `followup-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          text,
          timestamp: Date.now(),
        },
      ],
    })),

  clearFollowUpMessages: () => set({ followUpMessages: [] }),

  toggleSidebar: () =>
    set((state) => {
      const newValue = !state.isSidebarVisible;
      localStorage.setItem(STORAGE_KEY_SIDEBAR, String(newValue));
      return { isSidebarVisible: newValue };
    }),

  setSidebarVisible: (visible) => {
    localStorage.setItem(STORAGE_KEY_SIDEBAR, String(visible));
    set({ isSidebarVisible: visible });
  },

  setPlaygroundActive: (active) => set({ isPlaygroundActive: active }),

  setCspMode: (mode) => set({ cspMode: mode }),

  setMcpAppsCspMode: (mode) => set({ mcpAppsCspMode: mode }),

  setSelectedProtocol: (protocol) => set({ selectedProtocol: protocol }),

  setCapabilities: (newCapabilities) =>
    set((state) => ({
      capabilities: { ...state.capabilities, ...newCapabilities },
    })),

  setSafeAreaPreset: (preset) =>
    set((state) => ({
      safeAreaPreset: preset,
      safeAreaInsets:
        preset === "custom"
          ? state.safeAreaInsets // Keep current insets when switching to custom
          : SAFE_AREA_PRESETS[preset],
    })),

  setSafeAreaInsets: (insets) =>
    set((state) => ({
      safeAreaPreset: "custom" as SafeAreaPreset,
      safeAreaInsets: { ...state.safeAreaInsets, ...insets },
    })),

  reset: () =>
    set((state) => ({
      ...initialState,
      // Preserve panel visibility on reset
      isSidebarVisible: getStoredVisibility(STORAGE_KEY_SIDEBAR, true),
      // Preserve playground active state (controlled by PlaygroundMain mount/unmount)
      isPlaygroundActive: state.isPlaygroundActive,
    })),
}));
