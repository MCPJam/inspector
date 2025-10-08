/**
 * Type definitions for OpenAI Apps SDK integration
 *
 * These types define the window.openai API that OpenAI Apps SDK components
 * expect to be available in their iframe context.
 *
 * @see https://developers.openai.com/apps-sdk
 */

/**
 * Display modes for OpenAI components
 */
export type DisplayMode = "inline" | "fullscreen";

/**
 * Theme options
 */
export type Theme = "light" | "dark";

/**
 * Safe area insets (for mobile devices)
 */
export interface SafeAreaInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * Safe area configuration
 */
export interface SafeArea {
  insets: SafeAreaInsets;
}

/**
 * User agent information
 */
export interface UserAgent {
  platform?: string;
  browser?: string;
  version?: string;
}

/**
 * Completion request for LLM
 */
export interface CompletionRequest {
  prompt: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Completion response from LLM
 */
export interface CompletionResponse {
  content: {
    type: "text";
    text: string;
  };
  model: string;
  role: "assistant";
}

/**
 * Follow-up message request
 */
export interface FollowupMessage {
  prompt: string;
}

/**
 * Display mode change request
 */
export interface DisplayModeRequest {
  mode: DisplayMode;
}

/**
 * Display mode response
 */
export interface DisplayModeResponse {
  mode: DisplayMode;
}

/**
 * Main OpenAI Apps SDK API
 *
 * This interface is exposed as `window.openai` (and `window.webplus` for compatibility)
 * inside OpenAI component iframes.
 */
export interface OpenAIWidgetAPI {
  // ===== Data Properties (Immutable) =====

  /**
   * Input parameters passed to the tool
   */
  toolInput: Record<string, any>;

  /**
   * Output result from the tool execution
   */
  toolOutput: any;

  // ===== Layout Properties (Mutable) =====

  /**
   * Current display mode
   */
  displayMode: DisplayMode;

  /**
   * Maximum height for the component (in pixels)
   */
  maxHeight: number;

  /**
   * Current theme
   */
  theme: Theme;

  /**
   * Locale for internationalization
   */
  locale: string;

  /**
   * Safe area information (for mobile)
   */
  safeArea: SafeArea;

  /**
   * User agent information
   */
  userAgent: UserAgent;

  /**
   * Persisted widget state
   */
  widgetState: any;

  // ===== Methods =====

  /**
   * Persist component state
   *
   * @param state - State to persist
   */
  setWidgetState(state: any): Promise<void>;

  /**
   * Call an MCP tool
   *
   * @param toolName - Name of the tool to call
   * @param params - Parameters to pass to the tool
   * @returns Tool execution result
   */
  callTool(toolName: string, params?: Record<string, any>): Promise<any>;

  /**
   * Send a follow-up message to continue the conversation
   *
   * @param message - Message to send (string or object with prompt)
   */
  sendFollowupTurn(message: string | FollowupMessage): Promise<void>;

  /**
   * Request a display mode change
   *
   * @param options - Display mode options
   * @returns New display mode
   */
  requestDisplayMode(options: DisplayModeRequest): Promise<DisplayModeResponse>;

  /**
   * Call LLM for completion (stub implementation)
   *
   * @param request - Completion request
   * @returns Completion response
   */
  callCompletion(request: CompletionRequest): Promise<CompletionResponse>;

  /**
   * Stream completion from LLM (stub implementation)
   *
   * @param request - Completion request
   * @returns Async iterator of completion chunks
   */
  streamCompletion(
    request: CompletionRequest,
  ): AsyncGenerator<CompletionResponse>;
}

/**
 * PostMessage event types for iframe communication
 */
export type PostMessageEventType =
  | "openai:setWidgetState"
  | "openai:callTool"
  | "openai:callTool:response"
  | "openai:sendFollowup"
  | "openai:requestDisplayMode"
  | "webplus:set_globals";

/**
 * Base postMessage event
 */
export interface BasePostMessageEvent {
  type: PostMessageEventType;
}

/**
 * Set widget state event
 */
export interface SetWidgetStateEvent extends BasePostMessageEvent {
  type: "openai:setWidgetState";
  toolId: string;
  state: any;
}

/**
 * Call tool event
 */
export interface CallToolEvent extends BasePostMessageEvent {
  type: "openai:callTool";
  requestId: string;
  toolName: string;
  params: Record<string, any>;
}

/**
 * Call tool response event
 */
export interface CallToolResponseEvent extends BasePostMessageEvent {
  type: "openai:callTool:response";
  requestId: string;
  result?: any;
  error?: string;
}

/**
 * Send followup event
 */
export interface SendFollowupEvent extends BasePostMessageEvent {
  type: "openai:sendFollowup";
  message: string;
}

/**
 * Request display mode event
 */
export interface RequestDisplayModeEvent extends BasePostMessageEvent {
  type: "openai:requestDisplayMode";
  mode: DisplayMode;
}

/**
 * Set globals event (for component initialization)
 */
export interface SetGlobalsEvent extends BasePostMessageEvent {
  type: "webplus:set_globals";
  detail: {
    globals: {
      displayMode: DisplayMode;
      maxHeight: number;
      theme: Theme;
      locale: string;
      safeArea: SafeArea;
      userAgent: UserAgent;
    };
  };
}

/**
 * Union of all postMessage events
 */
export type PostMessageEvent =
  | SetWidgetStateEvent
  | CallToolEvent
  | CallToolResponseEvent
  | SendFollowupEvent
  | RequestDisplayModeEvent
  | SetGlobalsEvent;

/**
 * Extend Window interface to include OpenAI API
 */
declare global {
  interface Window {
    /**
     * OpenAI Apps SDK API (primary name)
     */
    openai: OpenAIWidgetAPI;

    /**
     * Webplus API (legacy/compatibility name)
     */
    webplus: OpenAIWidgetAPI;

    /**
     * Debug function to check OpenAI API availability
     */
    __checkOpenAI?: () => OpenAIWidgetAPI | undefined;
  }
}
