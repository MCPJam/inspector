import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  Request,
  Result,
  Notification,
  ServerCapabilities,
  ClientRequest,
  Progress,
  ResourceReference, // Keep using this despite deprecation warning for now
  PromptReference, // Keep using this despite deprecation warning for now
  CompleteResultSchema,
  McpError,
  ErrorCode,
  CreateMessageRequestSchema,
  CreateMessageResult,
  ListRootsRequestSchema,
  CreateMessageRequest,
  ElicitRequest,
  ElicitRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { AIProvider, providerManager } from "@/lib/providers";
import packageJson from "@/../package.json";
import {
  getMCPProxyAddress,
  getMCPProxyAddressAsync,
  getMCPServerRequestMaxTotalTimeout,
  getMCPServerRequestTimeout,
  resetRequestTimeoutOnProgress,
} from "@/lib/utils/json/configUtils";
import { InspectorConfig } from "@/lib/types/configurationTypes";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  SSEClientTransport,
  SSEClientTransportOptions,
  SseError,
} from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InspectorOAuthClientProvider } from "@/lib/utils/auth/auth";
import { z } from "zod";
import { ConnectionStatus } from "@/lib/types/constants";
import { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { toast } from "@/lib/hooks/useToast";
import {
  StdErrNotificationSchema,
  StdErrNotification,
} from "@/lib/types/notificationTypes";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  HttpServerDefinition,
  MCPJamServerConfig,
} from "@/lib/types/serverTypes";
import { ClientLogLevels } from "@/hooks/helpers/types";
// Chat functionality has been moved to MCPJamAgent
import { ElicitationResponse } from "@/components/ElicitationModal";

/**
 * Extended MCP client interface adding AI provider capabilities
 */
export interface ExtendedMcpClient extends Client {
  aiProvider: AIProvider;
  cleanup: () => Promise<void>;
}

/**
 * Implementation of MCP client for connecting to MCP servers
 */
export class MCPJamClient extends Client<Request, Notification, Result> {
  private clientTransport: Transport | undefined;
  private serverConfig: MCPJamServerConfig;
  private headers: HeadersInit;
  private mcpProxyServerUrl: URL;
  private inspectorConfig: InspectorConfig;

  public connectionStatus: ConnectionStatus;
  public serverCapabilities: ServerCapabilities | null;
  public completionsSupported: boolean;

  public bearerToken?: string;
  public headerName?: string;
  public onStdErrNotification?: (notification: StdErrNotification) => void;
  public onPendingRequest?: (
    request: CreateMessageRequest,
    resolve: (result: CreateMessageResult) => void,
    reject: (error: Error) => void,
  ) => void;
  public onElicitationRequest?: (
    request: ElicitRequest,
    resolve: (result: ElicitationResponse) => void,
  ) => void;
  public getRoots?: () => unknown[];
  public addRequestHistory: (request: object, response?: object) => void;
  public addClientLog: (message: string, level: ClientLogLevels) => void;

  /**
   * Creates a new MCPJamClient instance
   *
   * @param serverConfig Configuration for the server connection
   * @param inspectorConfig Inspector configuration
   * @param addRequestHistory Callback to record request history
   * @param addClientLog Callback to log client activity
   * @param bearerToken Optional authentication token
   * @param headerName Optional custom header name for authentication
   * @param onStdErrNotification Callback for stderr notifications
   * @param onPendingRequest Callback for pending message requests
   * @param onElicitationRequest Callback for elicitation requests
   * @param getRoots Callback to retrieve root resources
   */
  constructor(
    serverConfig: MCPJamServerConfig,
    inspectorConfig: InspectorConfig,
    addRequestHistory: (request: object, response?: object) => void,
    addClientLog: (message: string, level: ClientLogLevels) => void,
    bearerToken?: string,
    headerName?: string,
    onStdErrNotification?: (notification: StdErrNotification) => void,
    onPendingRequest?: (
      request: CreateMessageRequest,
      resolve: (result: CreateMessageResult) => void,
      reject: (error: Error) => void,
    ) => void,
    onElicitationRequest?: (
      request: ElicitRequest,
      resolve: (result: ElicitationResponse) => void,
    ) => void,
    getRoots?: () => unknown[],
  ) {
    super(
      { name: "mcpjam-inspector", version: packageJson.version },
      {
        capabilities: {
          sampling: {},
          elicitation: {},
          roots: {
            listChanged: true,
          },
        },
      },
    );

    this.serverConfig = serverConfig;
    this.headers = {};
    this.mcpProxyServerUrl = new URL(
      `${getMCPProxyAddress(inspectorConfig)}/stdio`,
    );
    this.inspectorConfig = inspectorConfig;
    this.connectionStatus = "disconnected";
    this.serverCapabilities = null;
    this.completionsSupported = true;

    // Callbacks and handlers
    this.bearerToken = bearerToken;
    this.headerName = headerName;
    this.onStdErrNotification = onStdErrNotification;
    this.onPendingRequest = onPendingRequest;
    this.onElicitationRequest = onElicitationRequest;
    this.getRoots = getRoots;
    this.addRequestHistory = addRequestHistory;
    this.addClientLog = addClientLog;
  }

