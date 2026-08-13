---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Stop reporting an upstream MCP auth rejection as a 500 on the public v1 API.

`UPSTREAM_AUTH_FAILED` landed as an internal Inspector `ErrorCode` — the target MCP server refused the credentials MCPJam presented, which the hosted routes now answer with a 403 instead of burying in the INTERNAL_ERROR bucket. `INTERNAL_TO_V1_CODE` had no entry for it, and `mapInternalCode` defaults to `INTERNAL_ERROR`, so the public surface kept telling API callers that MCPJam had broken when the user's own server had refused us. It now collapses onto `FORBIDDEN` (403): the public union has no upstream-auth member, and FORBIDDEN carries the property that matters to a caller — retrying with a different MCPJam credential will not help.

This is the second code to fall into that default (`ENVIRONMENT_REVISION_CONFLICT` was the first), because the test meant to catch it could not: `mapInternalCode` always returns a valid public code, so asserting the result is a member of the union passes for an unmapped code too. The contract suite now pins the unmapped set explicitly, so adding an `ErrorCode` without deciding its public mapping fails instead of silently widening the INTERNAL_ERROR bucket. That check documents six codes as a known, accepted gap — `BILLING_LIMIT_REACHED` (the public union has no billing member), plus `XAA_CONNECTION_NOT_CONFIGURED`, `TASK_NOT_FOUND`, `TASKS_UNSUPPORTED`, `CHATBOX_ACCESS_DENIED` and `CHATBOX_ACCESS_STALE`, whose reachability from `/api/v1` is unconfirmed and whose mappings are contract decisions rather than mechanical ones.

`mcpjam-backend` keeps a byte-identical copy of this map in `convex/publicApi/contract.ts` until its pinned SDK version includes the subpath, so it needs the same entry and fixture line to stay in step.
