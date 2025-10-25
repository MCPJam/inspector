# Rebuilding the LLM playground 
The existing LLM playground works but there is a lot of tech debt. The tech debt stemmed from back when we were using Mastra, then did the migration over to using Vercel AI-SDK. The implementation is a mess, and we'd like to re-write the entire playground. This will help us better support MCP-UI and OpenAI apps SDK in the playground too. 

## Existing LLM playground 
To build a new playground, you have to understand some background with the existing playground. The existing playground has a frontend (`client/src/components/ChatTab.tsx`), a backend that runs the LLM and streams text (`server/routes/mcp/chat.ts`), and a `useChat` hook (`client/src/hooks/use-chat.ts`). The new playground will have the same structure, but without our custom hook, and using native Vercel ai-sdk functions instead of custom implementations. 

<!-- Failed to upload "Screenshot 2025-10-24 at 3.41.37 PM.png" -->

Check out [our docs](https://docs.mcpjam.com/contributing/playground-architecture) in detail to understand the full implementation.

## What do we need to build 
We're rebuilding the LLM playground. Ideally it has the same exact behavior as the existing LLM playground, just with a cleaner implementation. We want to use the native functions in Vercel AI SDK. 

- [ ] Create a new tab, `ChatTabV2.tsx`. Feature flag it so we don't show it to prod yet.
- [ ] Create a new backend endpoint in the Hono server. See the streamText with Hono backend example. 
- [ ] Create the UI for chat. The UI should contain the `useChat` hook. We should also look at the possibility of using [Assistant UI](https://www.assistant-ui.com/docs/api-reference/integrations/vercel-ai-sdk#useverceluseassistantruntime) for chat UI. 
- [ ] Handle elicitation support in chat. 
- [ ] Implement MCP-UI and OpenAI apps SDK.
- [ ] Handle free chat. This involves work in the MCPJam backend. 
- [ ] Enforce human in the loop tool approvals (nice to have) 
- [ ] Have multiple chat sessions (nice to have) 

## Resources
- [streamText with Hono backend](https://ai-sdk.dev/cookbook/api-servers/hono)
- [useChat hook](https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat)
- [Chatbot with AI SDK](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot)

## How to contribute
If this is your first time, please read our [CONTRIBUTING.md](https://github.com/MCPJam/inspector/blob/main/CONTRIBUTING.md) file. 

## Coordination and Expectations 
@matteo8p will be leading the project. We will coordinate work on this issue thread. We are expecting to get this project done end of next week. Expectations are that PR's get in SLA 1 day. 