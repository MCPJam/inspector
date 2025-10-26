# Chat Playground V2 – Hono Server Implementation Plan

This plan details backend work required to ship the new chat experience in the Hono API. It complements `engineering-spec.md` by diving into route wiring, provider/runtime abstractions, tool orchestration, telemetry, and testing specific to the server stack.

## Goals

- Serve `/mcp/chat-v2` behind a feature flag returning Vercel AI SDK streaming responses.
- Support OpenAI + MCP backends, including free chat provider selection.
- Surface tool call + elicitation events to the client with optional approval gating.
- Maintain backward compatibility; no changes to existing `/mcp/chat` endpoint until rollout is complete.

## Milestones

1. **Scaffold & Flags** (Day 0)
2. **Core Streaming Route** (Day 1-2)
3. **Provider Abstractions & Tool Wiring** (Day 2-3)
4. **Elicitation + Approvals** (Day 3-4)
5. **Observability & Error Handling** (Day 4)
6. **Tests & Verification** (Day 4-5)

## Work Breakdown

### 1. Scaffold & Flags

- Add `server/config/feature-flags.ts` exporting `serverFeatureFlags`.
- Ensure server bootstrap (likely `server/index.ts`) loads this module once so env reads are cached.
- Update `server/routes/mcp/index.ts` to conditionally mount `/chat-v2` when `serverFeatureFlags.chatV2` is true.
- Provide local `.env.example` entries (`ENABLE_CHAT_V2`, `ENABLE_CHAT_V2_APPROVALS`).

### 2. Core Streaming Route

Create `server/routes/mcp/chat-v2.ts`:

- Instantiate `Hono` router; export as default.
- Validate request body against `zod` schema referencing shared types (`shared/chat-v2.ts`). Respond 400 on validation errors.
- Compute `sessionId` (use provided value or `crypto.randomUUID`).
- Determine provider factory by `provider` field; default to MCP runtime when unspecified.
- Invoke `streamText`:
  ```ts
  const result = await streamText({
    model: provider.chat(body.model),
    messages: body.messages.map(mapClientMessageToAiSdk),
    tools: toolset.tools,
    temperature: body.temperature,
    maxSteps: toolset.maxSteps,
    onStepFinish: toolset.handleStep,
    onError: toolset.handleError,
  });
  ```
- Return `result.toDataStreamResponse` with headers `{ "x-chat-session-id": sessionId }`.
- Guard entire handler with try/catch; on failure, log + return `c.json({ error: "..." }, 500)`.

### 3. Provider Abstractions & Tool Wiring

Create utilities under `server/utils/chat-v2`:

- `mapClientMessageToAiSdk(message: ChatV2Message): Message`.
- `getProvider(body, sessionId)` returning union of:
  - OpenAI via `createOpenAI({ apiKey })`.
  - Anthropic / other providers as needed.
  - `createMcpRuntime({ selectedServers, requestId: sessionId })` for MCP backends.
- `buildToolset({ provider, sessionId, enableApprovals, selectedServers })`:
  - Merge MCP tools using existing `executeToolCallsFromMessages` / manager utilities.
  - Include OpenAI App SDK tools (if specified) pulling definitions from manifest store.
  - Return object with `tools`, `maxSteps`, `handleStep`, `handleError` callbacks.
- Ensure `handleStep` publishes `ChatV2StreamEvent` payloads via `writer.write(...)` (DataStreamWriter from ai SDK). Include `tool_call`, `tool_result`, `trace_step` for parity with V1.

### 4. Elicitation + Approvals

- Extend shared types with `ChatV2StreamEvent` union including elicitation.
- On backend, when `event.type === "elicitation"`, serialize as SSE `event.writer.write({ type: "elicitation", prompt })`.
- Respect `serverFeatureFlags.chatV2Approvals`:
  - If true, mark tool calls `status: "requires-approval"` and suspend execution until client replies with `elicitationResponse` or approval payload.
  - Reuse existing `runBackendConversation` or tool approval helpers where possible.
- Implement `applyElicitationResponse(body, runtime)` that forwards user response to MCP backend (e.g., via `runBackendConversation`).

### 5. Observability & Error Handling

- Add structured logging using existing logger (search for `console.error("[mcp/chat]` pattern) and replicate with `[mcp/chat-v2]` tag.
- Emit metrics hooks if available (e.g., `posthog?.captureServer` or Prometheus counters) for:
  - Requests started/completed.
  - Tool calls executed/approved/failed.
- Distinguish user errors vs server errors via error codes (e.g., `ERR_INVALID_MODEL`, `ERR_PROVIDER_UNAVAILABLE`). Return in `X-Error-Code` header and JSON payload.
- Add timeout handling: cancel provider stream when exceeding max duration (use AbortController).

### 6. Tests & Verification

- **Unit (Vitest)**
  - `server/utils/chat-v2.test.ts`: map message conversion, toolset builder behavior (approval toggles).
  - Feature flag tests ensuring route mounts only when enabled (mock env).
- **Integration**
  - Use `vitest` + `@hono/node-server` to POST `/mcp/chat-v2` with mocked provider (stub `createOpenAI`) and assert SSE stream chunks.
  - Simulate tool call event to verify `requires-approval` flow.
- **Manual Smoke**
  - Run with `ENABLE_CHAT_V2=true` locally; use `curl` or Postman to confirm streaming.
  - Validate fallback (flag false) returns 404.

## Delivery Checklist

- [ ] Flags wired + documented.
- [ ] `/mcp/chat-v2` route behind flag, using `streamText`.
- [ ] Provider/tool utilities implemented with tests.
- [ ] Elicitation + approval flows handled.
- [ ] Logs/metrics added.
- [ ] Integration + unit tests passing.
- [ ] Docs updated (`docs/contributing/playground-architecture.mdx`).

## Risks & Mitigations

- **Provider inconsistencies**: wrap provider creation with try/catch; default to human-readable error if env missing.
- **Tool approval deadlocks**: set timeout + fallback to cancel tool call with error event.
- **Regression on legacy `/chat`**: keep existing route untouched; run regression tests before enabling flag.

## Coordination

- Backend owner: assign engineer (TBD) to lead.
- Collaborate with frontend owner to confirm SSE payload shape before merging.
- Align with infra/ops for new env vars and monitoring dashboards.
