export interface ExpectedToolCall {
  toolName: string;
  arguments: Record<string, any>;
}

export interface TestTemplate {
  title: string;
  query: string;
  runs: number;
  expectedToolCalls: ExpectedToolCall[];
}

export interface AvailableTool {
  name: string;
  description?: string;
  inputSchema?: any;
}
