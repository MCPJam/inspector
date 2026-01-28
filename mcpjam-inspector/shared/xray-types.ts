/**
 * X-Ray types for inspecting messages sent to AI models.
 *
 * These types are shared between server and client to ensure consistent
 * structure for X-ray events that capture what's sent to generateText/streamText.
 */

/**
 * Represents a single message in the model message format.
 * This is a simplified representation of ai-sdk's ModelMessage.
 */
export interface XRayModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
}

/**
 * Represents a tool definition sent to the model.
 */
export interface XRayToolDefinition {
  name: string;
  description?: string;
  parameters?: unknown;
}

/**
 * Model information in X-Ray events.
 */
export interface XRayModelInfo {
  id: string;
  provider: string;
}

/**
 * X-Ray log event capturing the full request context sent to AI models.
 */
export interface XRayLogEvent {
  /** Unique identifier for this event */
  id: string;
  /** ISO timestamp when the event was captured */
  timestamp: string;
  /** Event type - currently only 'ai-request' */
  type: "ai-request";
  /** Model being called */
  model: XRayModelInfo;
  /** Transformed messages sent to the model */
  messages: XRayModelMessage[];
  /** System prompt (if any) */
  systemPrompt: string | undefined;
  /** Tool definitions available to the model */
  tools: XRayToolDefinition[];
  /** Temperature setting (if specified) */
  temperature?: number;
  /** List of MCP servers selected for this chat */
  selectedServers: string[];
  /** Which code path was used */
  path: "streamText" | "mcpjam-backend";
}
