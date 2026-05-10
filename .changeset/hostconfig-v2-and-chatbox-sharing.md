---
"@mcpjam/inspector": patch
---

HostConfig v2: send hostConfig payload from inspector for direct chats, add HostConfigEditor component and v2 types, and switch reads to v2 (Phase 3). Replace server sharing with chatbox sharing. Add suite-level Default Execution Config editor for evals. Identify PostHog by actor key instead of auth state. Refactor: unify chat config boundaries by removing ChatTabV2 override props and nesting EvalChatHandoff fields under executionConfig.
