---
"@mcpjam/inspector": patch
---

Chats running on your own keys share one AI-key policy check per user and project, so many open chats or compare models no longer run out the backend's 60-reads-a-minute budget and fail with ai_key_policy_unavailable.
