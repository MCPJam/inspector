# UI Playground Tab - Design Document

## Overview

The **UI Playground** is a new tab specifically designed for testing ChatGPT Apps (OpenAI Apps SDK widgets). While the existing Tools Tab works well for text-based MCP servers, ChatGPT Apps return interactive UIs that require a different testing experience.

The UI Playground combines:
- **Determinism of Tools Tab**: Select tool, configure parameters, execute, inspect results
- **Playground aesthetics**: Visual widget rendering, device emulation, real-time state inspection

---

## Problem Statement

Current Tools Tab limitations for ChatGPT Apps:
1. Results panel shows raw JSON - not the actual widget UI
2. No way to emulate different device types (mobile/tablet/desktop)
3. No control over host-provided globals (theme, locale)
4. No visibility into widget state changes
5. Cannot test display mode transitions (inline → pip → fullscreen)
6. No way to observe postMessage communication in real-time

---

## UI Layout

```
+------------------+----------------------------------+----------------------+
|                  |                                  |                      |
|   Tools List     |                                  |   Tool Output        |
|   (scrollable)   |                                  |   - structuredContent|
|                  |                                  |   - _meta            |
|   [Search...]    |      PLAYGROUND EMULATION        |                      |
|                  |                                  +----------------------+
|   tool_1         |   +------------------------+     |                      |
|   tool_2  <--    |   |                        |     |   Widget State       |
|   tool_3         |   |    ChatGPT App         |     |   - current state    |
|   tool_4         |   |    Widget Render       |     |                      |
|                  |   |                        |     +----------------------+
+------------------+   |                        |     |                      |
|                  |   +------------------------+     |   Globals            |
|   Tool Params    |                                  |   - theme, locale    |
|                  |   [Mobile] [Tablet] [Desktop]    |   - displayMode      |
|   param1: [___]  |   [inline] [pip] [fullscreen]    +----------------------+
|   param2: [___]  |                                  |                      |
|   param3: [___]  |   [ Execute Tool ]               |   CSP                |
|                  |                                  |   - applied rules    |
|   [Execute]      |                                  |   - violations       |
|                  |                                  +----------------------+
+------------------+----------------------------------+                      |
                                                      |   Logs               |
                                                      |   - postMessage      |
                                                      |   - tool calls       |
                                                      +----------------------+
```

---

## Component Architecture

### New Components

```
client/src/components/ui-playground/
  UIPlaygroundTab.tsx           # Main 3-panel orchestrator
  PlaygroundToolsSidebar.tsx    # Left: tool list + params form
  PlaygroundEmulator.tsx        # Center: device frame + widget iframe
  PlaygroundInspector.tsx       # Right: tabbed Output/State/Globals/Logs

client/src/stores/
  ui-playground-store.ts        # Zustand store for playground state
```

### Component Responsibilities

#### `UIPlaygroundTab.tsx`
Main orchestrator component. Manages:
- Selected tool state
- Tool parameters form state
- Execution state
- Device emulation settings
- Globals configuration

#### `PlaygroundToolsSidebar.tsx`
Left panel with:
- Searchable tool list (reuses patterns from `ToolsSidebar.tsx`)
- Dynamic parameters form (reuses `tool-form.ts` utilities)
- Execute button

#### `PlaygroundEmulator.tsx`
Central widget rendering area:
- Renders `ChatGPTSandboxedIframe` with configured globals
- Device frame selector (mobile/tablet/desktop)
- Display mode selector (inline/pip/fullscreen)
- Applies device frame styling based on selection
- Handles all `openai:*` postMessage events
- Forwards tool calls to MCP server

#### `PlaygroundInspector.tsx`
Right panel with five tabs:
1. **Output** - Raw tool output (structuredContent, _meta)
2. **Widget State** - Current `window.openai.widgetState` (read-only, real-time)
3. **Globals** - Editable host globals with real-time push
4. **CSP** - Read-only display of applied CSP + violation logs
5. **Logs** - Filtered postMessage logs (reuses `ui-log-store.ts`)

---

