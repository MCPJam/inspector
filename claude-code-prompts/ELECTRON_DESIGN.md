# Design Document: Converting MCPJam Inspector to Electron App

## Current Architecture Analysis

**Current Setup:**

- **Client**: React app using Vite dev server (port 8080) with Tailwind CSS, shadcn/ui components
- **Server**: Hono-based API server (port 3001) handling MCP connections and AI chat functionality
- **Build**: Client builds to `dist/client`, server builds to `dist/server`
- **Production**: Single server serves both API and static client files
- **Deployment**: NPX command (`npx @mcpjam/inspector`) for easy access

**Key Components:**

- MCP server connection management via WebSocket/IPC
- AI chat integration with multiple providers (OpenAI, Anthropic, Ollama)
- Resource/tool inspection interface
- Real-time logging and tracing

## Proposed Electron Architecture

### 1. Dual Deployment Strategy

**Preserving NPX Usage:**

```bash
npx @mcpjam/inspector  # Current workflow remains unchanged
```

**Adding Electron Option:**

- Native desktop app download and installation
- Same functionality with enhanced desktop UX
- Shared codebase for both deployment methods

### 2. Main Process Design (Learnings from Summon)

**Recommended Structure (Based on Electron Forge + Vite):**

```
mcpjam-inspector/
├── forge.config.ts             # Electron Forge configuration
├── vite.main.config.ts         # Main process Vite config
├── vite.preload.config.ts      # Preload Vite config
├── vite.renderer.config.mts    # Renderer Vite config
├── src/
│   ├── main.ts                 # Main process entry
│   ├── preload.ts              # Preload script
│   ├── renderer.ts             # Renderer entry
│   └── ipc/                    # IPC handlers (organized by feature)
│       ├── listeners-register.ts
│       ├── mcp/
│       ├── auth/
│       └── window/
├── client/                     # Existing React app (minimal changes)
├── server/                     # Existing Hono server (shared module)
└── package.json               # Updated with Forge scripts
```

**Main Process Responsibilities (Inspired by Summon):**

- Embed Hono server in main process with dynamic port allocation
- Handle single instance lock to prevent multiple app instances
- Manage MCP server lifecycle and file watchers
- Implement proper app cleanup on shutdown
- Handle OAuth protocol registration (if needed for AI providers)
- Native file dialogs and system integration

### 3. Shared Server Module Strategy

**Extract Hono App for Dual Usage:**

