---
"@mcpjam/inspector": patch
---

Swarm host steps now reserve realistic credit holds, and a busy spending reservation is retried instead of failing the session.

- **Output ceiling.** A swarm's host turns and its setup turn now send `maxOutputTokens: 16384` (the eval runner's per-step cap) instead of leaving the backend to size the ceiling to the model. The backend reserves credits against that ceiling before every step, and a reasoning model's default ceiling of 32,768 made one Haiku step hold about 18 credits, so a free organization's daily credits read as spent after a few concurrent sessions. The hold is now about half that. Scenario simulations are unchanged and still send no ceiling, and so are harness hosts: the harness model broker clamps `max_tokens` without touching the model's thinking budget, so a ceiling below its own 64,000 default could make every thinking turn fail. A non-reasoning model's backend default is 8,192, which the ceiling doubles; the Inspector has no way to tell the two apart, so making it an upper bound on that default is a backend change.
- **Busy reservations wait.** A `503 spending_reservation_busy` means MCPJam's own reservation lost its concurrency race and committed nothing, so the model was never called. The runner's admission retry now waits and asks again, sharing the session's existing wait budget, instead of ending the session.
