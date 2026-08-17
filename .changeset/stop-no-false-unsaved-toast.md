---
"@mcpjam/inspector": patch
---

Pressing Stop no longer claims the reply could not be saved.

Pressing Stop during a turn on a resumed chat-history thread produced an error toast about ten seconds later: "This reply couldn't be saved to your chat history. It's still visible here." Nothing had gone wrong — the user had cancelled the turn on purpose — and it fired on every Stop, on both the chat tab and the playground.

Three correct behaviors combined into a wrong one. The AI SDK has no distinct "aborted" status: on abort it sets `status: "ready"` and returns (`ai/dist/index.mjs`, in `makeRequest`'s catch — `if (isAbort || err.name === "AbortError") { this.setStatus({ status: "ready" }); return null; }`). The server deliberately does not persist an aborted turn — `onFinishEngine` in `server/utils/mcpjam-stream-handler.ts` gates the persist and the `data-persist-receipt` write on `runSucceeded && !aborted` — so no receipt is emitted and the session version never moves. And `useResumedThreadPersistence`, seeing a normal end-of-stream with no receipt, falls back to watching the session subscription for a version bump, which is exactly the deploy-skew case it was built for. The bump never came, the 10 s window expired, and the hook reported a dropped write.

`useChatSession` now records whether the turn was aborted and exposes it as `consumeTurnAborted()`, alongside the existing `consumePersistReceipt()` and with the same consume-once semantics. It is sourced from the AI SDK's own `onFinish({ isAbort })` rather than from the Stop button, so an abort from any source counts and every finished turn overwrites a stopped predecessor. `useResumedThreadPersistence` checks it right after the send baseline is consumed and returns: no reconcile, no toast, no rail refresh and no read-marking, because an aborted turn wrote nothing for the rail to learn. Any receipt that raced the abort is consumed and discarded so it cannot be handed to the next turn.
