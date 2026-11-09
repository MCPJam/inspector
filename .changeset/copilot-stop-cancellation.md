---
"@mcpjam/inspector": patch
"@mcpjam/chat-ui": patch
---

Cancel hosted harness requests durably when Stop is pressed, including pending tool approvals and delayed continuations.

Keep combined chat trace prompts and tool results attached to stable turn and call identities after approval history is rebuilt. Omit per-step message details when their original boundaries are unavailable.
