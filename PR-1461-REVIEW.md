# PR #1461 Review: MCPJam Hosted Multi-Tenancy

## Summary

This PR replaces the singleton `MCPClientManager` with a per-session store so MCPJam
Inspector can be hosted as a multi-tenant service. The approach is architecturally sound
for a first pass — the `ClientManagerStore` abstraction cleanly branches between local
(singleton) and hosted (session-keyed) modes, and the changes are reasonably contained.

However, there are several **security gaps and architectural issues** that should be
addressed before deploying this to production with real users.

---

## What the PR Does Well

1. **Clean abstraction boundary.** `createClientManagerStore()` returns either a
   `SingletonClientManagerStore` or `SessionClientManagerStore` based on `HOSTED_MODE`,
   keeping the local-dev path completely unchanged.

2. **Session lifecycle management.** TTL-based eviction (default 30 min), LRU capacity
   eviction (default 1000 sessions), and graceful server disconnection on eviction are
   all implemented correctly.

3. **Backward compatibility.** When `HOSTED_MODE` is `false`, behavior is identical to
   the current singleton pattern. The `resolveRequestSessionId()` returns `undefined` in
   non-hosted mode, and `SingletonClientManagerStore` ignores the session key entirely.

4. **Good test coverage for new code.** The `client-manager-store.test.ts` and
   `client-manager-session.test.ts` tests cover the key paths: singleton reuse, session
   isolation, TTL eviction, LRU eviction, and session resolution priority.

5. **Event bus session filtering.** Both `rpcLogBus` and `progressStore` are updated to
   carry `sessionId` in events and filter on subscribe/query, preventing cross-tenant
   data leakage at the application layer.

---

## Critical Issues

### 1. Shared Session Token Defeats Per-User Auth

**Severity: Critical**

The existing `sessionToken` (generated once by `generateSessionToken()` at startup) is a
**process-wide singleton**. In hosted mode, every user who loads the page gets the same
token injected into their HTML:

```
server/app.ts:227-228
const token = getSessionToken();
const tokenScript = `<script>window.__MCP_SESSION_TOKEN__="${token}";</script>`;
```

This means:
- All tenants share the same API auth token
- The token provides zero tenant isolation — it only gates "can you talk to this server
  process at all"
- Any user can extract the token from the page source and use it to make API requests
  with a different session cookie

**In local mode** this was fine — the token prevented other local websites from accessing
your inspector. **In hosted mode**, every user is a legitimate token holder, so the token
is effectively public.

**Recommendation:** In hosted mode, the session auth token should be per-session, or
(better) replaced with a real authentication layer (OAuth, JWT, etc.) before the session
middleware. The `mcpjam_session_id` cookie alone is not authentication — it's a session
correlation ID.

---

### 2. Session Fixation via `x-mcpjam-session-id` Header

**Severity: High**

The `resolveRequestSessionId()` function gives priority to the
`x-mcpjam-session-id` header over cookies:

```
server/middleware/client-manager-session.ts:17-18
const headerSessionId = normalizeSessionId(
  c.req.header(MCPJAM_SESSION_HEADER_NAME),
);
if (headerSessionId) return headerSessionId;
```

Since the header accepts any string matching `/^[A-Za-z0-9._:-]{1,128}$/`, an attacker
who knows (or guesses) another user's session ID can set the header and access that
user's `MCPClientManager` instance, including all their connected MCP servers.

Attack scenarios:
- Session IDs from cookies are UUIDs (128-bit), so direct guessing is hard
- But if session IDs are ever logged, leaked in error messages, or exposed via other
  endpoints, this becomes exploitable
- The header bypass makes cookie-based security properties (HttpOnly, SameSite) irrelevant

**Recommendation:** Either remove the header-based session ID (use cookies only), or
require the header to be cryptographically signed/authenticated. If the header is needed
for API clients, require it to be paired with a per-session secret.

---

### 3. No Authentication Layer for Hosted Mode

**Severity: High**

The PR adds session isolation but no authentication. Currently:
- Anyone who can reach the hosted URL gets a session
- There's no user identity, no login, no access control
- The STDIO transport block and HTTPS enforcement are the only hosted-mode security gates

This means the hosted inspector is an open service where anyone can connect arbitrary MCP
servers to your infrastructure.

**Recommendation:** Add authentication before deploying. Even a simple approach works:
- Gate access behind an auth proxy (e.g., Cloudflare Access, OAuth2 Proxy)
- Or add a login flow that issues per-user session tokens
- At minimum, add an `MCPJAM_ACCESS_KEY` env var that must be provided to create a session

---

### 4. `rpcLogBus` Buffer Not Session-Scoped at Storage Level

**Severity: Medium**

The `rpcLogBus.publish()` still stores events keyed by `serverId` alone:

```
// Current (unchanged by PR):
const buffer = this.bufferByServer.get(event.serverId) ?? [];
buffer.push(event);
this.bufferByServer.set(event.serverId, buffer);
```

Session filtering only happens at read time in `subscribe()` and `getBuffer()`. If two
sessions use the same `serverId` string (e.g., both name their server "my-server"),
their RPC logs are mixed in the same buffer array. While the filter prevents
cross-session reads in normal operation, this has two consequences:

- **Memory waste**: Logs from evicted sessions accumulate in buffers indefinitely since
  there's no cleanup when sessions are evicted
- **Defense in depth**: A bug or missed filter application could leak cross-tenant logs

**Recommendation:** Key the buffer by `${sessionId}::${serverId}` (like `progressStore`
already does with `getScopedServerKey()`), and add buffer cleanup when sessions are
evicted from the store.

---

### 5. No Memory Cleanup for Evicted Sessions in Event Buses

**Severity: Medium**

