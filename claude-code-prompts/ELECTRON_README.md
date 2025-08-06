# MCPJam Inspector - Electron Desktop App

This document explains how to use MCPJam Inspector as a desktop Electron application.

## Dual Deployment Options

MCPJam Inspector now supports two deployment methods:

### 1. NPX Command (Original Method)

```bash
npx @mcpjam/inspector
```

This preserves the original workflow and functionality.

### 2. Electron Desktop App (New)

Download and install the native desktop application or run it in development mode.

## Development

### Running in Development Mode

```bash
# Start the Electron app in development mode
npm run electron:dev

# Or use the alias
npm run electron:start
```

### Building the Client and Server

```bash
# Build both client and server (needed for production Electron app)
npm run build

# Or build separately
npm run build:client
npm run build:server
```

## Production Builds

### Package the App

```bash
npm run electron:package
```

### Create Distribution Files

```bash
npm run electron:make
```

This will create platform-specific installers in the `out/` directory:

- **Windows**: `.exe` installer
- **macOS**: `.dmg` disk image
- **Linux**: `.deb` and `.rpm` packages

### Publishing (GitHub Releases)

```bash
npm run electron:publish
```

## Architecture

### Main Process (`src/main.ts`)

- Embeds the Hono server with dynamic port allocation
- Manages the main application window
- Handles single instance locking
- Provides native OS integration (menus, file dialogs)

### Preload Script (`src/preload.ts`)

- Exposes secure IPC APIs to the renderer process
- Provides access to file system operations
- Enables native dialog integration

### Renderer Process (React App)

- Uses the existing React application from `client/`
- Can detect Electron environment via `window.isElectron`
- Access native features through `window.electronAPI`

### Shared Server Module (`server/app.ts`)

- Extracted Hono application used by both NPX and Electron
- Ensures consistent API behavior across deployment methods

## Configuration

### Electron Forge Config (`forge.config.ts`)

- Configures build targets and makers
- Sets up security fuses
- Defines packaging options

### Vite Configurations

- `vite.main.config.ts` - Main process build
- `vite.preload.config.ts` - Preload script build
- `vite.renderer.config.mts` - Renderer process build

## Features

### Native Integration

- **File Dialogs**: Open/save MCP server configurations
- **App Menus**: Standard application menus with keyboard shortcuts
- **Window Management**: Minimize, maximize, close operations
- **External Links**: Automatically open in system browser

### Security

- Context isolation enabled
- Node integration disabled in renderer
- Secure IPC communication patterns
- ASAR packaging with integrity validation

### Cross-Platform Support

- Windows (Squirrel installer)
- macOS (DMG disk image)
- Linux (DEB and RPM packages)

## Usage Examples

### Detecting Electron Environment

```typescript
if (window.isElectron) {
  // Running in Electron
  const version = await window.electronAPI?.app.getVersion();
} else {
  // Running in browser/NPX mode
}
```

### Using Native File Dialogs

```typescript
// Open file dialog
const files = await window.electronAPI?.files.openDialog({
  filters: [{ name: "JSON Files", extensions: ["json"] }],
});

// Save file dialog
const path = await window.electronAPI?.files.saveDialog(data);
```

### Window Operations

```typescript
// Minimize window
window.electronAPI?.window.minimize();

// Maximize/restore window
window.electronAPI?.window.maximize();

// Close window
window.electronAPI?.window.close();
```

## Development Tips

1. **Hot Reload**: The development mode supports hot reload for both main and renderer processes
2. **DevTools**: Automatically opens in development mode
3. **Debugging**: Use `electron-log` for main process logging
4. **Testing**: Run `npm test` for unit tests, `npm run test:e2e` for end-to-end tests

## Troubleshooting

### Build Issues

- Ensure all dependencies are installed: `npm install`
- Clean build directories: `rm -rf dist/ out/`
- Rebuild native modules: `npm rebuild`

### Runtime Issues

- Check electron-log output for main process errors
- Use browser DevTools for renderer process debugging
- Verify port availability for embedded server

## Migration from NPX Only

The Electron implementation is designed to be non-breaking:

- All existing NPX functionality is preserved
- No changes required to the React application
- Server API remains identical
- Build processes are additive, not replacements

Users can choose their preferred deployment method without any functionality differences.
