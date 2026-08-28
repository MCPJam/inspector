---
"@mcpjam/inspector": patch
"@mcpjam/cli": patch
"@mcpjam/sdk": patch
---

A failed server-connection attempt no longer burns the retry that would fix it

Re-opening a `/connect/server/<token>` link said "This link has already been used" and left the user nowhere, each dead attempt held one of the account's five concurrent-connection slots for a full hour, and the CLI had no way to release one. Five interrupted attempts locked the account out of connecting that server at all — and cloud evals then failed with "requires OAuth authentication" against a server the UI showed as configured.

**The link is single-use for a reason, and that reason is intact.** The first page load trades the handoff token for a continuation cookie, and clears the token's digest in the same write, so a leaked URL is spent the moment it is opened. What was missing is that the cookie the claim set is *still in the browser that claimed it*: the page had a valid credential in hand and never looked. It now falls back to `/state` when a claim reports the token spent, and resumes the flow if that cookie still resolves to a request. A browser with no cookie — someone else's, a fresh one, a link-preview crawler — gets the same used-link screen as before, because for that browser the link genuinely is gone.

**Re-authorizing now supersedes.** `createRequest` with `reauthorize: true` already bypassed dedupe; it now also cancels the live requests for the same owner, project, and URL before the cap is counted — in the same serializable mutation, so the freed slots are visible to the check that would otherwise refuse. The retry that recovers a stuck server can no longer be the thing the cap blocks. Scope stays exact: `projectId` is part of the index tuple, so a project-less request only supersedes other project-less ones, and requests for other servers still count against the cap normally.

**`mcpjam cloud projects servers connect-cancel --request <id>`** exposes the cancel that the backend, the REST route, and the SDK client already implemented. It is idempotent, and `connect` now prints it beside `connect-status` whenever it hands back a request id. The matching `cancel_project_server_connection` operation is a direct agent tool — cancelling stops an authorization nobody completed, so it needs no approval, and an agent that hits `ACTIVE_REQUEST_LIMIT` can now clear the abandoned requests itself.
