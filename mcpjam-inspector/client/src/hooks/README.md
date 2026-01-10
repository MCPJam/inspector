# useAppState Hook

A custom Next.js hook that manages the MCP Inspector application state with localStorage persistence and OAuth flow handling.

## Features

- **Persistent State**: Automatically saves and loads state from localStorage
- **OAuth Flow Management**: Handles complete OAuth 2.1 + PKCE flow for MCP servers
- **Token Management**: Automatic token refresh and expiration handling
- **Server Management**: Connect, disconnect, and manage MCP servers
- **Loading States**: Provides loading state for better UX

## Usage

```tsx
import { useAppState } from "@/hooks/useAppState";

function MyComponent() {
  const {
    appState,
    isLoading,
    connectedServers,
    selectedMCPConfig,
    handleConnect,
    handleDisconnect,
    setSelectedServer,
    refreshOAuthToken,
    getValidAccessToken,
  } = useAppState();

  if (isLoading) {
    return <div>Loading...</div>;
  }

  return <div>{/* Your component JSX */}</div>;
}
```

## API

### State

- `appState`: The complete application state
- `isLoading`: Boolean indicating if the hook is still loading initial state

### Computed Values

- `connectedServers`: Array of connected server names
- `selectedServerEntry`: The currently selected server object
- `selectedMCPConfig`: The MCP configuration for the selected server

### Actions

- `handleConnect(formData)`: Connect to a new MCP server
- `handleDisconnect(serverName)`: Disconnect from a server
- `setSelectedServer(serverName)`: Change the selected server
- `refreshOAuthToken(serverName)`: Manually refresh OAuth tokens
- `getValidAccessToken(serverName)`: Get a valid access token (refreshes if needed)
- `isTokenExpired(expiresAt, bufferMinutes)`: Check if a token is expired

## OAuth Flow

The hook automatically handles:

1. **OAuth Initiation**: Creates authorization URLs and stores PKCE parameters
2. **State Persistence**: Saves OAuth state to localStorage before redirects
3. **Callback Handling**: Processes OAuth callbacks and exchanges codes for tokens
4. **Token Refresh**: Automatically refreshes expired tokens
5. **Error Handling**: Provides meaningful error messages for OAuth failures

## Types

The hook exports several TypeScript interfaces:

- `AppState`: The complete application state structure
- `ServerWithName`: Individual server configuration with OAuth state
- `ServerFormData`: Form data for connecting to servers

## Storage

State is automatically persisted to localStorage under the key `"mcp-inspector-state"`. The hook handles:

- Loading state on mount
- Saving state changes
- OAuth callback detection
- Error recovery for corrupted state
