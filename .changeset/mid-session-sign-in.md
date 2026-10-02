---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
"@mcpjam/inspector": minor
---

Mid-session sign-in ("lazy authentication"): servers that let a client connect anonymously and ask for sign-in only when a protected call needs it now work end to end.

- **SDK.** A refused call becomes a typed `AuthChallengeSignal`: an HTTP 401 with or without `WWW-Authenticate`, a 403 `insufficient_scope`, or a ChatGPT-style `isError` result carrying `_meta["mcp/www_authenticate"]`. It is recognized on `tools/call`, `resources/read` and `prompts/get`, over Streamable HTTP and legacy SSE, and read with `extractAuthChallenge(error)` or `parseToolResultAuthChallenge(result)`. Tool `securitySchemes` are captured and resolved with OpenAI's inheritance rule. `decideAuthChallengeAction` applies a host's policy.
- **Per-host settings.** Four optional `mcpProfile` knobs: `unauthorizedChallenge`, `unauthorizedChallengeTrigger`, `toolResultAuthChallenge` and `toolResultAuthChallengeTrigger`. An absent knob is the spec default. The Claude, Claude Code and ChatGPT presets set values from each vendor's published documentation.
- **Inspector.** The Tools tab, Playground, Resources, Prompts, chat and widgets show a **Connect** card. Nothing navigates until a trusted click. Only `readOnlyHint` tools run again on their own; anything else asks "Run again?". A replay is bound to the OAuth flow that started it, a shared hosted credential is never replaced, and existing tokens are kept until the new sign-in succeeds. Inspector commands and agents get a typed `authorization_required` error.
- **Step-up.** A bare `insufficient_scope` (no scope, no metadata pointer) now re-authorizes with the previously requested scopes plus discovery's `scopes_supported`. Hosted step-up writes its redirect marker and replays.
- **CLI.** A 401 challenge fails with `AUTH_REQUIRED`, and a 403 with `INSUFFICIENT_SCOPE`. Both carry the parsed challenge and an `mcpjam oauth login` hint. `tools call` adds `_authChallenge` beside a `_meta`-challenged result. `mcpjam test` records the challenge and prints the sign-in command.
- **API.** The v1 API reports `AUTH_REQUIRED` (HTTP 403) with `details.authChallenge`. A completed tool result can carry `authChallenge` beside it.
- **Readiness.** An opt-in, credential-free lazy-auth probe (`--lazy-auth-probe`, `--claim lazy-authentication`) grades Claude's and OpenAI's lazy-auth behavior and re-discovers metadata from the protected call's challenge. `check_host_compatibility` keeps tool `securitySchemes` and warns about hosts that ignore `_meta` challenges.
