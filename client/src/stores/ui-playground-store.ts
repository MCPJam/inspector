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
export type DisplayMode = "inline" | "pip" | "fullscreen";

export interface UserLocation {
  country: string;
  region: string;
  city: string;
  timezone: string;
}

export interface PlaygroundGlobals {
  theme: "light" | "dark";
  locale: string;
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
  isInspectorVisible: boolean;

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
  toggleInspector: () => void;
  setSidebarVisible: (visible: boolean) => void;
  setInspectorVisible: (visible: boolean) => void;
  setPlaygroundActive: (active: boolean) => void;
  reset: () => void;
}

const getInitialGlobals = (): PlaygroundGlobals => ({
  theme: "dark",
  locale: navigator.language || "en-US",
  deviceType: "desktop",
  displayMode: "inline",
  userLocation: null,
});

const STORAGE_KEY_SIDEBAR = "mcpjam-ui-playground-sidebar-visible";
const STORAGE_KEY_INSPECTOR = "mcpjam-ui-playground-inspector-visible";

const getStoredVisibility = (key: string, defaultValue: boolean): boolean => {
  if (typeof window === "undefined") return defaultValue;
  const stored = localStorage.getItem(key);
  return stored === null ? defaultValue : stored === "true";
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
  isInspectorVisible: getStoredVisibility(STORAGE_KEY_INSPECTOR, true),
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

  toggleInspector: () =>
    set((state) => {
      const newValue = !state.isInspectorVisible;
      localStorage.setItem(STORAGE_KEY_INSPECTOR, String(newValue));
      return { isInspectorVisible: newValue };
    }),

  setSidebarVisible: (visible) => {
    localStorage.setItem(STORAGE_KEY_SIDEBAR, String(visible));
    set({ isSidebarVisible: visible });
  },

  setInspectorVisible: (visible) => {
    localStorage.setItem(STORAGE_KEY_INSPECTOR, String(visible));
    set({ isInspectorVisible: visible });
  },

  setPlaygroundActive: (active) => set({ isPlaygroundActive: active }),

  reset: () =>
    set((state) => ({
      ...initialState,
      // Preserve panel visibility on reset
      isSidebarVisible: getStoredVisibility(STORAGE_KEY_SIDEBAR, true),
      isInspectorVisible: getStoredVisibility(STORAGE_KEY_INSPECTOR, true),
      // Preserve playground active state (controlled by PlaygroundMain mount/unmount)
      isPlaygroundActive: state.isPlaygroundActive,
    })),
}));
