# Drive a Playground session browser from a coding agent

Use `mcpjam cloud sessions send --browser` for model-driven browsing and `mcpjam cloud sessions browser <verb>` for direct commands against the same persistent browser. API transcripts open view-only in the Playground; the owning user can take over the live browser and select **Resume agent**.

## Setup and first turn

Use `mcpjam cloud login` or `MCPJAM_API_KEY`. For a preview deployment, set `MCPJAM_API_URL` to its Inspector `/api/v1` endpoint. Its backend must have desktop admission configured, and the serving Inspector replica needs `HOSTED_BROWSER_TOOLS_ENABLED=1` plus a positive browser exposure verdict. Existing organization browser/computer and browser workspace gates still apply.

```sh
mcpjam cloud sessions send --project PROJECT_ID --model PROVIDER/MODEL \
  --server SERVER_ID --tool-mode auto --browser --browser-mode allowlist \
  --browser-origins https://example.com --message "Open the site and read its heading" \
  --idempotency-key first-browser-turn
mcpjam cloud sessions show --session SESSION_ID
mcpjam cloud sessions trace --session SESSION_ID
mcpjam cloud sessions browser observe --session SESSION_ID --mode screenshot --download ./shots
mcpjam cloud sessions browser navigate https://example.com --session SESSION_ID --command-id navigate-home
mcpjam cloud sessions send --session SESSION_ID --browser --message "Read the page again" --idempotency-key second-turn
mcpjam cloud sessions browser close --session SESSION_ID
```

The initial policy and profile are fixed. `--browser-profile` selects a saved profile at creation. Current host restrictions and a pinned `read_only` tool mode can further narrow permissions. Continuations opt in with `--browser`; omitted attachment does not wake a metered desktop.

`cloud sessions browser open --project PROJECT_ID --browser-mode read_only --idempotency-key empty-session` creates a durable API shell without a model call. Supply its model and server configuration on the first send. Only the public `sessionId` is accepted by commands; returned wire UUIDs are for minted links.

## Retry, takeover, and evidence

Keep a stable idempotency key for each model-turn intent and a stable command ID for each direct action. Active duplicate requests do not re-run; interrupted commands return an unknown outcome to inspect. A pre-model capacity refusal can be retried with the same key after closing a desktop. The default per-user cap is two conversation desktops across projects. Eval and swarm admission remains separate.

Human takeover parks browser model calls for at most 15 seconds across the turn. A timeout returns `browser_in_use`. On release, the tool returns a fresh observation; the stale blocked action is never replayed. Observe before deciding what to do next.

Evidence is stored per tool call or direct command, keyed by turn, tool-call ID, and step. Responses and transcripts contain pointers, not raw screenshot pixels. Trace and artifact reads resolve stored URLs; unavailable evidence is reported explicitly. Conversation boxes do not record video. Eval and swarm recording remains explicitly enabled.

## Additive rollout

Deploy the backend additions before Inspector, then SDK/CLI/MCP consumers. Ship the Playground restoration changes before advertising the new links broadly. The legacy `/browser-sessions/*`, SDK `browserSession`, and `browser --cloud` entry points remain temporarily for rolling compatibility. Their deletion is a separate drain-confirmed change; new conversation browsers cannot be driven through that legacy identity lookup.

Validate against a preview backend before release: desktop boot/sleep/wake, same-user takeover, saved profiles, cap refusal and lease reuse, screenshot downloads, and eval/swarm recording require real infrastructure. Local unit tests do not establish these runtime checks.