```javascript
// server/app.ts - Shared module
export const createHonoApp = () => {
  const app = new Hono();
  // ... existing routes and middleware
  return app;
};

// bin/start.js - NPX entry (preserves current behavior)
import { createHonoApp } from "../server/app.js";
const app = createHonoApp();
serve({ fetch: app.fetch, port: 3001 });

// src/main.ts - Electron entry
import { createHonoApp } from "../server/app.js";
const app = createHonoApp();
const server = serve({ fetch: app.fetch, port: 0 }); // dynamic port
createWindow(`http://localhost:${server.address().port}`);
```

### 4. Technology Stack (Aligned with Summon)

**Build System:**

- **Electron Forge** instead of electron-vite for better ecosystem support
- **Separate Vite configs** for main, preload, and renderer processes
- **Auto-updater** with proper release management

**Development Tools:**

- **TypeScript** throughout the application
- **ESLint + Prettier** for code quality
- **Vitest** for unit testing
- **Playwright** for E2E testing

### 5. Configuration Strategy

**forge.config.ts:**

```typescript
import type { ForgeConfig } from "@electron-forge/shared-types";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FusesPlugin } from "@electron-forge/plugin-fuses";

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    appBundleId: "com.mcpjam.inspector",
    appCategoryType: "public.app-category.developer-tools",
    icon: "assets/icon", // Platform-specific icons
  },
  makers: [
    new MakerSquirrel({}), // Windows
    new MakerZIP({}, ["darwin", "linux"]),
    new MakerDMG({}), // macOS
    new MakerDeb({}), // Linux
    new MakerRpm({}), // Linux
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: "src/main.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "src/preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.mts",
        },
      ],
    }),
    new FusesPlugin({
      // Security hardening
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
```

### 6. IPC Architecture (Following Summon's Patterns)

**Organized IPC Structure:**

```typescript
// src/ipc/listeners-register.ts
export default function registerListeners(mainWindow: BrowserWindow) {
  registerMcpListeners(mainWindow);
  registerWindowListeners(mainWindow);
  registerAuthListeners(mainWindow);
}

// src/ipc/mcp/mcp-listeners.ts
export function registerMcpListeners(mainWindow: BrowserWindow) {
  ipcMain.handle("mcp:connect", handleMcpConnect);
  ipcMain.handle("mcp:disconnect", handleMcpDisconnect);
  ipcMain.handle("mcp:list-servers", handleListServers);
}
```

**Preload Context Exposure:**

```typescript
// src/preload.ts
import { contextBridge, ipcRenderer } from "electron";

const electronAPI = {
  // MCP operations
  mcp: {
    connect: (config) => ipcRenderer.invoke("mcp:connect", config),
    disconnect: (id) => ipcRenderer.invoke("mcp:disconnect", id),
    listServers: () => ipcRenderer.invoke("mcp:list-servers"),
  },
  // File operations
  files: {
    openDialog: () => ipcRenderer.invoke("dialog:open"),
    saveDialog: (data) => ipcRenderer.invoke("dialog:save", data),
  },
  // App metadata
  app: {
    getVersion: () => ipcRenderer.invoke("app:version"),
  },
};

contextBridge.exposeInMainWorld("electronAPI", electronAPI);
```

### 7. Migration Plan

**Phase 1: Forge Setup & Basic Shell**

1. Install Electron Forge and configure build system
2. Create separate Vite configs for main/preload/renderer
3. Extract shared Hono server module
4. Implement basic main process with embedded server
5. Ensure NPX command still works unchanged

**Phase 2: Desktop Integration**

1. Add native app menus and keyboard shortcuts
2. Implement file dialogs for MCP server configuration
3. Add proper window state management
4. Setup auto-updater infrastructure

**Phase 3: Enhanced Features**

1. System tray integration for background operation
2. Native notifications for server status
3. Protocol handler for `mcpjam://` URLs
4. Better error handling and crash reporting

### 8. Dependencies Update

**Key New Dependencies:**

```json
{
  "devDependencies": {
    "@electron-forge/cli": "^7.8.1",
    "@electron-forge/maker-deb": "^7.8.1",
    "@electron-forge/maker-dmg": "^7.8.1",
    "@electron-forge/maker-rpm": "^7.8.1",
    "@electron-forge/maker-squirrel": "^7.8.1",
    "@electron-forge/maker-zip": "^7.8.1",
    "@electron-forge/plugin-vite": "^7.8.1",
    "@electron-forge/publisher-github": "^7.8.1",
    "electron": "^35.2.1",
    "vitest": "^3.2.4",
    "@playwright/test": "^1.53.1"
  },
  "dependencies": {
    "electron-log": "^5.4.0",
    "update-electron-app": "^3.1.1",
    "fix-path": "^4.0.0"
  }
}
```

**Updated Scripts:**

```json
{
  "scripts": {
    "start": "electron-forge start",
    "package": "electron-forge package",
    "make": "electron-forge make",
    "publish": "electron-forge publish",
    "dev:electron": "electron-forge start",
    "dev:web": "concurrently \"npm run dev:server\" \"npm run dev:client\"",
    "test": "vitest run",
    "test:e2e": "playwright test"
  }
}
```

### 9. Security & Production Considerations

**Security Features (Following Summon's Approach):**

- Context isolation enabled by default
- Node integration disabled in renderer
- Secure IPC patterns with proper validation
- ASAR packaging with integrity validation
- Proper fuse configuration for production hardening

**Production Features:**

- Auto-updater with GitHub releases
- Crash reporting and telemetry (optional)
- Code signing for macOS and Windows
- Proper app categorization for app stores

### 10. Benefits of This Architecture

1. **Dual Deployment**: Preserves NPX workflow while adding native app option
2. **Proven Patterns**: Leverages battle-tested approaches from Summon
3. **Minimal Migration**: Existing codebase requires minimal changes
4. **Professional Tooling**: Electron Forge provides production-ready build pipeline
5. **Native Experience**: File dialogs, app menus, system integration
6. **Maintainable**: Clear separation between web and desktop concerns
7. **Secure**: Modern Electron security practices from day one

This architecture ensures developers can continue using `npx @mcpjam/inspector` while also offering a superior desktop experience for users who prefer native applications.
