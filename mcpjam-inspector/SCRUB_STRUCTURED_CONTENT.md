# Objective

Right now, all of the results from the tool call are exposed to the LLM. We want to remove `_meta` and `structuredContent` from the tool call for MCP apps only. The LLM should not be exposed to the LLM, but the inspector still needs those values to pass over to the UI widget.

# Requirements

- `_meta` and `structuredContent` are not exposed to the LLM
- They are still passed over to the inspector for UI hydration
- The removal of these two values only happens on MCP apps.

# Context

- @docs/contributing/mcp-apps-architecture.mdx
- MCPClientManager @sdk/src/mcp-client-manager/MCPClientManager.ts
- @mcpjam-inspector/apps-spec.mdx

# Ideas

We can scrub the `_meta` and `structuredContent` before it's exposed to the LLM in MCPCLientManager.ts on line 459, so it's not exposed to the LLM. However, when we stream text results back to the client, we can add the `_meta` and `structuredContent` back. We can then save the full tool call result somewhere to bring back to the client later.

Maybe we can do it in result.toUIMessageStreamResponse in mcpjam-inspector/server/routes/mcp/chat-v2.ts. We fetch the full tool call result from MCPClientManager and add it back here.

# Claude's plan

Here is Claude's plan:
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
Plan: Scrub \_meta and structuredContent from Tool Results for MCP Apps

Objective

Strip \_meta and structuredContent from MCP app tool call results before they reach the LLM, while preserving them for the UI. This only applies to MCP app tools
(identified by ui/resourceUri in tool metadata).

Approach

Use the Vercel AI SDK's toModelOutput on tool definitions to control what the LLM sees. The execute() return value goes to the UI stream unchanged; toModelOutput()
provides a scrubbed version for the LLM.

For the MCPJam-provided model path (manual message loop), scrub the serialized output field in tool result messages while preserving the full result for the UI.

Files to Modify

1.  sdk/src/mcp-client-manager/tool-converters.ts

Add two helper functions:

- isMcpAppTool(toolMeta) - checks if toolMeta["ui/resourceUri"] exists (flat format used by MCP apps spec)
- scrubMcpAppToolResult(result) - returns a shallow copy of CallToolResult with \_meta and structuredContent removed

Modify convertMCPToolsToVercelTools:

In the for loop over listToolsResult.tools, check if the tool is an MCP app using isMcpAppTool(toolDescription.\_meta). If so, attach toModelOutput to the tool definition
that strips \_meta and structuredContent.

The runtime signature for toModelOutput is ({ toolCallId, input, output }) => LanguageModelV2ToolResultOutput (confirmed from AI SDK source at
node_modules/ai/src/prompt/create-tool-model-output.ts:24). The .d.ts types are slightly misaligned, so we'll cast as needed.

2.  sdk/src/mcp-client-manager/index.ts

Export isMcpAppTool and scrubMcpAppToolResult from the barrel.

3.  sdk/src/index.ts

Re-export isMcpAppTool and scrubMcpAppToolResult from the SDK's public API.

4.  mcpjam-inspector/shared/http-tool-calls.ts

This handles the MCPJam-provided model path where tools are executed manually via executeToolCallsFromMessages.

After getting the tool result and serializing it into output, check if the tool is an MCP app (using clientManager.getAllToolsMetadata(serverId) + isMcpAppTool). If so,
create a scrubbed version of the result and re-serialize it as llmOutput. Use llmOutput in the output field of the tool result message (sent to LLM backend), while keeping
the full result field unchanged (for UI).

5.  mcpjam-inspector/server/routes/mcp/chat-v2.ts

Change tool-output-available emission (line 238) to prefer item.result over item.output:

output: item.result ?? item.output ?? item.value

This ensures the frontend receives the full tool result (with \_meta and structuredContent) while the message history sent to the LLM backend contains the scrubbed output.

6.  sdk/src/mcp-client-manager/MCPClientManager.ts

Update/remove the TODO comments at lines 459-460.

Data Flow After Changes

streamText path (lines 273-309 of chat-v2.ts)

1.  getToolsForAiSdk() -> convertMCPToolsToVercelTools() adds toModelOutput to MCP app tools
2.  execute() returns full CallToolResult -> UI receives full data via tool-output-available
3.  AI SDK calls toModelOutput() -> LLM receives scrubbed result (no \_meta/structuredContent)

MCPJam-provided model path (lines 52-262 of chat-v2.ts)

1.  executeToolCallsFromMessages() calls tool.execute() -> full result
2.  Scrubbed version serialized into output field (for LLM backend via messageHistory)
3.  Full result preserved in message object
4.  chat-v2.ts emits tool-output-available with item.result -> UI receives full data

Verification

1.  Build the SDK and inspector: npm run build in both sdk/ and mcpjam-inspector/
2.  Start the inspector and connect to an MCP app server (one with ui/resourceUri in tool metadata)
3.  Trigger a tool call and verify:

- The LLM response doesn't reference structuredContent or \_meta data
- The UI widget renders correctly (receives structuredContent for hydration)

4.  Verify regular (non-MCP-app) tools are unaffected
