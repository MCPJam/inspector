---
"@mcpjam/inspector": patch
---

D8c: the chat-session chain derivation worker

The backend can now be asked for a session's user-value chain (D8b), but
nothing produced one. This is the consumer: an internal service-token doorbell
at `/api/internal/chat-stage/derivation-requested`, and a pass that claims owed
work from the backend's queue, normalizes the session's evidence through the
shared SDK adapter, derives once through `deriveStageResults`, and applies the
result under the backend's generation + source-stamp compare-and-set.

Four rules the pass exists to hold:

- **It spends nothing.** There is no model call anywhere in it. It consumes the
  deterministic criteria and whatever judge verdict already exists; it never
  asks for one. A derivation pass that could trigger a judge would turn every
  re-mark into a bill.
- **Superseded is success.** A no-op apply means someone asked for better work
  while this was in flight. It is not retried and not reported as a failure —
  the newer generation is already pending and will be claimed on its own.
- **Unreadable evidence fails rather than deriving.** A chain built on a
  missing envelope is six `notMeasured` rows that look exactly like a session
  which genuinely captured nothing, and an operator cannot tell those apart.
  `evidence_unavailable` can be retried; a fabricated blank chain cannot be
  un-published.
- **Nothing free-text is stored.** Failures are reported as one of the
  backend's closed error codes. The one thing an exception message from a
  transcript walker reliably contains is detail from the transcript.

The doorbell's body carries no selector at all, deliberately: the pass claims
from the backend's own queue, so what gets derived is decided by the backend's
lifecycle rather than by whatever rang the bell. A ring is a wake-up, not an
instruction.

Inert until the backend's producers land and `CHAT_STAGE_DERIVATION_ENABLED` is
on: with the feature off the claim route 404s, which the pass reads as
`disabled` and returns a benign no-op.
