# Issue

Currently, the /chat API is poorly written. There is duplicated data being streamed back to the client. The chat logic is over complicated. Break it down into helper functions for simplicity.

## Requirements

The chat functionality must support MCP tool calls and elicitation. It must stream result data back to the client side. There should be no duplicates. It should show tool loading states and completion.

## Files

- server/routes/mcp/chat.ts (API Endpoint)
- client/src/hooks/use-chat.ts (Chat hook)

## Instructions

Propose how to fix for approval before implementing the fix.
