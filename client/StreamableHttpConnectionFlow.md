# Streamable HTTP Connection Flow with OAuth

This document describes how the MCP Inspector handles OAuth authentication when connecting to Streamable HTTP servers.

## Overview

The MCP Inspector provides seamless OAuth 2.1 authentication for Streamable HTTP servers through a comprehensive implementation that includes:

- **State Machine Pattern**: 6-step OAuth flow execution
- **Token Management**: Secure session storage with server-specific keys
- **Automatic Retry Logic**: Handles 401 errors and re-authentication
- **PKCE Support**: Enhanced security with Proof Key for Code Exchange
- **Multiple Server Support**: Isolated OAuth state per server

## Key Components

### 1. OAuth State Machine

**File**: `client/src/lib/utils/auth/oauth-state-machine.ts`

Implements the complete OAuth 2.1 flow using a state machine pattern with 6 distinct steps:

```typescript
export const oauthTransitions: Record<OAuthStep, StateTransition> = {
  metadata_discovery: {
    execute: async (context) => {
      const metadata = await discoverOAuthMetadata(context.serverUrl);
      context.provider.saveServerMetadata(metadata);
    }
  },
  client_registration: {
    execute: async (context) => {
      const fullInformation = await registerClient(context.serverUrl, {
        metadata, clientMetadata
      });
      context.provider.saveClientInformation(fullInformation);
    }
  },
  authorization_redirect: {
    execute: async (context) => {
      const { authorizationUrl, codeVerifier } = await startAuthorization(
        context.serverUrl, { metadata, clientInformation, redirectUrl, scope }
      );
      context.provider.saveCodeVerifier(codeVerifier);
    }
  },
  authorization_code: {
    execute: async (context) => {
      // Validates authorization code before proceeding
      if (!context.state.authorizationCode) {
        throw new Error("Authorization code required");
      }
    }
  },
  token_request: {
    execute: async (context) => {
      const tokens = await exchangeAuthorization(context.serverUrl, {
        metadata, clientInformation, authorizationCode, codeVerifier, redirectUri
      });
      context.provider.saveTokens(tokens);
    }
  },
  complete: {
    execute: async () => {
      // OAuth flow completed successfully
    }
  }
};
```

### 2. OAuth Client Provider

**File**: `client/src/lib/utils/auth/auth.ts`

Handles token storage and OAuth client configuration:

```typescript
export class InspectorOAuthClientProvider implements OAuthClientProvider {
  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "MCP Inspector",
      client_uri: "https://github.com/modelcontextprotocol/inspector",
    };
  }

  async tokens() {
    const key = getServerSpecificKey(SESSION_KEYS.TOKENS, this.serverUrl);
    const tokens = sessionStorage.getItem(key);
    return tokens ? await OAuthTokensSchema.parseAsync(JSON.parse(tokens)) : undefined;
  }

  saveTokens(tokens: OAuthTokens) {
    const key = getServerSpecificKey(SESSION_KEYS.TOKENS, this.serverUrl);
    sessionStorage.setItem(key, JSON.stringify(tokens));
  }
}
```

### 3. Connection Flow

**File**: `client/src/lib/utils/mcp/mcpjamClient.ts`

The main connection logic that handles OAuth automatically:

```typescript
async connectStreamableHttp() {
  try {
    const serverUrl = new URL(
      `${await getMCPProxyAddressAsync(this.inspectorConfig)}/mcp`
    );
    serverUrl.searchParams.append("url", this.serverConfig.url.toString());
    serverUrl.searchParams.append("transportType", "streamable-http");
    
    const transportOptions: StreamableHTTPClientTransportOptions = {
      requestInit: { headers: this.headers },
      reconnectionOptions: {
        maxReconnectionDelay: 30000,
        initialReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1.5,
        maxRetries: 2,
      },
    };
    
    this.clientTransport = new StreamableHTTPClientTransport(serverUrl, transportOptions);
    await this.connect(this.clientTransport);
    this.connectionStatus = "connected";
  } catch (error) {
    this.connectionStatus = "error";
    throw error;
  }
}

private async prepareAuthHeaders(): Promise<HeadersInit> {
  const headers: HeadersInit = {};
  
  if (this.serverConfig.transportType !== "stdio" && "url" in this.serverConfig) {
    const serverAuthProvider = new InspectorOAuthClientProvider(
      this.serverConfig.url.toString()
    );
    
    const token = this.bearerToken || (await serverAuthProvider.tokens())?.access_token;
    if (token) {
      const authHeaderName = this.headerName || "Authorization";
      headers[authHeaderName] = `Bearer ${token}`;
    }
  }
  
  return headers;
}

private async performOAuthFlow(): Promise<boolean> {
  const authProvider = this.createAuthProvider();
  if (!authProvider) return false;
  
  try {
    const serverUrl = "url" in this.serverConfig ? this.serverConfig.url.toString() : "";
    const result = await auth(authProvider, { serverUrl });
    return result === "AUTHORIZED";
  } catch (error) {
    this.addClientLog(`OAuth flow failed: ${error}`, "error");
    return false;
  }
}

private handleAuthError = async (error: unknown): Promise<boolean> => {
  if (this.is401Error(error)) {
    this.addClientLog("Authentication error detected, attempting OAuth flow", "warn");
    return await this.performOAuthFlow();
  }
  return false;
};
```

