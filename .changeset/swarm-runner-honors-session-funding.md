---
"@mcpjam/inspector": patch
---

The swarm runner now runs free starter conversations on MCPJam's money, and one session's spend cap no longer ends starter sessions in the same run.

- **Funding per session.** A runner with `INSPECTOR_SERVICE_TOKEN` set advertises `swarm-admission-v1`. The backend then decides who pays for each session at launch and returns it on the create and claim responses. A starter session's host steps, and its target's setup turn, claim `billingFeature: "swarm_starter"` with the run, target and session they belong to, so they ride the platform rail. The claim is added on the MCPJam-hosted rail only, never on a BYOK or harness turn. Credit sessions bill exactly as before, and so does every session on a runner without the token.
- **A starter session that reaches its included limit** ends as its own outcome, `budget_truncated`. It is recorded as a failed attempt with that code, not as a success. Its transcript is still graded and counted in findings. It is not an account limit, so it never opens the credits dialog or stops the rest of the run.
- **Spend caps are scoped to credit sessions.** When a credit session hits the organization's spend cap, the runner stops the remaining credit sessions and leaves the starter sessions running. A run with no starter sessions still stops as a whole, as before.