  // Get AI provider from ProviderManager
  get aiProvider(): AIProvider | null {
    return providerManager.getDefaultProvider();
  }

  /**
   * Connect to MCP server via STDIO transport
   */
  async connectStdio() {
    const serverUrl = new URL(
      `${await getMCPProxyAddressAsync(this.inspectorConfig)}/stdio`,
    );

    // Type guard to ensure we have a stdio server config
    if (
      this.serverConfig.transportType === "stdio" &&
      "command" in this.serverConfig
    ) {
      serverUrl.searchParams.append("command", this.serverConfig.command);
      serverUrl.searchParams.append(
        "args",
        this.serverConfig.args?.join(" ") ?? "",
      );
      serverUrl.searchParams.append(
        "env",
        JSON.stringify(this.serverConfig.env ?? {}),
      );
    }

    serverUrl.searchParams.append("transportType", "stdio");

    const transportOptions: SSEClientTransportOptions = {
      eventSourceInit: {
        fetch: (
          url: string | URL | globalThis.Request,
          init: RequestInit | undefined,
        ) => fetch(url, { ...init, headers: this.headers }),
      },
      requestInit: {
        headers: this.headers,
      },
    };

    this.mcpProxyServerUrl = serverUrl;
    try {
      const command =
        "command" in this.serverConfig ? this.serverConfig.command : "unknown";
      this.addClientLog(
        `Connecting to MCP server via stdio: ${command}`,
        "info",
      );
      // We do this because we're proxying through the inspector server first.
      this.clientTransport = new SSEClientTransport(
        serverUrl,
        transportOptions,
      );
      await this.connect(this.clientTransport);
      this.connectionStatus = "connected";
      this.addClientLog(
        "Successfully connected to MCP server via stdio",
        "info",
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.addClientLog(
        `Failed to connect to MCP server via stdio: ${errorMessage}`,
        "error",
      );
      console.error("Error connecting to MCP server:", error);
      this.connectionStatus = "error";
      throw error; // Re-throw to allow proper error handling
    }
  }

  /**
   * Connect to MCP server via Server-Sent Events (SSE) transport
   */
  async connectSSE() {
    try {
      const serverUrl = new URL(
        `${await getMCPProxyAddressAsync(this.inspectorConfig)}/sse`,
      );
      serverUrl.searchParams.append(
        "url",
        (this.serverConfig as HttpServerDefinition).url.toString(),
      );
      serverUrl.searchParams.append("transportType", "sse");
      const transportOptions: SSEClientTransportOptions = {
        eventSourceInit: {
          fetch: (
            url: string | URL | globalThis.Request,
            init: RequestInit | undefined,
          ) => fetch(url, { ...init, headers: this.headers }),
        },
        requestInit: {
          headers: this.headers,
        },
      };
      this.clientTransport = new SSEClientTransport(
        serverUrl,
        transportOptions,
      );
      this.mcpProxyServerUrl = serverUrl;
      this.addClientLog(
        `Connecting to MCP server via SSE: ${(this.serverConfig as HttpServerDefinition).url}`,
        "info",
      );
      await this.connect(this.clientTransport);
      this.connectionStatus = "connected";
      this.addClientLog("Successfully connected to MCP server via SSE", "info");
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.addClientLog(
        `Failed to connect to MCP server via SSE: ${errorMessage}`,
        "error",
      );
      console.error("Error connecting to MCP server:", error);
      this.connectionStatus = "error";
      throw error; // Re-throw to allow proper error handling
    }
  }

  /**
   * Connect to MCP server via Streamable HTTP transport
   */
  async connectStreamableHttp() {
    try {
      const serverUrl = new URL(
        `${await getMCPProxyAddressAsync(this.inspectorConfig)}/mcp`,
      );
      serverUrl.searchParams.append(
        "url",
        (this.serverConfig as HttpServerDefinition).url.toString(),
      );
      serverUrl.searchParams.append("transportType", "streamable-http");
      const transportOptions: StreamableHTTPClientTransportOptions = {
        requestInit: {
          headers: this.headers,
        },
        reconnectionOptions: {
          maxReconnectionDelay: 30000,
          initialReconnectionDelay: 1000,
          reconnectionDelayGrowFactor: 1.5,
          maxRetries: 2,
        },
      };
      this.clientTransport = new StreamableHTTPClientTransport(
        serverUrl,
        transportOptions,
      );
      this.mcpProxyServerUrl = serverUrl;
      this.addClientLog(
        `Connecting to MCP server via Streamable HTTP: ${(this.serverConfig as HttpServerDefinition).url}`,
        "info",
      );
      await this.connect(this.clientTransport);
      this.connectionStatus = "connected";
      this.addClientLog(
        "Successfully connected to MCP server via Streamable HTTP",
        "info",
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.addClientLog(
        `Failed to connect to MCP server via Streamable HTTP: ${errorMessage}`,
        "error",
      );
      console.error("Error connecting to MCP server:", error);
      this.connectionStatus = "error";
      throw error; // Re-throw to allow proper error handling
    }
  }

  /**
   * Check if the MCP proxy server is healthy
   * @throws Error if proxy server is not healthy
   */
  async checkProxyHealth() {
    try {
      const proxyHealthUrl = new URL(
        `${await getMCPProxyAddressAsync(this.inspectorConfig)}/health`,
      );
      this.addClientLog("Checking MCP proxy server health", "debug");
      const proxyHealthResponse = await fetch(proxyHealthUrl);
      const proxyHealth = await proxyHealthResponse.json();
      if (proxyHealth?.status !== "ok") {
        this.addClientLog("MCP Proxy Server is not healthy", "error");
        throw new Error("MCP Proxy Server is not healthy");
      }
      this.addClientLog("MCP proxy server health check passed", "debug");
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      this.addClientLog(
        `Failed to connect to MCP Proxy Server: ${errorMessage}`,
        "error",
      );
      console.error("Couldn't connect to MCP Proxy Server", e);
      throw e;
    }
  }

  /**
   * Check if an error is an HTTP 401 Unauthorized error
   * @param error The error to check
   * @returns true if the error is a 401 Unauthorized error
   */
  private is401Error = (error: unknown): boolean => {
    return (
      (error instanceof SseError && error.code === 401) ||
      (error instanceof Error && error.message.includes("401")) ||
      (error instanceof Error && error.message.includes("Unauthorized"))
    );
  };

  /**
   * Create auth provider for the current server
   * @returns Auth provider or null if not applicable
   */
  private createAuthProvider(): InspectorOAuthClientProvider | null {
    if (
      this.serverConfig.transportType !== "stdio" &&
      "url" in this.serverConfig &&
      this.serverConfig.url
    ) {
      return new InspectorOAuthClientProvider(
        this.serverConfig.url.toString(),
        this.serverConfig.transportType,
      );
    }
    return null;
  }

  /**
   * Attempt OAuth authentication flow
   * @returns true if authentication successful
   */
  private async performOAuthFlow(): Promise<boolean> {
    const authProvider = this.createAuthProvider();
    if (!authProvider) {
      return false;
    }

    try {
      const serverUrl =
        "url" in this.serverConfig && this.serverConfig.url
          ? this.serverConfig.url.toString()
          : "";

      const result = await auth(authProvider, {
        serverUrl: serverUrl,
      });

      if (result === "AUTHORIZED") {
        this.addClientLog("OAuth authentication successful", "info");
        return true;
      } else {
        this.addClientLog("OAuth authentication failed", "error");
        return false;
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.addClientLog(`OAuth flow failed: ${errorMessage}`, "error");
      return false;
    }
  }

  /**
   * Handle authentication errors by attempting OAuth flow
   * @param error The error that occurred
   * @returns true if auth was successful and retry should happen
   */
  private handleAuthError = async (error: unknown): Promise<boolean> => {
    if (this.is401Error(error)) {
      this.addClientLog(
        "Authentication error detected, attempting OAuth flow",
        "warn",
      );

      return await this.performOAuthFlow();
    }

    return false;
  };

  /**
   * Configure the request handlers for this client
   */
  private setupRequestHandlers(): void {
    // Configure handlers for pending message requests
    if (this.onPendingRequest) {
      this.setRequestHandler(CreateMessageRequestSchema, (request) => {
        return new Promise((resolve, reject) => {
          this.onPendingRequest?.(request, resolve, reject);
        });
      });
    }

    // Configure handlers for elicitation requests
    if (this.onElicitationRequest) {
      this.setRequestHandler(ElicitRequestSchema, (request) => {
        return new Promise((resolve) => {
          this.onElicitationRequest?.(
            request,
            resolve as (result: ElicitationResponse) => void,
          );
        });
      });
    }

    // Configure handlers for roots requests
    if (this.getRoots) {
      this.setRequestHandler(ListRootsRequestSchema, async () => {
        return { roots: this.getRoots?.() ?? [] };
      });
      this.addClientLog("Roots request handler configured", "debug");
    }

    // Configure stderr notification handler
    if (this.onStdErrNotification) {
      this.setNotificationHandler(
        StdErrNotificationSchema,
        this.onStdErrNotification,
      );
      this.addClientLog("StdErr notification handler configured", "debug");
    }
  }

  /**
   * Prepare the authentication headers based on server type
   * @returns The headers object with authentication information
   */
  private async prepareAuthHeaders(): Promise<HeadersInit> {
    const headers: HeadersInit = {};

    // Only apply OAuth authentication for HTTP-based transports
    if (
      this.serverConfig.transportType !== "stdio" &&
      "url" in this.serverConfig &&
      this.serverConfig.url
    ) {
      this.addClientLog(
        "Setting up OAuth authentication for HTTP transport",
        "debug",
      );
      // Create an auth provider with the current server URL
      const serverAuthProvider = new InspectorOAuthClientProvider(
        this.serverConfig.url.toString(),
        this.serverConfig.transportType,
      );

      // Use manually provided bearer token if available, otherwise use OAuth tokens
      const token =
        this.bearerToken || (await serverAuthProvider.tokens())?.access_token;
      if (token) {
        const authHeaderName = this.headerName || "Authorization";
        headers[authHeaderName] = `Bearer ${token}`;
        this.addClientLog(
          "Bearer token configured for authentication",
          "debug",
        );
      } else {
        this.addClientLog(
          "No bearer token available for authentication",
          "warn",
        );
      }
    } else if (this.bearerToken) {
      // For stdio or when manually providing bearer token, still apply it
      const authHeaderName = this.headerName || "Authorization";
      headers[authHeaderName] = `Bearer ${this.bearerToken}`;
      this.addClientLog("Bearer token configured for stdio transport", "debug");
    }

    return headers;
  }

  /**
   * Establish connection to transport and update capabilities
   */
  private async connectToTransport(): Promise<void> {
    switch (this.serverConfig.transportType) {
      case "stdio":
        await this.connectStdio();
        break;
      case "sse":
        await this.connectSSE();
        break;
      case "streamable-http":
        await this.connectStreamableHttp();
        break;
    }

    // Update server capabilities after successful connection
    this.serverCapabilities = this.getServerCapabilities() ?? null;
    this.addClientLog(
      `Server capabilities retrieved: ${JSON.stringify(this.serverCapabilities)}`,
      "debug",
    );

    const initializeRequest = {
      method: "initialize",
    };
    this.addRequestHistory(initializeRequest, {
      capabilities: this.serverCapabilities,
      serverInfo: this.getServerVersion(),
      instructions: this.getInstructions(),
    });
    this.addClientLog("MCP client initialization completed", "info");
  }

  /**
   * Connect to an MCP server
   * @param _e Optional error object (unused)
   * @param retryCount Current retry attempt count
   */
  async connectToServer(_e?: unknown, retryCount: number = 0): Promise<void> {
    const MAX_RETRIES = 1; // Limit retries to prevent infinite loops

    try {
      await this.checkProxyHealth();
    } catch {
      this.connectionStatus = "error-connecting-to-proxy";
      this.addClientLog("Failed to connect to proxy server", "error");
      return;
    }

    try {
      this.addClientLog(
        `Attempting to connect to MCP server (attempt ${retryCount + 1}/${MAX_RETRIES + 1})`,
        "info",
      );

      // Get authentication headers and update the client's headers
      const authHeaders = await this.prepareAuthHeaders();
      this.headers = { ...this.headers, ...authHeaders };

      try {
        // Connect to transport based on server config
        await this.connectToTransport();

        // Reset completions support on new connection
        this.completionsSupported = true;

        // Set up request handlers
        this.setupRequestHandlers();

        this.connectionStatus = "connected";
        this.addClientLog(
          "MCP client connection established successfully",
          "info",
        );
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.addClientLog(
          `Failed to connect to MCP Server via the MCP Inspector Proxy: ${errorMessage}`,
          "error",
        );
        console.error(
          `Failed to connect to MCP Server via the MCP Inspector Proxy: ${this.getMCPProxyServerUrl()}:`,
          error,
        );

        // Only retry if we haven't exceeded max retries and auth error handling succeeds
        if (retryCount < MAX_RETRIES) {
          const shouldRetry = await this.handleAuthError(error);
          if (shouldRetry) {
            this.addClientLog(
              `Retrying connection (attempt ${retryCount + 1}/${MAX_RETRIES})`,
              "info",
            );
            return this.connectToServer(undefined, retryCount + 1);
          }
        }

        if (this.is401Error(error)) {
          // Don't set error state if we're about to redirect for auth
          this.connectionStatus = "error";
          this.addClientLog(
            "Authentication failed, connection terminated",
            "error",
          );
          return;
        }
        throw error;
      }
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      this.addClientLog(`Connection failed: ${errorMessage}`, "error");
      console.error(e);
      this.connectionStatus = "error";
    }
  }

  /**
   * Get the current transport used for MCP communication
   */
  getTransport(): Transport | undefined {
    return this.clientTransport;
  }

  /**
   * Get the MCP proxy server URL
   */
  getMCPProxyServerUrl(): URL {
    return this.mcpProxyServerUrl;
  }

  /**
   * Prepares request options with appropriate timeouts
   * @param options User-provided options or undefined
   * @returns Request options with defaults applied
   */
  private prepareRequestOptions(
    options?: RequestOptions & { suppressToast?: boolean },
  ): RequestOptions {
    const abortController = new AbortController();

    // Prepare MCP Client request options with appropriate timeouts
    const mcpRequestOptions: RequestOptions = {
      signal: options?.signal ?? abortController.signal,
      resetTimeoutOnProgress:
        options?.resetTimeoutOnProgress ??
        resetRequestTimeoutOnProgress(this.inspectorConfig),
      timeout:
        options?.timeout ?? getMCPServerRequestTimeout(this.inspectorConfig),
      maxTotalTimeout:
        options?.maxTotalTimeout ??
        getMCPServerRequestMaxTotalTimeout(this.inspectorConfig),
    };

    // Configure progress handler to reset timeouts if enabled
    if (mcpRequestOptions.resetTimeoutOnProgress) {
      mcpRequestOptions.onprogress = this.handleProgressNotification;
    }

    return mcpRequestOptions;
  }

  /**
   * Handle progress notifications
   * @param params Progress parameters
   */
  private handleProgressNotification = (params: Progress): void => {
    this.addClientLog("Progress notification received", "debug");
    if (params.progress) {
      this.addClientLog(`Progress: ${params.progress}`, "debug");
    }
  };

  /**
   * Format and display error toast message
   * @param error The error that occurred
   */
  private showErrorToast(error: unknown): void {
    const errorString = error instanceof Error ? error.message : String(error);
    this.addClientLog(`Request error (toast shown): ${errorString}`, "error");
    toast({
      title: "Error",
      description: errorString,
      variant: "destructive",
    });
  }

  /**
   * Make a request to the MCP server
   * @param request The request to send
   * @param schema Zod schema to validate the response
   * @param options Request options including timeout settings
   * @returns The validated response
   */
  async makeRequest<T extends z.ZodType>(
    request: ClientRequest,
    schema: T,
    options?: RequestOptions & { suppressToast?: boolean },
  ): Promise<z.output<T>> {
    // Log the request being made
    this.addClientLog(`Making MCP request: ${request.method}`, "debug");
    try {
      const mcpRequestOptions = this.prepareRequestOptions(options);

      try {
        // Execute the request
        const response = await this.request(request, schema, mcpRequestOptions);
        this.addClientLog(`MCP request successful: ${request.method}`, "info");
        this.addRequestHistory(request, response);
        return response;
      } catch (error) {
        // Handle request execution errors
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.addClientLog(
          `MCP request failed: ${request.method} - ${errorMessage}`,
          "error",
        );
        this.addRequestHistory(request, { error: errorMessage });
        throw error;
      }
    } catch (e: unknown) {
      // Handle outer errors and show toast if needed
      if (!options?.suppressToast) {
        this.showErrorToast(e);
      }
      throw e;
    }
  }

  /**
   * Create a request for argument completion
   * @param ref Reference to the resource or prompt
   * @param argName Name of the argument to complete
   * @param value Current value of the argument
   * @returns Client request object
   */
  private createCompletionRequest(
    ref: ResourceReference | PromptReference,
    argName: string,
    value: string,
  ): ClientRequest {
    return {
      method: "completion/complete",
      params: {
        argument: {
          name: argName,
          value,
        },
        ref,
      },
    };
  }

  /**
   * Handle unsupported completion method error
   * @param error The error from completion attempt
   * @returns Empty array as fallback
   */
  private handleUnsupportedCompletion(error: unknown): string[] {
    if (error instanceof McpError && error.code === ErrorCode.MethodNotFound) {
      this.completionsSupported = false;
      this.addClientLog(
        "Completions disabled - server does not support them",
        "warn",
      );
      return [];
    }

    // For other errors, show toast and rethrow
    const errorMessage = error instanceof Error ? error.message : String(error);
    this.addClientLog(`Completion request failed: ${errorMessage}`, "error");
    toast({
      title: "Error",
      description: errorMessage,
      variant: "destructive",
    });
    throw error;
  }

  /**
   * Handle completion requests for resources or prompts
   * @param ref Reference to the resource or prompt
   * @param argName Name of the argument to complete
   * @param value Current value of the argument
   * @param signal Optional abort signal
   * @returns Array of completion strings
   */
  handleCompletion = async (
    ref: ResourceReference | PromptReference,
    argName: string,
    value: string,
    signal?: AbortSignal,
  ): Promise<string[]> => {
    // Early return if completions not supported
    if (!this.completionsSupported) {
      this.addClientLog("Completions not supported by server", "debug");
      return [];
    }

    try {
      // Create and execute completion request
      const request = this.createCompletionRequest(ref, argName, value);
      this.addClientLog(`Requesting completion for ${argName}`, "debug");

      const response = await this.makeRequest(request, CompleteResultSchema, {
        signal,
        suppressToast: true,
      });

      // Log results and return values
      const completionCount = response?.completion.values?.length || 0;
      this.addClientLog(
        `Received ${completionCount} completion suggestions`,
        "debug",
      );
      return response?.completion.values || [];
    } catch (error) {
      return this.handleUnsupportedCompletion(error);
    }
  };

  /**
   * List all tools available from the MCP server
   * @returns The tools response
   */
  async tools() {
    this.addClientLog("Listing available tools", "debug");
    const tools = await this.listTools();
    this.addClientLog(`Found ${tools.tools.length} tools`, "info");
    return tools;
  }

  /**
   * Disconnect from the MCP server
   */
  async disconnect() {
    this.addClientLog("Disconnecting from MCP server", "info");
    await this.close();
    this.connectionStatus = "disconnected";
    if (this.serverConfig.transportType !== "stdio") {
      const authProvider = new InspectorOAuthClientProvider(
        (this.serverConfig as HttpServerDefinition).url.toString(),
        this.serverConfig.transportType,
      );
      authProvider.clear();
      this.addClientLog("OAuth tokens cleared", "debug");
    }
    this.serverCapabilities = null;
    this.addClientLog("MCP client disconnected successfully", "info");
  }

  /**
   * Update the server capabilities
   * @param capabilities The new capabilities
   */
  async setServerCapabilities(capabilities: ServerCapabilities) {
    this.serverCapabilities = capabilities;
    this.addClientLog("Server capabilities updated", "debug");
  }

  async cleanup(): Promise<void> {
    this.addClientLog("Cleaning up MCP client", "info");
    await this.close();
  }
}
