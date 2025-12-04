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

export interface CspConfig {
  connectDomains: string[];
  resourceDomains: string[];
}

export interface CspViolation {
  timestamp: number;
  directive: string;
  blockedUri: string;
  sourceFile?: string;
  lineNumber?: number;
}

export interface FollowUpMessage {
  id: string;
  text: string;
  timestamp: number;
}

interface UIPlaygroundState {
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

  // CSP (read-only, from server response)
  csp: CspConfig | null;
  cspViolations: CspViolation[];

  // Emulation
  deviceType: DeviceType;
  displayMode: DisplayMode;
  globals: PlaygroundGlobals;

  // Tool call tracking
  lastToolCallId: string | null;

  // Follow-up messages from widget
  followUpMessages: FollowUpMessage[];

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
    value: PlaygroundGlobals[K]
  ) => void;
  setCsp: (csp: CspConfig | null) => void;
  addCspViolation: (violation: Omit<CspViolation, "timestamp">) => void;
  clearCspViolations: () => void;
  setLastToolCallId: (id: string | null) => void;
  addFollowUpMessage: (text: string) => void;
  clearFollowUpMessages: () => void;
  reset: () => void;
}

const getInitialGlobals = (): PlaygroundGlobals => ({
  theme: "dark",
  locale: navigator.language || "en-US",
  deviceType: "desktop",
  displayMode: "inline",
  userLocation: null,
});

const initialState = {
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
  csp: null,
  cspViolations: [],
  deviceType: "desktop" as DeviceType,
  displayMode: "inline" as DisplayMode,
  globals: getInitialGlobals(),
  lastToolCallId: null,
  followUpMessages: [] as FollowUpMessage[],
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
      csp: null,
      cspViolations: [],
    }),

  setFormFields: (formFields) => set({ formFields }),

  updateFormField: (name, value) =>
    set((state) => ({
      formFields: state.formFields.map((field) =>
        field.name === name ? { ...field, value } : field
      ),
    })),

  updateFormFieldIsSet: (name, isSet) =>
    set((state) => ({
      formFields: state.formFields.map((field) =>
        field.name === name ? { ...field, isSet } : field
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

  setCsp: (csp) => set({ csp }),

  addCspViolation: (violation) =>
    set((state) => ({
      cspViolations: [
        { ...violation, timestamp: Date.now() },
        ...state.cspViolations,
      ].slice(0, 100), // Keep max 100 violations
    })),

  clearCspViolations: () => set({ cspViolations: [] }),

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

  reset: () => set(initialState),
}));
