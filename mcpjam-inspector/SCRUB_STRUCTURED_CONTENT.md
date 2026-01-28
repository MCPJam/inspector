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

