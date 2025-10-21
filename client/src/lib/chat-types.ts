export interface ContentBlock {
  id: string;
  type: "text" | "tool_call" | "tool_result" | "error";
  content?: string;
  toolCall?: ToolCall;
  toolResult?: ToolResult;
  timestamp: Date;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
  attachments?: Attachment[];
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  contentBlocks?: ContentBlock[];
  metadata?: MessageMetadata;
}

export interface Attachment {
  id: string;
  name: string;
  url: string;
  contentType: string;
  size?: number;
}

export interface ToolCall {
  id: string;
  name: string;
  parameters: Record<string, any>;
  timestamp: Date;
  status: "pending" | "executing" | "completed" | "error";
}

export interface ToolResult {
  id: string;
  toolCallId: string;
  result: any;
  error?: string;
  timestamp: Date;
  serverId?: string; // Server that executed the tool
}

export interface MessageMetadata {
  createdAt: string;
  editedAt?: string;
  regenerated?: boolean;
  tokens?: {
    input: number;
    output: number;
  };
}

export interface ChatState {
  messages: ChatMessage[];
  isLoading: boolean;
  error?: string;
  connectionStatus: "connected" | "disconnected" | "connecting";
}

export interface ChatActions {
  sendMessage: (content: string, attachments?: Attachment[]) => Promise<void>;
  editMessage: (messageId: string, newContent: string) => Promise<void>;
  regenerateMessage: (messageId: string) => Promise<void>;
  deleteMessage: (messageId: string) => void;
  clearChat: () => void;
  stopGeneration: () => void;
}

export interface MCPToolCall extends ToolCall {
  serverId: string;
  serverName: string;
}

export interface MCPToolResult extends ToolResult {
  serverId: string;
}

export type ChatStatus = "idle" | "typing" | "streaming" | "error";

export interface StreamingMessage {
  id: string;
  content: string;
  isComplete: boolean;
}