## Data Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           UIPlaygroundTab                                │
│                                                                         │
│  ┌─────────────┐    ┌──────────────────┐    ┌──────────────────────┐   │
│  │ Tools       │    │ PlaygroundState  │    │ Inspector            │   │
│  │ Sidebar     │───▶│                  │◀───│ Panel                │   │
│  │             │    │ - selectedTool   │    │                      │   │
│  │ - toolList  │    │ - formFields     │    │ - toolOutput         │   │
│  │ - params    │    │ - deviceType     │    │ - widgetState        │   │
│  │ - execute   │    │ - displayMode    │    │ - globals (editable) │   │
│  └─────────────┘    │ - globals        │    │ - logs               │   │
│                     │ - toolOutput     │    └──────────────────────┘   │
│                     │ - widgetState    │                               │
│                     │ - logs           │                               │
│                     └────────┬─────────┘                               │
│                              │                                         │
│                              ▼                                         │
│                     ┌──────────────────┐                               │
│                     │ Playground       │                               │
│                     │ Emulator         │                               │
│                     │                  │                               │
│                     │ - device frame   │                               │
│                     │ - widget iframe  │                               │
│                     │ - message bridge │                               │
│                     └──────────────────┘                               │
└─────────────────────────────────────────────────────────────────────────┘
```

### Tool Execution Flow

```
User selects tool
       ↓
Form generated from inputSchema (reuse tool-form.ts)
       ↓
User clicks Execute
       ↓
POST /api/mcp/tools/execute
       ↓
If result has outputTemplate metadata:
  1. POST /api/mcp/openai/widget/store (with globals)
  2. GET /api/mcp/openai/widget-html/{toolId} → returns { html, csp }
  3. Store CSP in state for CSP tab display
  4. Render in ChatGPTSandboxedIframe
       ↓
Listen to postMessage events:
  - openai:resize → adjust frame height
  - openai:setWidgetState → show in Widget State tab
  - openai:callTool → execute and return result
  - openai:requestDisplayMode → update mode + log
  - openai:csp-violation → show in CSP tab
       ↓
Log all events to ui-log-store
```

---

## Key Features

### 1. Device Emulation

Toggle between device types with visual frame:

| Device  | Width   | Frame Style     | Notes                  |
|---------|---------|-----------------|------------------------|
| Mobile  | 375px   | iPhone bezel    | PiP → fullscreen       |
| Tablet  | 768px   | iPad frame      | PiP allowed            |
| Desktop | 1024px  | Browser chrome  | Full capability        |

This sets `window.openai.userAgent.device.type` in the widget.

### 2. Display Mode Testing

Test all three SDK display modes:

| Mode       | Frame Size        | Mobile Behavior      |
|------------|-------------------|----------------------|
| inline     | Within content    | Same                 |
| pip        | 400px floating    | → fullscreen         |
| fullscreen | Full viewport     | Full viewport        |

When widget calls `window.openai.requestDisplayMode()`:
1. Log the request in Logs tab
2. Update `displayMode` in globals
3. Adjust emulator frame size accordingly
4. Push `openai:set_globals` to widget with new mode

Note: On mobile device simulation, pip requests automatically convert to fullscreen (matching ChatGPT behavior).

### 3. Globals Configuration

Editable host-controlled values per OpenAI Apps SDK spec:

```typescript
// Playground-configurable globals (SDK-accurate)
interface PlaygroundGlobals {
  // Host-controlled appearance
  theme: "light" | "dark";
  locale: string;  // BCP 47 (e.g., "en-US", "es-MX", "ja-JP")

  // Device simulation
  deviceType: "mobile" | "tablet" | "desktop";

  // Display mode testing
  displayMode: "inline" | "pip" | "fullscreen";

  // Optional location simulation
  userLocation: {
    country: string;   // ISO 3166-1 (e.g., "US")
    region: string;    // State/province (e.g., "CA")
    city: string;
    timezone: string;  // IANA (e.g., "America/Los_Angeles")
  } | null;
}