When `SessionClientManagerStore` evicts a session, it calls
`disconnectManager(manager)`. But neither `rpcLogBus` nor `progressStore` are notified
of the eviction:

- `rpcLogBus.bufferByServer` keeps growing with logs from dead sessions
- `progressStore` uses `getScopedServerKey()`, so entries persist under
  `${sessionKey}::${serverId}` keys until the 5-minute stale cleanup fires

Over time with many sessions, this is a memory leak. With 1000 concurrent sessions
each connecting to multiple MCP servers, the rpcLogBus buffer could grow unbounded.

**Recommendation:** Add a `clearSession(sessionId)` method to both `rpcLogBus` and
`progressStore`, and call it from the eviction path in `SessionClientManagerStore`.

---

## Moderate Issues

### 6. Duplicated Store Setup in `app.ts` and `index.ts`

The `createClientManagerStore({ ... })` block — including the `managerFactory` closure
with `rpcLogger` and `progressHandler` wiring — is copy-pasted identically into both
`app.ts` and `index.ts` (~40 lines). This is a maintenance hazard:

- Changes to one will need to be mirrored in the other
- The two files already diverge (e.g., `index.ts` has no `progressHandler` in the
  current singleton, but `app.ts` does) — the PR actually _fixes_ this divergence by
  adding `progressHandler` to `index.ts`, but the duplication makes future drift likely

**Recommendation:** Extract the store creation into a shared factory function, e.g.,
`server/services/create-manager-store.ts`, imported by both entry points.

---

### 7. Synchronous Sweep in Request Hot Path

`SessionClientManagerStore.getManager()` calls `this.maybeSweep(now)` on every request.
While the sweep is throttled by `sweepIntervalMs`, when it does fire, it iterates all
entries synchronously:

```typescript
for (const [key, entry] of this.entries.entries()) {
  if (now - entry.lastAccessedAt >= this.ttlMs) {
    this.evictSession(key, "ttl_expired");
  }
}
```

`evictSession` calls `void disconnectManager(entry.manager)` (fire-and-forget async).
At 1000 sessions, this is a synchronous loop that may trigger many concurrent disconnect
operations. This won't block the event loop for long, but the burst of disconnect I/O
could cause issues.

**Recommendation:** Move sweeping to a `setInterval` timer (like `progressStore` already
does for its cleanup) instead of running it inline on requests.

---

### 8. Missing Session Scoping in Several Routes

The PR updates `servers.ts` (`/rpc/stream`) and `tasks.ts` (`/progress`, `/progress/all`)
to pass `sessionId`. However, there are other routes that access the shared stores or
expose data that should be checked:

- **`servers.ts:239`** — The `/rpc/stream` SSE endpoint calls
  `c.mcpClientManager.listServers()` to get server IDs. Since `mcpClientManager` is now
  session-scoped, this is correct. But the `rpcLogBus.getBuffer()` and
  `rpcLogBus.subscribe()` calls now need `{ serverIds, sessionId }` — the PR does update
  these, which is good.

- **Progress SSE streaming** — There doesn't appear to be a progress SSE stream endpoint
  (progress is polled via POST). If one is added later, it would need the same
  session-scoping treatment.

- **Elicitation routes** (`elicitation.ts`) — These maintain their own per-connection
  `sessionId` via `crypto.randomUUID()` which is independent of the mcpjam session ID.
  This is fine for now but could be confusing — there are now two different "session ID"
  concepts in the codebase.

---

### 9. `evictIfAtCapacity` Only Evicts One Entry

When at capacity, `evictIfAtCapacity()` removes only the single oldest session:

```typescript
private evictIfAtCapacity(): void {
  if (this.entries.size < this.maxEntries) return;
  // ... find and evict oldest
}
```

If a burst of new sessions arrives simultaneously (e.g., during a traffic spike), each
new session only evicts one old session. This is correct behavior, but with the sweep
also running, there could be timing issues where the capacity check passes right before
a sweep would have freed space.

This is minor — just noting it as a potential edge case under heavy load.

---

## Minor Issues

### 10. Cookie Not Partitioned

The session cookie doesn't include the `Partitioned` attribute (CHIPS). If the hosted
inspector is ever embedded in an iframe on another site, the cookie would be shared
across first-party contexts. Adding `Partitioned` would future-proof this.

### 11. No `Secure` Flag When Behind Reverse Proxy Without `x-forwarded-proto`

The `isSecureRequest()` function checks `x-forwarded-proto` and falls back to URL
protocol. Railway and similar platforms typically set this header, but if the proxy
doesn't, the cookie would be set without `Secure`, allowing it to be sent over HTTP.

### 12. `HOSTED_MCPJAM.md` Should Not Be Committed

The design doc `HOSTED_MCPJAM.md` at the repo root describes internal goals, limitations,
and requirements. It should either be in a `docs/` directory or not committed to the repo
at all (keep it in the issue/PR description instead).

---

## Verdict

The core architecture (session-keyed manager store with TTL/LRU eviction) is a solid
foundation for multi-tenancy. The code quality is good, tests cover the important paths,
and backward compatibility is maintained.

**However, deploying this as-is to a public hosted environment would be premature.**
The critical gap is the lack of any real authentication — the shared session token and
unauthenticated session ID header mean there's no meaningful access control between
tenants. The memory cleanup gaps are manageable short-term but will cause issues at scale.

### Recommended Priority Order

1. **Add authentication** (OAuth, JWT, or access-key gating) — blocks deployment
2. **Remove or authenticate `x-mcpjam-session-id` header** — session fixation risk
3. **Per-session or per-user auth tokens** — replace shared `sessionToken`
4. **Session-scoped rpcLogBus storage + cleanup on eviction** — memory leak
5. **Extract shared store factory** — maintainability
6. **Move sweep to timer** — performance under load
