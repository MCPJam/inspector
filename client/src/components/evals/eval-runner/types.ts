export interface ExpectedToolCall {
  toolName: string;
  arguments: Record<string, any>;
}

export interface TestTemplate {
  title: string;
  query: string;
  runs: number;
  expectedToolCalls: ExpectedToolCall[];
  isNegativeTest?: boolean; // When true, test passes if NO tools are called
  scenario?: string; // Description of why app should NOT trigger (negative tests only)
  expectedOutput?: string; // The output or experience expected from the MCP server
}

export interface AvailableTool {
  name: string;
  description?: string;
  inputSchema?: any;
}