// Read-only values (computed by host, shown in inspector for reference)
interface ComputedHostValues {
  maxHeight: number;        // Current available height in px
  safeArea: {               // Insets for notched devices
    insets: { top: number; right: number; bottom: number; left: number };
  };
  userAgent: {
    device: { type: "mobile" | "tablet" | "desktop" };
    capabilities: { hover: boolean; touch: boolean };
  };
}
```

Changes push `openai:set_globals` to the widget in real-time.

### 4. Widget State Inspector

Real-time view of `window.openai.widgetState`:
- Current state (JSON tree view)
- Read-only display (state is widget-controlled)
- Updates in real-time as widget calls `setWidgetState()`

### 5. Tool Call Interception

When widget calls `window.openai.callTool()`:
1. Show pending call in logs
2. Execute via MCP server
3. Show response in logs
4. Return result to widget (behaves like ChatTab)

### 6. Follow-up Message Testing

When widget calls `window.openai.sendFollowUpMessage()`:
- Log the message with payload
- Option to copy or view in context

### 7. CSP Debugging

Read-only display of Content Security Policy for debugging widget load failures:

**CSP Tab Contents:**
- **Applied CSP** - Shows the CSP rules from `_meta["openai/widgetCSP"]`:
  ```typescript
  {
    connectDomains: string[];   // Allowed fetch/XHR domains
    resourceDomains: string[];  // Allowed script/style/img domains
  }
  ```
- **Violations** - Real-time log of CSP violations (from `openai:csp-violation` messages)
- **Effective Policy** - Full CSP string being applied to the iframe

This helps developers understand why widgets fail to load external resources or make API calls.

---

## ChatGPT App Detection

Not all tools return widgets. Render widget emulator only when:

```typescript
function isChatGPTAppTool(tool: Tool, toolResult: CallToolResult): boolean {
  // Check for outputTemplate in tool definition metadata
  const hasOutputTemplate = tool._meta?.["openai/outputTemplate"];

  // Or check for structuredContent with HTML resource
  const hasWidgetContent = toolResult.structuredContent?.resourceUri &&
    toolResult.structuredContent?.mimeType === "text/html+skybridge";

  return Boolean(hasOutputTemplate || hasWidgetContent);
}
```

For non-widget tools, hide the emulator panel and show only the Output tab (like current ToolsTab behavior).

---

## State Management

Use Zustand store for playground state:

```typescript
// stores/ui-playground-store.ts
interface UIPlaygroundState {
  // Tool selection
  selectedTool: string | null;
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
  csp: {
    connectDomains: string[];
    resourceDomains: string[];
  } | null;
  cspViolations: Array<{ timestamp: number; violation: string }>;

  // Emulation
  deviceType: "mobile" | "tablet" | "desktop";
  displayMode: "inline" | "pip" | "fullscreen";
  globals: PlaygroundGlobals;

