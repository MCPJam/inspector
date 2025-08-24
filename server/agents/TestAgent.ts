import { Agent } from "@mastra/core/agent";

export type ToolCallRecord = {
  toolName: string;
  args: unknown;
};

export type ToolUsageResult = {
  toolCalled: boolean;
  toolCalls: ToolCallRecord[];
  text?: string;
};

export type TestAgentInit = {
  name?: string;
  description?: string;
  model: unknown;
  tools?: unknown;
  defaultGenerateOptions?: unknown;
};

export class TestAgent extends Agent {
  constructor(init: TestAgentInit) {
    super({
      name: init.name ?? "test-agent",
      description:
        init.description ??
        "TestAgent for MCP E2E tool-call detection. Uses tools when helpful.",
      instructions:
        "You are a test agent used to validate whether tools are invoked for a prompt. If tools are available and helpful, use them.",
      model: init.model as any,
      tools: init.tools as any,
      defaultGenerateOptions: init.defaultGenerateOptions as any,
    });
  }

  async wasToolCalled(
    messages: string | any[] | undefined,
    options?: Record<string, unknown>,
  ): Promise<ToolUsageResult> {
    const result = await this.generate(messages as any, {
      ...(options as any),
      toolChoice: (options as any)?.toolChoice ?? "auto",
    });

    const toolCalls: ToolCallRecord[] = (result.toolCalls ?? []).map(
      (tc: any) => ({ toolName: tc.toolName, args: tc.args }),
    );

    return {
      toolCalled: toolCalls.length > 0,
      toolCalls,
      text: result.text,
    };
  }
}

export default TestAgent;
