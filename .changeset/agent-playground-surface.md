---
"@mcpjam/inspector": minor
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
---

Add the agent Playground surface: drive a conversation from the API, CLI or MCP
and read the telemetry it produced.

Machine callers could already LAUNCH work that produces sessions (eval runs,
journey runs) and read the result afterwards. None of them could do what a human
does in the Playground: send one message, see which tools the model picked and
what the servers actually returned, and decide the next message from that. Three
routes are that loop, plus the metadata a participant in a conversation cannot
see — per-tool-call latency, token usage, raw wire values.

- `POST /v1/chat-sessions/messages` (`send_chat_message`, `mcpjam cloud sessions
  send`) runs one turn against a project's servers and returns the reply, the
  joined tool calls with their raw scrubbed input/output, this turn's spans, and
  usage. Omit `sessionId` to start a session; pass the one it returns to
  continue.
- `GET /v1/chat-sessions/{id}` (`get_chat_session`, `cloud sessions show`)
  returns metadata plus a bounded window of raw messages at their ABSOLUTE
  transcript indices — the same indices spans reference.
- `GET /v1/chat-sessions/{id}/trace` (`get_chat_session_trace`, `cloud sessions
  trace`) returns per-turn spans, incrementally: the latest turn by default,
  older turns by selector, summaries with `includeSpans=false`.

Spend safety is the design rather than a mitigation. `idempotencyKey` is
REQUIRED, and a Convex turn lease is claimed before any model call, so a client
timeout-and-retry replays the completed turn instead of paying twice and two
concurrent turns on one session are refused rather than interleaved. Tool
effects are a separate axis: `toolMode` defaults to `read_only` (only tools
annotated `readOnlyHint: true` are advertised, a policy the host applies rather
than a guarantee it can verify), and `auto` is documented as able to cause real
external side effects. Configuration pins on the first turn — a continuation
that resends it is refused rather than silently repinning — and only sessions
this surface created may be continued through it, so an API caller can never
append into a human's live Playground session.

Reads report unavailability rather than emptiness throughout: an unreadable
transcript returns `transcriptUnavailable` with a null `messageCount`, and an
unreadable span blob returns `spansUnavailable` instead of an empty array,
because "made no calls" and "could not fetch" lead to opposite conclusions.
