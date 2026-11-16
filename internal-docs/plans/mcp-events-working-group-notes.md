# MCP Events: notes for the Triggers & Events working group

These came out of implementing the draft at [`28ec35e`](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/28ec35e905daa241f019981e2836b4a02f1c0368/docs/design-sketch-proposal.md) in MCPJam. They are for raising upstream, not for changing in MCPJam.

## 1. The first challenge can't be verified by `X-MCP-Subscription-Id`

*Webhook Security → Signature scheme* says `X-MCP-Subscription-Id` exists "so the receiver can select the correct secret without parsing the body". But the verification challenge arrives inside `events/subscribe`, before the server has returned the subscription id. So a receiver that keys secrets by subscription id can't know which secret signed the first POST. The same is true for any event the server delivers before its subscribe response.

MCPJam works around this by giving every subscription its own callback path (`/i/{inboxId}/s/{slotId}`) and selecting the secret by path (contract C3). Any receiver can do the same, but the draft should say so.

**Suggested draft change.** Receivers SHOULD select the secret by callback URL (a per-subscription URL, or a URL-embedded routing key). `X-MCP-Subscription-Id` is then routing metadata for everything after the subscribe response, and the draft stops describing it as the secret selector for the first challenge.

## 2. Capability placement

The draft and OpenAI both use top-level `capabilities.events`. The official TypeScript client 2.0.0 parses server capabilities with closed `z.object` schemas and silently drops any top-level key it doesn't know. So a client built on it can't see the declaration without capturing the raw handshake, which MCPJam does (contract C10).

**For the group.** If the extension moves under `capabilities.extensions["…"]` before acceptance, name the id now so clients can alias it. Or ask SDKs to preserve unknown capability keys, which would make experimental capabilities visible everywhere.

## 3. Smaller observations

- **`refreshBefore` absence.** The draft says it is always present and nullable. MCPJam rejects an absent value rather than reading it as "no expiry", because a client that did so would stop refreshing a subscription the server is about to reap. Stating this explicitly would help SDK authors.
- **Private callbacks versus local receivers.** Rejecting private destinations by default (a SHOULD) conflicts with every local development receiver. The draft's "unless explicitly configured" is right; an example configuration would help server SDKs.
