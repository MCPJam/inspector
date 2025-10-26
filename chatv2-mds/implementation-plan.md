# Chat Playground V2 Engineering Plan

## Objective

Rebuild the LLM playground using Vercel AI SDK primitives while maintaining feature parity with the existing experience, adding groundwork for MCP-UI, OpenAI Apps SDK, elicitation, and future enhancements. Delivery target: end of next week.

## Milestones

1. **Scaffolding & Feature Flag (Day 0-1)**
   - Introduce `ChatTabV2` alongside existing tab, controlled by config flag/env toggle.
   - Establish shared types/state contracts between UI and backend.
2. **Backend Streaming Endpoint (Day 1-3)**
   - Implement Hono route wrapping `streamText` with provider abstractions for MCP/OpenAI/free chat.
   - Wire tool approval and elicitation flow shapes the frontend can consume.
3. **Frontend UI & State (Day 2-4)**
   - Build chat surface with `useChat` (or Assistant UI evaluation) handling message history, tool calls, attachments.
   - Support multiple chat sessions groundwork.
4. **Integrations & Enhancements (Day 4-5)**
   - MCP-UI + OpenAI Apps SDK wiring, free chat mode, optional human-in-loop approvals.
5. **Validation & Launch Prep (Day 5)**
   - Automated + manual testing, analytics checkpoints, rollout checklist.

## Workstreams

### 1. Scaffolding & Feature Flagging

- Create `client/src/components/ChatTabV2.tsx` exporting a feature-flagged tab.
- Add flag control (e.g., `ENABLE_CHAT_V2` env) surfaced through config module consumed by tab registration logic.
- Mirror routing/layout structure of `ChatTab.tsx`, reusing shared styles/components where feasible.
- Audit shared types in `shared/` to ensure request/response contracts align with backend expectations; add new types if needed.

### 2. Backend API (`server/routes/mcp/chat-v2.ts`)

- Duplicate existing chat route as reference; create new Hono route mounted under `/mcp/chat-v2`.
- Use Vercel AI SDK `streamText` with provider-specific loaders (OpenAI, MCP adapter, free chat provider).
- Define streaming payload schema (messages, tool calls, approvals). Expose metadata required by frontend (session id, tool status, tokens?).
- Implement elicitation support: map backend prompts/responses to structured messages flagged for UI handling.
- Add guard rails for feature flag; default 404 if disabled.
- Ensure logging/metrics align with existing observability (likely hooking into any middleware).

### 3. Frontend Chat UI

- Evaluate `useChat` vs Assistant UI integration; spike quickly to decide.
- Implement conversation list + active thread view enabling multiple sessions (foundation even if hidden behind secondary flag).
- Handle streaming updates, tool call events, human approval prompts, free chat mode toggles.
- Migrate shared UI chunks (message bubbles, tool call renderers) into reusable components to avoid regression.
- Provide fallback to old tab until parity validated.

### 4. Integrations & Tooling

- MCP-UI: integrate UI components to surface MCP tool outputs; ensure MCP session handshake flows from existing backend adapters.
- OpenAI Apps SDK: wire runtime to support app manifests, tool definitions, and required auth.
- Free chat: update backend + UI to allow selecting provider; ensure session state is stored accordingly.
- Human-in-loop approvals: design UI modal + backend handshake (optional flag until polished).
- Ensure configuration is centralized (e.g., provider selection) to avoid duplication.

### 5. Testing & QA

- Unit tests for new backend route (mock providers, test streaming chunks, error flows).
- Component tests for `ChatTabV2` covering message rendering, tool approval UI, session switching.
- Integration test hitting `/mcp/chat-v2` with simulated provider responses (Vitest + supertest or e2e harness).
- Update Playwright scripts to cover new tab (behind flag using env override).
- Manual validation checklist: parity scenarios, regressions on existing tab, multi-session smoke.

### 6. Rollout & Deployment

- Document flag controls and env usage (`docs/playground-v2.md`).
- Add monitoring hooks (logs, analytics events) to compare usage/performance vs old tab.
- Plan phased enablement: dev → staging → beta users → full rollout.
- Define rollback steps (toggle flag, revert route binding).

## Open Questions / Follow-Ups

- Decision timeline for `useChat` vs Assistant UI; spike required early.
- Clarify requirements for human approval enforcement (blocking vs advisory?).
- Determine persistence layer for multiple chat sessions (local storage, backend store?).
- Confirm telemetry/analytics expectations for new endpoint.
- Align on MCP free chat backend dependencies (coordination with backend team).

## Next Steps

1. Kick off feature-flag scaffolding PR.
2. Schedule architecture sync with @matteo8p for UI framework decision.
3. Create tracking tickets per workstream with owners and deadlines.