  // Actions
  setSelectedTool: (tool: string) => void;
  updateFormField: (name: string, value: unknown) => void;
  executeTool: () => Promise<void>;
  setDeviceType: (type: DeviceType) => void;
  setDisplayMode: (mode: DisplayMode) => void;
  updateGlobal: <K extends keyof PlaygroundGlobals>(key: K, value: PlaygroundGlobals[K]) => void;
  setWidgetState: (state: unknown) => void;
  setCsp: (csp: { connectDomains: string[]; resourceDomains: string[] }) => void;
  addCspViolation: (violation: string) => void;
}
```

Note: Logs are managed via the existing `ui-log-store.ts`.

---

## API Integration

### Existing Endpoints Used

| Endpoint | Purpose |
|----------|---------|
| `POST /api/mcp/tools/list` | List available tools |
| `POST /api/mcp/tools/execute` | Execute tool |
| `POST /api/mcp/openai/widget/store` | Store widget data |
| `GET /api/mcp/openai/widget-html/:toolId` | Get widget HTML |

### Key Reusable Code

| Existing Code | Reuse Purpose |
|---------------|---------------|
| `tool-form.ts` | `generateFormFieldsFromSchema()`, `buildParametersFromFields()` |
| `ChatGPTSandboxedIframe` | Widget rendering with postMessage bridge |
| `chatgpt-app-renderer.tsx` | postMessage handling patterns (callTool, resize) |
| `ui-log-store.ts` | Log storage and display |
| `ParametersPanel.tsx` | Form rendering patterns |

---

## Implementation Phases

### Phase 1: Foundation
1. Create `UIPlaygroundTab.tsx` with resizable 3-panel layout
2. Add navigation to sidebar and App.tsx
3. Create `ui-playground-store.ts` with basic state
4. Fetch and display tool list in `PlaygroundToolsSidebar.tsx`

### Phase 2: Tool Execution
1. Implement parameters form (reuse `tool-form.ts` utilities)
2. Add Execute button with tool execution
3. Display raw JSON results in Output tab
4. Detect ChatGPT App tools via `_meta["openai/outputTemplate"]`

### Phase 3: Widget Rendering
1. Implement `PlaygroundEmulator.tsx` with device frames
2. Integrate `ChatGPTSandboxedIframe` component
3. Store widget data and render widget on tool execution
4. Handle postMessage events (resize, callTool, setWidgetState)

### Phase 4: Inspector Panel
1. Build Output tab with JSON viewer
2. Build Widget State tab (real-time from postMessage)
3. Build Globals tab with form controls + real-time push
4. Build CSP tab (applied rules + violations)
5. Build Logs tab using `ui-log-store`

### Phase 5: Polish (Post-MVP)
1. Keyboard shortcuts (Cmd+Enter to execute)
2. Display mode simulation with host approval/rejection
3. Save/load playground configurations

---

## File Changes Summary

### New Files
```
client/src/components/ui-playground/
  UIPlaygroundTab.tsx
  PlaygroundToolsSidebar.tsx
  PlaygroundEmulator.tsx
  PlaygroundInspector.tsx

client/src/stores/
  ui-playground-store.ts
```

### Modified Files
```
client/src/App.tsx                    # Add UIPlayground tab
client/src/components/mcp-sidebar.tsx # Add tab navigation
```

---

## Design Decisions

### Why a separate tab instead of enhancing ToolsTab?

1. **Different UX paradigm**: ToolsTab is optimized for JSON in/out; Playground needs visual rendering
2. **Additional controls**: Device emulation, globals editing, state inspection don't fit ToolsTab
3. **Backwards compatibility**: Existing ToolsTab users shouldn't see UI changes
4. **Focused experience**: ChatGPT Apps developers get a dedicated experience

### Why not use ChatTabV2 for testing?

1. **No determinism**: ChatTabV2 uses LLM to decide tool calls
2. **No parameter control**: Can't manually set exact tool parameters
3. **No globals control**: Can't override theme, locale, etc.
4. **Not reproducible**: Same prompt may produce different results

### Why OpenAI Apps SDK only (not MCP Apps/SEP-1865)?

1. **Simpler MVP**: One protocol to support initially
2. **ChatGPT parity**: Matches the primary use case
3. **Can extend later**: MCP Apps support can be added post-MVP

---

## Success Metrics

1. **Developer productivity**: Time to test a widget change < 5 seconds
2. **Determinism**: Same parameters always produce same widget render
3. **Debuggability**: All postMessage events visible in logs
4. **Completeness**: All SDK features testable (callTool, sendFollowUp, display modes)

---

## Open Questions

1. Should we support multiple widgets side-by-side for comparison testing?
2. Should we add screenshot/recording capabilities for documentation?
3. Should globals be saveable per-tool or global to the playground?

---

## References

- [OpenAI Apps SDK Documentation](https://developers.openai.com/apps-sdk/)
- [OpenAI Apps SDK State Management](https://developers.openai.com/apps-sdk/build/state-management/)
- [OpenAI Apps SDK ChatGPT UI](https://developers.openai.com/apps-sdk/build/chatgpt-ui/)
- Existing implementation: `server/routes/mcp/chatgpt.ts`
- Existing renderer: `client/src/components/chat-v2/chatgpt-app-renderer.tsx`
- Sandbox iframe: `client/src/components/ui/chatgpt-sandboxed-iframe.tsx`
