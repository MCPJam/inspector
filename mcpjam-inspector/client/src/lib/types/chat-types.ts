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