### 4. OAuth Callback Handler

**File**: `client/src/components/OAuthCallback.tsx`

Processes the OAuth callback and completes authentication:

```typescript
const handleCallback = async () => {
  const params = parseOAuthCallbackParams(window.location.search);
  if (!params.successful) {
    return notifyError(generateOAuthErrorDescription(params));
  }

  const serverUrl = sessionStorage.getItem(SESSION_KEYS.SERVER_URL);
  if (!serverUrl) {
    return notifyError("Missing Server URL");
  }

  try {
    const serverAuthProvider = new InspectorOAuthClientProvider(serverUrl);
    const result = await auth(serverAuthProvider, {
      serverUrl,
      authorizationCode: params.code,
    });

    if (result === "AUTHORIZED") {
      toast({
        title: "Success",
        description: "Successfully authenticated with OAuth",
        variant: "default",
      });
      onConnect(serverUrl); // Trigger reconnection with new tokens
    }
  } catch (error) {
    console.error("OAuth callback error:", error);
    return notifyError(`Unexpected error occurred: ${error}`);
  }
};
```

### 5. Session Storage Management

**File**: `client/src/lib/types/constants.ts`

Server-specific storage for OAuth data:

```typescript
export const SESSION_KEYS = {
  CODE_VERIFIER: "mcp_code_verifier",
  SERVER_URL: "mcp_server_url", 
  TOKENS: "mcp_tokens",
  CLIENT_INFORMATION: "mcp_client_information",
  SERVER_METADATA: "mcp_server_metadata",
} as const;

export const getServerSpecificKey = (baseKey: string, serverUrl?: string): string => {
  return serverUrl ? `[${serverUrl}] ${baseKey}` : baseKey;
};
```

## Connection Flow Sequence

### 1. Initial Connection Attempt
```typescript
// MCPJamClient.connectToServer()
await this.checkProxyHealth();
const authHeaders = await this.prepareAuthHeaders();
this.headers = { ...this.headers, ...authHeaders };
await this.connectToTransport();
```

### 2. OAuth Flow Trigger (on 401)
```typescript
// MCPJamClient.handleAuthError()
if (this.is401Error(error)) {
  return await this.performOAuthFlow();
}
```

### 3. State Machine Execution
```typescript
// OAuthStateMachine.executeStep()
const transition = oauthTransitions[state.oauthStep];
if (await transition.canTransition(context)) {
  await transition.execute(context);
}
```

### 4. User Authorization
- Browser redirects to authorization server
- User grants permissions
- Authorization code returned to callback URL

### 5. Token Exchange
```typescript
// oauth-state-machine.ts - token_request step
const tokens = await exchangeAuthorization(context.serverUrl, {
  metadata, clientInformation, authorizationCode, codeVerifier, redirectUri
});
context.provider.saveTokens(tokens);
```

### 6. Connection Retry
```typescript
// MCPJamClient.connectToServer()
if (retryCount < MAX_RETRIES) {
  const shouldRetry = await this.handleAuthError(error);
  if (shouldRetry) {
    return this.connectToServer(undefined, retryCount + 1);
  }
}
```

## Key Features

### Security
- **PKCE (Proof Key for Code Exchange)**: Enhanced security for OAuth flows
- **Server-Specific Storage**: Isolated tokens per server to prevent cross-contamination
- **Automatic Token Refresh**: Leverages MCP SDK's built-in token refresh capabilities

### Error Handling
- **401 Detection**: Automatically detects authentication failures
- **Graceful Degradation**: Proper error messages and user feedback
- **Retry Logic**: Limited retries to prevent infinite loops

### User Experience
- **Automatic Redirects**: Seamless browser redirects for authorization
- **Progress Feedback**: Toast notifications and detailed logging
- **Session Persistence**: Tokens survive browser refreshes

### Multi-Server Support
- **Isolated State**: Each server maintains separate OAuth state
- **Concurrent Connections**: Multiple authenticated servers simultaneously
- **Configuration Management**: Per-server authentication settings

## Integration Points

The OAuth implementation integrates with:

- **Transport Layer**: Streamable HTTP transport automatically includes bearer tokens
- **Connection Management**: MCPJamAgent handles multiple authenticated connections
- **UI State**: React contexts manage OAuth state across components
- **Error Handling**: Toast notifications and detailed error reporting
- **MCP SDK**: Leverages official MCP SDK OAuth implementation

## Server-Side Support

The proxy server forwards authentication headers:

```typescript
// server/src/index.ts
const STREAMABLE_HTTP_HEADERS_PASSTHROUGH = [
  "authorization",
  "mcp-session-id", 
  "last-event-id"
];
```

This ensures that OAuth tokens are properly passed through to the target MCP server while maintaining security and isolation.