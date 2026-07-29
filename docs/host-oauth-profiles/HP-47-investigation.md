# HP-47 — OAuth / connection behavior for ALL catalog clients

**Status:** desk research complete for the fields that desk research can settle.
**Date:** 2026-07-29
**Predecessor:** HP-17 (validated 9 third-party claims; 4 were false because they came
from lore rather than evidence).
**Successor dependency:** HP-44 golden-trace harness — see [Unverifiable](#unverifiable).

---

## 0. Provenance rules used in this document

Every cell in every table below carries exactly one status marker:

| Marker | Meaning |
| --- | --- |
| `verified` | Read in first-party source code, an official vendor doc, or a vendor-published machine-readable artifact (e.g. a Client ID Metadata Document served by the vendor). A citation (file+line, or exact URL) is given. |
| `refuted` | Positive evidence found that the claim is FALSE. Citation given. |
| `unverifiable` | Could not confirm. A **specific reason** is stated. This is a success, not a gap in effort. |

Two additional conventions, adopted because HP-17 failed on exactly this axis:

* **Evidence class.** Each citation is tagged `E1` (upstream first-party source or
  official vendor doc), `E2` (a live wire capture recorded in *this* repo with a
  provenance comment), or `E3` (third-party report — **never** sufficient for
  `verified`; recorded only as a lead).
* **Line numbers.** Line numbers for files inside this repo are exact. Line numbers for
  remote files fetched over HTTP are marked `~` (approximate — upstream `main` drifts,
  and the fetch layer summarizes). Where a remote line number could not be established
  with confidence, the citation gives **file URL + symbol name** instead of a fabricated
  number. A wrong line number cited as exact is the same failure mode as a wrong claim.

**Rules that were not broken:** no client's behavior was inferred from another client's
behavior. No behavior was inferred from a blog post. No behavior was inferred from the
MCP specification — spec-compliance is not evidence of implementation. Where the only
available signal was a third-party bug report or forum post, the field is
`unverifiable` and the report is listed as a lead only.

---

## 1. Host-count discrepancy: the ticket says 9, the catalog has 16

The HP-47 ticket text says "9 hosts". **That is stale.** The canonical catalog is
`HOST_TEMPLATE_IDS` in
[`sdk/src/host-config/templates/seed-host-template.ts:235-252`](../../sdk/src/host-config/templates/seed-host-template.ts)
and it currently has **16** ids:

```
mcpjam, claude, claude-code, chatgpt, mistral, goose, slack, cursor,
codex, copilot, vscode, agentcore, n8n, perplexity, cline, notion
```

This constant is documented in-file as "the single source of truth reused by the SDK
platform `create_host` operation, the server v1 route's request validator, and the CLI
`hosts templates` lister" (same file, lines 229-234). All 16 are covered below. The
ticket's "9" should be corrected rather than the catalog trimmed.

**Second, larger discrepancy — worth flagging to the team:** the host templates carry
**no OAuth data at all**. `SeededHostConfigInput` models the MCP `initialize` handshake
(`clientCapabilities`, `mcpProfile.initialize`, `hostContext`, MCP Apps surface) and
nothing else. A grep for `oauth` across `seed-host-template.ts` returns zero hits. So
every field HP-47 asks for is **new data** that does not yet have a home in the host-config
schema. Deciding where these land (a new `oauthProfile` block on the host template? a
separate registry?) is a design question this investigation surfaces but does not answer.

---

## 2. Summary table

Columns: **RI** = `sendsResourceIndicator` (RFC 8707) · **Spec** = `oauthSpecVersion` ·
**PV** = `protocolVersionPinning` · **DCR** = DCR identity (client_name / redirect URI / UA) ·
**Auth** = auth model.

| # | Client | RI | Spec | PV | DCR identity | Auth model |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | **mcpjam** | `verified` — sends on both | `verified` — 4 machines: 03-26 / 06-18 / 11-25 / 2026-07-28 | `verified` — per-machine pinned; default `2025-11-25` | `verified` — `MCPJam - <serverName>` | `verified` — OAuth2 + DCR + CIMD + XAA |
| 2 | **claude** (claude.ai / Desktop / mobile / Cowork) | **`refuted`** — prior claim "omits `resource`" is FALSE; Claude sends it on **both** | `verified` — 2025-11-25 (RFC 9728 PRM ladder) | `unverifiable` | `verified` — redirect `https://claude.ai/api/mcp/auth_callback`; client_name `unverifiable` | `verified` — 6 modes incl. DCR, CIMD, static headers, none |
| 3 | **claude-code** | **`refuted`** — same shared infra sends `resource` | `verified` — 2025-11-25 | `unverifiable` for HTTP header; `verified` `2025-11-25` in `initialize` (E2 probe) | `verified` — CIMD: name `Claude Code`, redirects `http://localhost/callback` + `http://127.0.0.1/callback` | `verified` — OAuth2 public client via CIMD, PKCE S256 |
| 4 | **chatgpt** | **`refuted`** — prior claim "omits `resource`" is FALSE; appends to **both** | `verified` — 2025-11-25 (PRM required) | `unverifiable` | `verified` — redirect `https://chatgpt.com/connector/oauth/{callback_id}`; client_name `unverifiable` | `verified` — DCR **or** CIMD (`none` / `private_key_jwt`) |
| 5 | **mistral** (Le Chat) | `unverifiable` | `unverifiable` — docs say "OAuth 2.1" only | `verified` `2025-11-25` in `initialize` (E2 probe) | `unverifiable` | `verified` — OAuth 2.1 + DCR |
| 6 | **goose** | `verified` — sends on authorize + token + refresh (100% from `rmcp` 2.2.0); value = server URL | `verified` — OAuth layer is RFC 9728 PRM (2025-06-18+) **while the MCP layer is 2025-03-26** — split-revision client | `verified` — **hard-pinned single value `2025-03-26`**, no negotiation list (E1 source + E2 probe agree) | `verified` — CIMD-first (`https://goose-docs.ai/oauth/client-metadata.json`), `client_name` `goose`, redirect `127.0.0.1:{eph}/oauth_callback`, UA `goose/{ver}` (reaching AS `unverifiable`) | `verified` — headers/API-key **first**, OAuth only as a 401 fallback |
| 7 | **slack** (Slackbot MCP Client) | `unverifiable` | `unverifiable` | `verified` `2025-06-18` in `initialize` (E2 probe) | `verified` — CIMD: name `Slack`, redirect `https://oauth2.slack.com/external/auth/callback`, auth method `none` | `verified` — 4 modes: Slack identity, none, DCR, manual OAuth |
| 8 | **cursor** | `unverifiable` | `unverifiable` — no PRM mention in docs | `unverifiable` | `verified` — redirects `https://www.cursor.com/agents/mcp/oauth/callback` + `http://localhost:8787/callback`; client_name `unverifiable` | `verified` — DCR **or** static `CLIENT_ID`/`CLIENT_SECRET` |
| 9 | **codex** | `verified` — authorize + token + refresh (`rmcp` 3.0.0-beta.3), **plus** an optional second user-configured `resource` on authorize only | `verified` — RFC 9728 PRM + path-aware ladder (via `rmcp`) | `verified` — **default preference `2025-06-18`** (prior claim upheld); `2026-07-28` exists behind an **off-by-default** feature flag. "No 2024-11-05" `unverifiable` | `verified` — `client_name` `"Codex"`; redirect `127.0.0.1:{eph}/callback/{hash}`; **UA `codex-mcp-client/{ver}` — prior "sends no UA" claim `refuted`** | `verified` — OAuth2 + real DCR (no CIMD); headers/bearer take precedence |
| 10 | **copilot** (M365) | `unverifiable` | `verified` — RFC 9728 PRM + RFC 8414 AS metadata required | `unverifiable` | `unverifiable` — redirect handled opaquely by Enterprise token store | `verified` — Entra SSO / DCR / OAuth2 / none. **API key NOT supported for MCP plugins** |
| 11 | **vscode** | `verified` — sends on both, on all 3 flows; value = **PRM `resource`**, not server URL; omitted if PRM absent | `verified` behaviorally — RFC 9728 PRM, path-aware, 3-rung AS ladder (2025-06-18+ shape); **no literal revision constant exists** | `verified` — **pinned** `2025-11-25`; header sent **only** on OAuth discovery, never on MCP traffic | `verified` — `client_name` = `Visual Studio Code` (official) / `Code - OSS` (OSS build); 4 registered redirect URIs; **UA `Visual Studio Code/<version>`** | `verified` — OAuth 2.1 + PKCE S256 + DCR (public), + device code, + static headers, + XAA/ID-JAG |
| 12 | **agentcore** | `unverifiable` | `unverifiable` | **`refuted`** — negotiates 4 versions, does not pin | `unverifiable` — no DCR on the outbound leg | `verified` — none / OAuth 2LO+3LO / IAM SigV4 / API key |
| 13 | **n8n** | `verified` — **client-authored**, on authorize + token + refresh | `verified` — hand-rolled RFC 9728 + 8414 + 7591 + 8707 | `verified` — **negotiated, not pinned** (1 repo hit, a test mock) | `verified` — `client_name` = `n8n`; redirect = `<instance>/rest/oauth2-credential/callback` (hosted HTTPS, deployment-specific); UA `unverifiable` | `verified` — prior claim CONFIRMED: MCP OAuth2 + DCR (default on) + bearer/header/multi-header. `x-consumer-api-key` **`refuted`** — 0 occurrences in repo |
| 14 | **perplexity** | `unverifiable` | `unverifiable` | `verified` `2025-06-18` in `initialize` (E2 probe) | `unverifiable` | `unverifiable` — help-center article returns HTTP 403 to automated fetch |
| 15 | **cline** | `verified` (**inherited** from SDK 1.29.0) — sent iff server publishes PRM | `verified` (inherited) — SDK supports `2025-11-25` … `2024-10-07` | `verified` — **negotiated, not pinned**; zero hardcoded occurrences in the Cline repo | `verified` — `client_name` = `Cline`; loopback **port-scan** `127.0.0.1:1456-1461/mcp/oauth/callback`; UA `unverifiable` | `verified` — OAuth2 + PKCE + DCR (public client), remote transports only; **stdio explicitly excluded**; + static headers |
| 16 | **notion** | `unverifiable` | `unverifiable` | `unverifiable` — template value is a self-declared placeholder | `unverifiable` | `verified` — OAuth (DCR-dependent) **or** header-based API key / bearer |

---

## 3. Per-client evidence

### 3.1 mcpjam (this repo — first-party)

MCPJam Inspector's **production** OAuth is not the upstream TypeScript SDK's `auth()`.
It runs MCPJam's own state-machine runner: `mcpjam-inspector/client/src/lib/oauth/mcp-oauth.ts:1-3`
declares "Production OAuth implementation using the SDK state-machine runner with trace
support" and imports `runOAuthStateMachine` from `@mcpjam/sdk/browser` (same file, line 21).
That means the state machines below **are** the shipped client behavior, not a debugger-only
side path.

**`sendsResourceIndicator` — `verified`, E1.** Sent on both legs.

* `/authorize` — `sdk/src/oauth/state-machines/debug-oauth-2025-06-18.ts:1404-1407`:
  ```ts
  const authResourceParam = resolveResourceParameter();
  if (authResourceParam) {
    authUrl.searchParams.set("resource", authResourceParam);
  }
  ```
* `/token` — same file, `:1562-1565`:
  ```ts
  const tokenResourceParam = resolveResourceParameter();
  if (tokenResourceParam) {
    tokenRequestBody.set("resource", tokenResourceParam);
  }
  ```
* Notably the **2025-03-26** machine also sends it, sourced from the server URL rather than
  PRM: `sdk/src/oauth/state-machines/debug-oauth-2025-03-26.ts:1023-1025` and `:1169`. This is a
  deliberate MCPJam-specific choice (2025-03-26 predates resource indicators in MCP), and it
  is a **divergence from any real 2025-03-26 client** — worth calling out to whoever owns the
  fidelity of that machine.
* Resource-value policy is centralized in `sdk/src/oauth/resource-policy.ts` and
  `sdk/src/oauth/state-machines/shared/resource-indicator.ts`. The shared module enforces
  RFC 9728 §2 ("Protected Resource Metadata is missing its required `resource` identifier",
  `shared/resource-indicator.ts:59`) with three enforcement modes: `warn` | `reject` |
  `reject-rfc9728` (`:48`).

**`oauthSpecVersion` — `verified`, E1.** MCPJam implements **four** revisions concurrently,
one state machine each: `sdk/src/oauth/state-machines/debug-oauth-2025-03-26.ts`,
`debug-oauth-2025-06-18.ts`, `debug-oauth-2025-11-25.ts`, `debug-oauth-2026-07-28.ts`
(selected by `factory.ts`). This makes MCPJam the only catalog client that is not
single-revision, which is expected for an inspector.

**`protocolVersionPinning` — `verified`, E1.** Each machine hardcodes its own header value —
e.g. `debug-oauth-2025-06-18.ts:540` and `:592` set `"MCP-Protocol-Version": "2025-06-18"`;
`debug-oauth-2025-03-26.ts:492`/`:607` set `"2025-03-26"`; `debug-oauth-2025-11-25.ts:658`/`:710`
set `"2025-11-25"`. The default when unspecified is `2025-11-25`:
`sdk/src/oauth/browser-auth.ts:20`:
```ts
const LATEST_PROTOCOL_VERSION = "2025-11-25";
```

**DCR identity — `verified`, E1.** Three distinct client identities exist, which is itself a
finding (any golden trace must record *which* surface produced it):

| Surface | `client_name` | Citation |
| --- | --- | --- |
| Server connect flow | `MCPJam - <serverName>` | `mcpjam-inspector/client/src/lib/oauth/mcp-oauth.ts:2133` |
| Browser OAuth debugger (2025-03-26) | `MCP Inspector Debug Client` | `sdk/src/oauth/client-identity.ts:12` |
| Browser OAuth debugger (06-18 / 11-25 / 2026-07-28) | `MCPJam Inspector Debug Client` | `sdk/src/oauth/client-identity.ts:13-15` |
| SDK conformance runner | `MCPJam SDK OAuth Conformance` | `sdk/src/oauth/client-identity.ts:30, 41` |
| XAA (Cross-App Access) debugger | `MCPJam XAA Debugger` | `sdk/src/oauth/client-identity.ts:84` |
| XAA Connect | `MCPJam Connect` | `sdk/src/oauth/client-identity.ts:105` |

Redirect URI — `mcpjam-inspector/client/src/lib/oauth/constants.ts:45-54`, derived from
`window.location` with fallback `http://localhost:6274/oauth/callback`.
Client metadata also carries `client_uri: "https://github.com/mcpjam/inspector"` and
`logo_uri: "https://www.mcpjam.com/mcp_jam_2row.png"` (`mcp-oauth.ts:2134-2135`).
`token_endpoint_auth_method` is `client_secret_basic` when a secret is configured, else
`none` (`mcp-oauth.ts:2138`).

**User-Agent — `unverifiable`.** MCPJam's browser surface cannot set `User-Agent` (the
browser owns that header); server-proxied legs are not covered by this desk pass.

**Auth model — `verified`, E1.** Full OAuth2 + DCR, plus a CIMD path
(`DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL = "https://www.mcpjam.com/.well-known/oauth/client-metadata.json"`,
`sdk/src/oauth/client-identity.ts:7-8`), plus Enterprise-Managed Authorization / Cross-App
Access (ID-JAG, pinned to `draft-ietf-oauth-identity-assertion-authz-grant-04`,
`client-identity.ts:49-58`).

---

### 3.2 claude (claude.ai web, Claude Desktop, Claude mobile, Cowork)

All four surfaces share one backend. Official doc, verbatim: *"The same infrastructure backs
Claude.ai, Claude Desktop, Claude mobile, Claude Code, and Cowork."*
— <https://claude.com/docs/connectors/building/authentication> (E1)

**`sendsResourceIndicator` — `refuted`.** The prior belief that *"Claude Desktop omits the
RFC 8707 `resource` param"* is **FALSE**. Official Anthropic documentation states the
opposite explicitly:

> "Claude sends the [RFC 8707](https://www.rfc-editor.org/rfc/rfc8707) `resource` parameter
> on authorization and token requests, set to the canonical form of your MCP server URL —
> lowercase scheme and host, no trailing slash, no fragment, no default port — including any
> path component."

— <https://claude.com/docs/connectors/building/troubleshooting>, §"Authorization with the MCP
server failed" → "Audience mismatch" (E1)

Corroborated independently on the same page by the Entra ID section, which only makes sense
if a `resource` value is on the wire:

> "If your authorization server is Microsoft Entra ID and the token request fails with
> `AADSTS9010010` (sometimes surfaced as `invalid_target`), Entra is rejecting the `resource`
> value Claude sends because it does not match any Application ID URI registered on your app.
> Claude sets `resource` to your MCP server URL, including the path."

— same URL, §"Microsoft Entra ID rejects the resource value" (E1)

**`oauthSpecVersion` — `verified` (2025-11-25), and this `refutes` the prior belief that
claude.ai web implements the older 2025-03-26 spec.** Three independent signals on official
pages, all E1:

1. Every normative spec link on both pages points at
   `modelcontextprotocol.io/specification/**2025-11-25**/basic/authorization` (token
   requirements, token handling, authorization-code protection, token theft, localhost
   redirect URI risks, CIMD).
2. RFC 9728 Protected Resource Metadata discovery with the **path-aware ladder** — a
   2025-06-18-and-later behavior that does not exist in 2025-03-26:
   > "Claude can still infer the metadata location by probing your MCP server's origin:
   > `/.well-known/oauth-protected-resource/<your-mcp-path>` first, then
   > `/.well-known/oauth-protected-resource`."
3. It sends resource indicators at all (see above) — 2025-03-26 has no resource-indicator
   requirement.

AS-metadata fallback ladder, also `verified`: *"Claude tries `/.well-known/oauth-authorization-server`
(RFC 8414) first, then falls back to `/.well-known/openid-configuration`"*
(troubleshooting page, §"OAuth discovery fails").

**`protocolVersionPinning` — `unverifiable`.** Closed-source. Neither official page states an
`MCP-Protocol-Version` header value, and there is no public source for the claude.ai
connector backend. **Requires HP-44.**

**DCR identity — partially `verified`.**
* Redirect URI (hosted surfaces) — `verified`, E1: *"For the hosted Claude surfaces
  (Claude.ai web, Desktop, mobile, and Cowork), register the following redirect URI:
  `https://claude.ai/api/mcp/auth_callback`"* (authentication page, §"Callback URLs").
* `client_name` at DCR — `unverifiable`. Neither page states the literal string, and unlike
  Claude Code (below) the hosted surfaces do not publish a CIMD document at a fetchable URL.
  **Requires HP-44.**
* User-Agent — `unverifiable`. Not documented; closed-source backend.

**Auth model — `verified`, E1.** Six modes, from the authentication page's table:
`oauth_dcr` (RFC 7591), `oauth_cimd`, `oauth_anthropic_creds` (Anthropic-held client
credentials, gated behind `mcp-review@anthropic.com`), `custom_connection`, `static_headers`
(beta; admin-entered API key / bearer sent as a request header), and `none`.
Machine-to-machine `client_credentials` is explicitly **not** supported: *"A pure
machine-to-machine `client_credentials` grant … is **not supported**. Every connection
requires user consent."*

**Client quirks worth recording (all E1, all real per-host behavior, not server obligations):**
* DCR registers a **new client on every fresh connection** — *"DCR causes Claude to register
  a new client on every fresh connection, which can result in very large numbers of registered
  clients on your authorization server."*
* CIMD is selected **only** when AS metadata advertises **both** `"client_id_metadata_document_supported": true`
  **and** `"none"` in `token_endpoint_auth_methods_supported`; otherwise Claude falls back to DCR.
* Claude appends `offline_access` when the AS advertises it in `scopes_supported`.
* Claude uses **only the first entry** of `authorization_servers` and does not fall back.
* Token refresh is reactive on 401, with a proactive refresh up to 5 minutes before expiry.
* Timeouts: 10 s for discovery / registration / token; 30 s for refresh.
* Egress is fixed to `160.79.104.0/21` and connectors are **IPv4-only** (no `A` record ⇒
  unreachable), and any resolved non-globally-routable address aborts the connection before
  any HTTP request.

---

### 3.3 claude-code

Shares Claude's backend for the hosted pieces but *"Claude Code runs its own OAuth flow on the
user's machine and identifies itself with its own Client ID Metadata Document, so it does not
use Anthropic-held credentials"* (authentication page, E1).

**DCR identity — `verified`, E1, from the vendor's own machine-readable artifact.** Anthropic
publishes Claude Code's CIMD at a public URL. Fetched 2026-07-29 from
<https://claude.ai/oauth/claude-code-client-metadata>:

```json
{
  "client_id": "https://claude.ai/oauth/claude-code-client-metadata",
  "client_name": "Claude Code",
  "client_uri": "https://claude.ai",
  "redirect_uris": ["http://localhost/callback", "http://127.0.0.1/callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none"
}
```

`scope` and `logo_uri` are absent from the document. Corroborated in prose by the
authentication page: *"Claude Code declares `http://localhost/callback` and
`http://127.0.0.1/callback` in its Client ID Metadata Document, so your authorization server
must accept both with the port component ignored."*

**Redirect at runtime — `verified`, E1.** *"Claude Code is a native client and uses an RFC 8252
loopback redirect on an ephemeral port — for example: `http://localhost:3118/callback`. The
port varies per session."*

**`sendsResourceIndicator` — `refuted` (same prior claim, same evidence).** The Anthropic
`resource`-parameter statement is made about "Claude" on the connectors documentation set
whose stated scope includes Claude Code. Flagged as a **medium-confidence carry-over**: the
sentence is not scoped per-surface, and Claude Code's loopback flow is a different code path
from the hosted backend. **HP-44 should capture Claude Code's authorize+token legs directly
rather than inherit this.**

**`oauthSpecVersion` — `verified` (2025-11-25)**, same doc-set evidence as §3.2.

**`protocolVersionPinning` — split.**
* MCP `initialize` protocol version: `verified`, **E2** — `2025-11-25`, from a live probe
  recorded in this repo:
  `sdk/src/host-config/templates/seed-host-template.ts:757-772` seeds
  `supportedProtocolVersions: ["2025-11-25"]` with `clientInfo: { name: "claude-code", title:
  "Claude Code", version: "2.1.176", … }`, annotated at `:702-704` as *"Verbatim from a live
  mcpjam-learn `start-host-probe` against Claude Code CLI v2.1.176"*.
* The `MCP-Protocol-Version` **HTTP header** on the OAuth-adjacent requests: `unverifiable`.
  Claude Code is distributed as bundled/minified JS; no public source. **Requires HP-44.**

**User-Agent — `unverifiable`.** No public source. (Note: OpenAI Codex issue #16485, E3,
asserts in passing that Claude Code *does* send a UA where Codex does not — recorded as a
lead only, not as evidence.)

**Auth model — `verified`, E1.** OAuth 2.0 authorization-code, public client
(`token_endpoint_auth_method: "none"`), CIMD-identified, PKCE `S256` mandatory
(*"Claude includes a PKCE `code_challenge` with `code_challenge_method=S256` on every
authorization request, regardless of which registration mechanism it uses."*).

---

### 3.4 chatgpt

**`sendsResourceIndicator` — `refuted`.** The prior belief that *"ChatGPT omits the RFC 8707
`resource` param"* is **FALSE**. Official OpenAI documentation, verbatim:

> "Expect ChatGPT to append `resource=https%3A%2F%2Fyour-mcp.example.com` to both the
> authorization and token requests."

— <https://developers.openai.com/apps-sdk/build/auth> (E1)

Note the doc does not name RFC 8707, but the parameter name, placement (both legs), and value
(the MCP server URL) are exactly RFC 8707 resource-indicator semantics.

**`oauthSpecVersion` — `verified`, E1.** The page links the *"MCP authorization spec"* at
`modelcontextprotocol.io/specification/2025-11-25/basic/authorization`, and requires PRM:
*"GET https://your-mcp.example.com/.well-known/oauth-protected-resource"*.

**`protocolVersionPinning` — `unverifiable`.** Closed-source connector backend; the auth doc
says nothing about `MCP-Protocol-Version`. The repo's own template
(`seed-host-template.ts:842-848`) records `clientInfo: { name: "openai-mcp", version: "1.0.0" }`
but sets **no** `supportedProtocolVersions`, so there is no E2 capture either. **Requires HP-44.**

**DCR identity — partially `verified`.**
* Redirect URI — `verified`, E1: *"ChatGPT completes the OAuth flow by redirecting to
  `https://chatgpt.com/connector/oauth/{callback_id}`"*, with the legacy
  `https://chatgpt.com/connector_platform_oauth_redirect` still working.
* CIMD `client_id` — `verified`, E1: *"ChatGPT skips dynamic client registration and sends a
  CIMD document URL as the `client_id`, such as `https://chatgpt.com/oauth/.../client.json`"*.
  The elided path segment means the concrete document (and therefore the literal `client_name`)
  could not be fetched.
* `client_name` at DCR — `unverifiable`. The doc does not state it and the CIMD URL is
  redacted in the doc. **Requires HP-44.**
* User-Agent — `unverifiable`. Not documented.

**Auth model — `verified`, E1.** DCR (RFC 7591) **or** CIMD, with CIMD supporting both
public-client (`none`) and signed-assertion (`private_key_jwt`) token exchange.

---

### 3.5 mistral (Le Chat)

**Auth model — `verified`, E1.** <https://docs.mistral.ai/le-chat/knowledge-integrations/connectors/mcp-connectors>:
*"OAuth 2.1 (with dynamic client registration): for servers using standard OAuth 2.1 delegated access."*

**`protocolVersionPinning` — `verified`, E2** for the `initialize` handshake only:
`seed-host-template.ts:985-990` records `supportedProtocolVersions: ["2025-11-25"]` with
`clientInfo: { name: "mcp", version: "0.1.0" }`, annotated at `:948-954` as a capture of
Le Chat's real base MCP `initialize`. The `MCP-Protocol-Version` HTTP header is not covered.

**Everything else — `unverifiable`.** The official page states only "OAuth 2.1 with DCR" and
gives no redirect URI, no `client_name`, no mention of RFC 8707, no mention of
`/.well-known/oauth-protected-resource`, and no `MCP-Protocol-Version`. Le Chat is
closed-source. **Requires HP-44.**

*Lead only (E3, not evidence):* third-party write-ups describe Le Chat's flow as
"resource and authorization server discovery, DCR, and a PKCE-based authorization code flow".
Do not promote this without a capture.

---

### 3.6 goose

Open source. Read from a local clone of `block/goose` at SHA
`ca6ba6c4488aebd87cb6588da176d7ee073283bb` (matches `main`), 2026-07-29.

**Structural finding:** Goose authors almost no OAuth code. `crates/goose/src/oauth/mod.rs` is
**280 lines total**, and nearly all of it is a localhost callback server. The protocol is the
`rmcp` crate, pinned at `Cargo.toml:23` `rmcp = { version = "2", … }`, resolved in `Cargo.lock`
to **2.2.0**. (There is no `crates/mcp-client` any more.) Claims below are tagged **[repo]** for
Goose's own source and **[rmcp]** for the dependency — conflating the two is exactly how this
question gets answered wrongly.

**`sendsResourceIndicator` — `verified`: sent on `/authorize`, `/token`, and refresh. 100%
from `rmcp`; Goose contributes zero.** A grep for `"resource"` across
`crates/goose/src/oauth/` returns **no hits**. In `rmcp 2.2.0`'s `src/transport/auth.rs`
(`~L1356`, `~L1604`, `~L1738`) the three call sites are byte-identical to `rmcp 3.0`'s,
including this comment on the refresh leg:
```rust
    // RFC 8707: the resource indicator is required on token requests, including refreshes
    .add_extra_param("resource", self.base_url.to_string());
```
Value sent = **the MCP server URL** (`self.base_url`), not the PRM `resource` field — the same
choice Claude and ChatGPT document, and the opposite of VS Code's.

**`oauthSpecVersion` — `verified`, and it is the most interesting result in this section:
Goose's OAuth layer and its MCP layer are on *different spec revisions*.**

The OAuth stack does RFC 9728 PRM discovery — **[rmcp 2.2.0]** `auth.rs ~L1096`:
```rust
/// discover oauth2 metadata (per SEP-985: Protected Resource Metadata first, then direct OAuth)
pub async fn discover_metadata(&self) -> Result<AuthorizationMetadata, AuthError> {
    if let Some(metadata) = self.discover_oauth_server_via_resource_metadata().await? {
        return Ok(metadata);
    }
```
with the same path-aware AS ladder as `rmcp 3.0`. `rmcp 2.2.0` additionally has a POST-probe
fallback (`RESOURCE_METADATA_POST_PROBE_BODY`, `auth.rs:33`) that 3.0 **removed** — so Goose
will discover OAuth on some servers Codex will not.

But its MCP handshake announces **2025-03-26**, a revision that predates PRM entirely (see
below). **If you test spec-conformance against Goose, it will look "modern" on the OAuth wire
and "legacy" on the MCP wire.** No other catalog client exhibits this split.

**`protocolVersionPinning` — `verified`: HARD-pinned to a single value, `2025-03-26`, with no
negotiation list.** `crates/goose/src/agents/mcp_client.rs L539-553` — this is the client's
`get_info()`, i.e. the `initialize` params it sends:
```rust
#[expect(deprecated)]
fn get_info(&self) -> ClientInfo {
    let extensions = self.resolved_extensions();
    InitializeRequestParams::new(
        ClientCapabilities::builder()
            ...
            .build(),
        self.resolved_client_info(),
    )
    .with_protocol_version(ProtocolVersion::V_2025_03_26)
}
```
Exactly one version; no supported-versions list. The `#[expect(deprecated)]` attribute shows
`rmcp` itself has deprecated this override — `rmcp`'s own `ProtocolVersion::LATEST` is
`V_2025_11_25`, so **Goose is deliberately pinning two full revisions behind what its own SDK
defaults to.**

This **confirms** the in-repo probe: `seed-host-template.ts:1095-1099` records
`supportedProtocolVersions: ["2025-03-26"]` with `clientInfo: { name: "goose-desktop",
version: "1.38.0" }`, annotated at `:1049-1052` as *"Captured from Goose Desktop 1.38.0"*.
E1↔E2 cross-confirmation, and the only catalog client where a `2025-03-26` pin is genuinely
verified in source.

**DCR identity — `verified`, and Goose is CIMD-first with DCR only as a fallback.**
`crates/goose/src/oauth/mod.rs:21` and `L145-155`:
```rust
const CLIENT_METADATA_URL: &str = "https://goose-docs.ai/oauth/client-metadata.json";
...
let redirect_uri = format!("http://127.0.0.1:{}/oauth_callback", used_addr.port());
oauth_state
    .start_authorization_with_metadata_url(
        &[],
        redirect_uri.as_str(),
        Some("goose"),
        Some(CLIENT_METADATA_URL),
    )
```
The branch that decides CIMD vs DCR — **[rmcp 2.2.0]** `auth.rs L2745-2782`: if AS metadata
advertises `"client_id_metadata_document_supported": true`, the URL **is** the `client_id`
(SEP-991) and **no DCR happens at all**; otherwise it falls through to
`.register_client(client_name.unwrap_or("MCP Client"), redirect_uri, scopes)` with
`client_name: "goose"`.

Goose's hosted CIMD document, fetched live (HTTP 200), verbatim:
```json
{
  "client_id": "https://goose-docs.ai/oauth/client-metadata.json",
  "client_name": "goose",
  "redirect_uris": [
    "http://127.0.0.1/oauth_callback",
    "http://[::1]/oauth_callback"
  ],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none",
  "code_challenge_methods_supported": ["S256"]
}
```
This is the **third** vendor-published CIMD found in this investigation (after Claude Code and
Slack).

* `client_name` — `"goose"`, consistent across the CIMD document and the DCR fallback.
* Redirect URI sent at runtime — `http://127.0.0.1:{port}/oauth_callback`, port from
  `GOOSE_OAUTH_CALLBACK_PORT` else OS-ephemeral (`mod.rs L131-135`).
* User-Agent on the **MCP transport** — `verified`: `goose/{CARGO_PKG_VERSION}`,
  `crates/goose/src/agents/extension_manager.rs L608-609`:
  ```rust
  const GOOSE_USER_AGENT: reqwest::header::HeaderValue =
      reqwest::header::HeaderValue::from_static(concat!("goose/", env!("CARGO_PKG_VERSION")));
  ```
  **Whether that UA reaches the authorization server is `unverifiable`** — `mod.rs:145` calls
  `OAuthState::new(mcp_server_url, None)`, passing `None` for the HTTP client and letting
  `rmcp` construct its own. Settling it requires tracing `rmcp 2.2.0`'s default client
  construction, which was not done. (Contrast Codex, which demonstrably **does** reuse its
  UA-bearing client on the OAuth leg.)

**Auth model — `verified`: headers/API-key first, OAuth only as a 401 fallback.**
`extension_manager.rs:697` inserts the UA plus user-supplied headers and connects
**unauthenticated**; only then (`:781`) does `if should_attempt_oauth_fallback(&client_res)`
trigger `oauth_flow`. Stored credentials short-circuit this (`:728`) to avoid a 401 round-trip
every session. This is the opposite ordering from Claude/ChatGPT (OAuth-first) and matters for
any trace capture — **the first request Goose makes to a protected server is always
unauthenticated.**

**A real client quirk with server-facing consequences — `verified`:** Goose's entire OAuth
entry point is a 401 sniff, and one arm of it is a **string-prefix match** —
`extension_manager.rs L467-482`:
```rust
if let Some(http_err) = error.downcast_ref::<StreamableHttpError<reqwest::Error>>() {
    return match http_err {
        StreamableHttpError::AuthRequired(_) => true,
        StreamableHttpError::UnexpectedServerResponse(body) => body.starts_with("HTTP 401"),
```
A server that signals authentication any other way gets **no OAuth attempt at all**.

**Flagged inference, not a finding:** the CIMD document registers
`http://127.0.0.1/oauth_callback` with **no port**, while Goose sends an ephemeral port. This
only works if the authorization server implements RFC 8252 §7.3 port-agnostic loopback
matching. Both halves are verified; **no test covering the interaction was found**, so the
consequence is labelled an inference.

---

### 3.7 slack (Slackbot MCP Client)

**Scope correction — important.** The catalog's `slack` entry is the Slackbot MCP **Client**
(Slack acting as an MCP host, connecting out to third-party servers). It is **not** Slack's
MCP **server** at `https://mcp.slack.com/mcp`. The widely-cited line *"We do not support …
Dynamic Client Registration at this time. MCP clients must be backed by a registered Slack
app with a fixed app ID"* is about Slack-as-a-**server** and is **irrelevant** to this profile.
Conflating the two would have reproduced exactly the HP-17 failure mode.

**Auth model — `verified`, E1.** <https://docs.slack.dev/changelog/2026/06/18/slackbot-mcp-client/>
and <https://docs.slack.dev/ai/slackbot-mcp-client/> list four methods:
1. *"Slack identity auth: for MCP servers that map Slack user and team IDs to available
   features, with no separate OAuth flow required for end users."*
2. *"No auth: for MCP servers that serve standard responses regardless of requestor."*
3. *"Dynamic Client Registration: for MCP servers that support standard OAuth discovery.
   Slack handles client registration automatically."*
4. *"Manual OAuth: for MCP servers where you manually register OAuth credentials with the
   provider."*

**DCR identity — `verified`, E1, from Slack's own published CIMD.** The docs point at
*"Slack's client information metadata document is available at:
`https://slack.com/.well-known/oauth-client-metadata`"*. Fetched 2026-07-29:

```json
{
  "client_id": "https://slack.com/.well-known/oauth-client-metadata",
  "client_name": "Slack",
  "client_uri": "https://slack.com",
  "logo_uri": "https://a.slack-edge.com/80588/marketing/img/icons/icon_slack_hash_colored.png",
  "redirect_uris": ["https://oauth2.slack.com/external/auth/callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none"
}
```

Corroborated in prose: *"When registering your OAuth app with the provider, set the redirect
URI to `https://oauth2.slack.com/external/auth/callback`."* Note the literal `client_name` is
`"Slack"` — **not** "Slackbot".

**`protocolVersionPinning` — `verified`, E2** for `initialize` only: `2025-06-18`,
`seed-host-template.ts:1199-1204`, with `clientInfo: { name: "Slackbot MCP Client",
version: "1.0.0" }`, annotated at `:1162` as *"Captured from Slackbot on 2026-06-24"*.
HTTP header value: `unverifiable`.

**`sendsResourceIndicator`, `oauthSpecVersion`, User-Agent — `unverifiable`.** The Slackbot
MCP Client docs explicitly do not cover the `resource` parameter,
`/.well-known/oauth-protected-resource`, the User-Agent, or the `MCP-Protocol-Version`
header. Slackbot is closed-source. **Requires HP-44.**

*Client quirk worth recording (E1):* Slack *"still signs every request so your server can
verify it originated from Slack"* — request signing is an additional per-host behavior a
golden trace should capture.

---

### 3.8 cursor

**DCR identity — partially `verified`, E1.** <https://cursor.com/docs/context/mcp> gives two
fixed redirect URIs applying across web, Cursor Agents, and the desktop app:
`https://www.cursor.com/agents/mcp/oauth/callback` and `http://localhost:8787/callback`.
`client_name` and User-Agent are **`unverifiable`** — the page does not state them and Cursor
is closed-source.

**Auth model — `verified`, E1.** DCR by default, with a static-credentials escape hatch: an
`auth` object taking `CLIENT_ID` (required), `CLIENT_SECRET` (optional) and `scopes`
(optional), provided for when *"The provider does not support OAuth 2.0 Dynamic Client
Registration"*. Values support `${env:…}` interpolation.

**`oauthSpecVersion` — `unverifiable`, leaning older.** The page documents scope discovery via
`/.well-known/oauth-authorization-server` (*"If omitted, Cursor will use
`/.well-known/oauth-authorization-server` to discover `scopes_supported`"*) and makes **no
mention** of `/.well-known/oauth-protected-resource` / RFC 9728. That is *suggestive* of a
pre-2025-06-18 discovery model — but absence from a docs page is **not** evidence of absence
in the implementation, so this stays `unverifiable`. **This is exactly the kind of field HP-44
must settle; do not promote the suggestion to a finding.**

**`sendsResourceIndicator`, `protocolVersionPinning` — `unverifiable`.** Not mentioned in the
docs; closed-source. The repo template (`seed-host-template.ts`, `cursor` entry) records
`respectToolVisibility: false` from a 3.4.20 probe but sets no `supportedProtocolVersions`,
so there is no E2 capture either. **Requires HP-44.**

*Lead only (E3):* Cursor community-forum threads report the redirect URI changing from
`cursor://anysphere.cursor-mcp/oauth/callback` to an `http://localhost` form around 3.10.17,
and report `http://127.0.0.1:54321/callback` being registered at DCR. These conflict with the
current official docs. Treat the version-to-URI mapping as **open** until captured.

---

### 3.9 codex (OpenAI Codex CLI)

Open source (Rust). Read from a local clone of `openai/codex` at SHA
`1ae2b9880e8af5d465161a58f24a127aaa4b0040` (three files at `main`
`1da9f846b30f0a6185c0452d39edd4e0fd55fe1c`), with the `rmcp` dependency source pulled from
crates.io at the **exact pinned version**. Dependency pin — `codex-rs/Cargo.toml:384`:
```
rmcp = { version = "=3.0.0-beta.3", default-features = false }
```
Claims are tagged **[repo]** (Codex's own source) vs **[rmcp]** (the dependency).

> **Correction to an earlier pass in this same investigation.** My first read of Codex was done
> by remote raw-file fetch against `main` and produced three statements that the local-clone
> read has now corrected: (a) I could not find the `/token`-leg `resource` and marked it
> version-drift-caveated — it is unconditional in `rmcp` and now read at the pinned version;
> (b) I marked User-Agent `unverifiable, leaning "none sent"` on the strength of a third-party
> issue — **that was wrong**, Codex does set one; (c) I described the 2025-06-18 pin as
> "refuted as a standing property" — the accurate statement is narrower. All three are fixed
> below. Recording the correction rather than silently overwriting it, because the failure mode
> (trusting a summarized remote fetch and an unconfirmed issue report) is the exact one HP-47
> exists to avoid.

**`sendsResourceIndicator` — `verified`: sent on `/authorize`, `/token`, and refresh, via two
independent mechanisms.**

**[rmcp]** sends it unconditionally, value = the MCP server URL —
`rmcp-3.0.0-beta.3/src/transport/auth.rs` `~L1727`, `~L2006`, `~L2151`:
```rust
    .add_extra_param("resource", self.base_url.to_string());
```
```rust
    .exchange_refresh_token(&refresh_token_value)
    // RFC 8707: the resource indicator is required on token requests, including refreshes
    .add_extra_param("resource", self.base_url.to_string());
```

**[repo]** *Separately*, Codex appends a **second, user-configured** `resource` to the
authorize URL only — `codex-rs/rmcp-client/src/perform_oauth_login.rs L531-535`:
```rust
let auth_url = append_query_param(
    &oauth_state.get_authorization_url().await?,
    "resource",
    oauth_resource,
);
```
`oauth_resource` is opt-in per-server config, labelled RFC 8707 in Codex's own source —
`codex-rs/config/src/mcp_types.rs L216-218`:
```rust
/// Optional OAuth resource parameter to include during MCP login (RFC 8707).
#[serde(default, skip_serializing_if = "Option::is_none")]
pub oauth_resource: Option<String>,
```

**Flagged inference, not a finding:** since `rmcp` has already put `resource` in the authorize
URL and `append_query_param` uses `append_pair` (appends rather than replaces, `~L693`),
configuring `oauth_resource` should yield **two `resource` query params** on `/authorize`.
No test asserting either way was found. If real, this is a genuine interop hazard worth an
HP-44 capture.

**`oauthSpecVersion` — `verified` (2025-06-18-or-later: RFC 9728 PRM + path-aware ladder).**
**[repo]** Codex has an integration test proving the full chain — 401 →
`WWW-Authenticate: resource_metadata=` → PRM fetch → `authorization_servers` → AS metadata:
`codex-rs/rmcp-client/tests/mcp_2026_oauth_discovery.rs L54-56, L73-76`:
```rust
.respond_with(ResponseTemplate::new(401).insert_header(
    "www-authenticate",
    format!("Bearer resource_metadata=\"{resource_metadata_url}\""),
))
```
**[rmcp]** the ladder itself, `auth.rs ~L2238` — note the header comment names a *newer* spec
revision than the protocol version Codex actually negotiates:
```rust
/// Generate discovery endpoint URLs following the priority order in spec-2025-11-25 4.3 "Authorization Server Metadata Discovery".
...
push_candidate(format!("/.well-known/oauth-authorization-server/{trimmed}"));
push_candidate(format!("/.well-known/openid-configuration/{trimmed}"));
push_candidate(format!("/{trimmed}/.well-known/openid-configuration"));
push_candidate("/.well-known/oauth-authorization-server".to_string());
```
The literal string `oauth-protected-resource` appears **nowhere in the Codex repo** — the
discovery behavior is entirely `rmcp`'s.

**`protocolVersionPinning` — the prior claim is *precisely* half right, and the precise version
matters.** Prior belief: *"Codex pins `MCP-Protocol-Version: 2025-06-18` and does NOT support
2024-11-05."*

* **`2025-06-18` is the default preference — `verified`, and it is a preference, not a hard
  pin.** `codex-rs/rmcp-client/src/protocol_mode.rs L19-33`:
  ```rust
  pub fn preferred_protocol_version(self) -> ProtocolVersion {
      match self {
          Self::Legacy => ProtocolVersion::V_2025_06_18,
          Self::V20260728 => ProtocolVersion::V_2026_07_28,
      }
  }

  pub(crate) fn client_lifecycle(self) -> ClientLifecycleMode {
      match self {
          Self::Legacy => ClientLifecycleMode::Initialize,
          Self::V20260728 => ClientLifecycleMode::Auto {
              preferred_versions: vec![ProtocolVersion::V_2026_07_28],
              legacy_version: Some(ProtocolVersion::V_2025_06_18),
          },
  ```
* **The `2026-07-28` mode exists but is OFF BY DEFAULT** — `codex-rs/features/src/lib.rs L1118-1123`:
  ```rust
  FeatureSpec {
      id: Feature::Mcp20260728,
      key: "mcp_2026_07_28",
      stage: Stage::UnderDevelopment,
      default_enabled: false,
  },
  ```
  gated at `codex-rs/core/src/config/mod.rs L1761-1767`. So **out of the box today, Codex still
  behaves as a `2025-06-18` client** — which vindicates the in-repo probe
  (`seed-host-template.ts:1393-1405`: `supportedProtocolVersions: ["2025-06-18"]`,
  `clientInfo: { name: "codex-mcp-client", title: "Codex", version: "0.131.0-alpha.9" }`, E2)
  as still-current rather than merely historical. **My earlier "refuted as a standing property"
  framing was too strong; the accurate statement is "default `2025-06-18`, with `2026-07-28`
  available behind an off-by-default feature flag."**
* **"Does NOT support 2024-11-05" — `unverifiable` at the Codex layer.** `rmcp` defines
  `V_2024_11_05`, so the capability exists in the dependency; `protocol_mode.rs` offers only
  `2025-06-18` / `2026-07-28`, so Codex does not appear to *prefer* it. Whether it would accept
  a server negotiating down is not settled by these two files. **Requires HP-44.**
* **A genuinely surprising `rmcp` finding, `verified`:** OAuth *discovery* requests carry a
  **hardcoded, stale** protocol header — `auth.rs ~L2623`:
  ```rust
  .header(HEADER_MCP_PROTOCOL_VERSION, "2024-11-05");
  ```
  So Codex (and Goose, and any `rmcp` client) sends `MCP-Protocol-Version: 2024-11-05` on the
  OAuth discovery leg while negotiating `2025-06-18` on the MCP leg. Any server that gates
  discovery responses on that header will misbehave. **This belongs in the conformance suite
  as a server-tolerance check (S16).**

**DCR identity — `verified`.**

| Item | Value | Citation |
| --- | --- | --- |
| `client_name` | `"Codex"` | `perform_oauth_login.rs:665` |
| redirect URI | `http://127.0.0.1:{ephemeral}/callback/{id}` | `perform_oauth_login.rs:404-419`, `:508` |
| User-Agent | `codex-mcp-client/{CARGO_PKG_VERSION}` | `utils.rs:12`, `:67` |

```rust
AuthorizationRequest::new(redirect_uri)
    .with_scopes(scopes.iter().copied())
    .with_client_name("Codex"),
```
```rust
const MCP_USER_AGENT: &str = concat!("codex-mcp-client/", env!("CARGO_PKG_VERSION"));
...
headers.insert(USER_AGENT, HeaderValue::from_static(MCP_USER_AGENT));
```

**The User-Agent claim is `refuted` — and this is a direct HP-17-style catch.** Issue
<https://github.com/openai/codex/issues/16485> (E3) asserts *"Codex CLI's MCP client (via RMCP)
does not send a `User-Agent` header."* Codex **does** set one, and it demonstrably reaches the
authorization server too: `perform_oauth_login.rs:520` passes the UA-bearing client into
`OAuthHttpClientAdapter::new(http_client, default_headers)`. The issue is **closed**, so it was
most likely fixed after filing — either way, **an unconfirmed issue report is not evidence**,
and my earlier pass was wrong to lean on it.

Port defaults to OS-ephemeral (`format!("{bind_host}:0")`, `:498`), overridable by config. The
callback path carries a per-server suffix: `callback_id` = base64url(SHA-256(server_url)[..9])
(`:438-439`) — so **the redirect URI is not even constant across servers for the same client**.

**[rmcp]** `with_client_name` feeds **only** the DCR body and is inert if a `client_id` is
pre-configured (`auth.rs ~L3287`). Codex passes **no** `client_metadata_url`, so it never takes
the CIMD branch — it does **real DCR**, unlike Goose. The DCR body registers a public client:
`token_endpoint_auth_method: "none"`, `grant_types: ["authorization_code", "refresh_token"]`,
`application_type: "native"`.

**Auth model — `verified`: OAuth2 + DCR by default, with headers/bearer taking precedence.**
`codex-rs/config/src/mcp_types.rs L130-142`:
```rust
/// Authentication flow Codex attempts after resolving an HTTP MCP server's
/// configured bearer token and authorization headers, which always take
/// precedence. ChatGPT authentication falls back to stored OAuth credentials
/// when its session provider is unavailable; both modes ultimately fall back
/// to an unauthenticated connection.
...
#[default]
#[serde(rename = "oauth")]
OAuth,
```

**Client quirk with server-facing consequences — `verified`:** Codex **deliberately relaxes**
the RFC 8414 requirement that AS metadata include `issuer` —
`perform_oauth_login.rs:656` and `auth_status.rs:221` both call
`auth_manager.set_allow_missing_issuer(true);`. A server omitting `issuer` is out of spec but
works with Codex. Do **not** let this soften the conformance check (S-list); it is a Codex
leniency, not a licence.

Third-party issue reports that Codex is **DCR-first** with no pre-registered-client path
(<https://github.com/openai/codex/issues/19154>, `#13200`, `#15818` — E3) are consistent with
the source above, but the source is the evidence; the issues merely characterize the
user-visible symptom.

---

### 3.10 copilot (Microsoft 365 Copilot)

**Scope correction — there are at least three unrelated "Copilot" MCP clients.** The catalog
entry is labelled `"Copilot 1.0.1"` / `"Microsoft 365 Copilot 1.0.1 compatibility profile"`
(`seed-host-template.ts:1411-1414`), so **Microsoft 365 Copilot** is the profile being written
here. Two neighbours must not be merged into it:

* **GitHub Copilot Chat in VS Code** is a *different* client with *different* behavior —
  see the sub-section below. It is now vendored into `microsoft/vscode` at
  `extensions/copilot/` (the standalone `microsoft/vscode-copilot-chat` repo is **archived**,
  `"archived": true`, last push 2026-05-20).
* **Copilot on github.com, JetBrains, Xcode, and the Copilot CLI** are closed source; no
  public repo exposes their MCP client implementations. `unverifiable`, and **nothing in this
  section may be extrapolated to them.**

The findings below are for **Microsoft 365 Copilot** unless explicitly labelled otherwise.

**Auth model — `verified`, E1.**
<https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-authentication>
publishes a per-scheme support matrix. For **MCP plugins**:

| Scheme | MCP plugins |
| --- | --- |
| Microsoft Entra single sign-on (SSO) | Supported |
| Dynamic client registration (DCR) | Supported |
| OAuth 2.0 authorization code flow | Supported |
| API key | **Not supported** |
| No authentication (anonymous) | Supported |

The "API key not supported for MCP plugins" row is a genuine, citable per-host constraint —
API keys are an API-plugin-only feature in Copilot.

**`oauthSpecVersion` — `verified`, E1.**
<https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-authentication-dynamic-client-registration>,
§"Step 1: Confirm prerequisites", verbatim:

> "Your MCP server exposes OAuth 2.0 protected resource metadata at its
> `.well-known/oauth-protected-resource` endpoint ([RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728)),
> identifying the authorization server that protects it."
>
> "The authorization server publishes its metadata at the `.well-known/oauth-authorization-server`
> endpoint ([RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414)), including a
> `registration_endpoint`, and supports dynamic client registration
> ([RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591)) that issues a client secret."

RFC 9728 PRM as a hard prerequisite places Copilot at the 2025-06-18-or-later discovery model.
The exact spec **revision** is not stated, so the revision itself remains `unverifiable`.

**Client quirks — `verified`, E1, and both are unusual enough to be worth a profile field:**
* *"DCR without a client secret isn't supported yet. The authorization server must issue a
  client secret during registration."* — Copilot is the **only** catalog client found to
  **require** a confidential-client DCR response. Every other DCR client in this catalog
  registers as a public client (`token_endpoint_auth_method: "none"`). A server that returns
  a public-client registration will work with Claude, Slack, and Claude Code but **fail**
  with Copilot.
* *"PKCE is enabled by default for DCR."*

**DCR identity — `unverifiable`.** Deliberately opaque by design:
*"Unlike static OAuth, you don't configure a redirect URI or client credentials yourself - the
Enterprise token store registers the client and handles those details behind the scenes."*
The `client_name`, the DCR-path redirect URI, and the User-Agent are therefore not documented.
(For the *static* OAuth path — a different scheme — the docs give
`https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect`; do **not** carry that over to
the DCR path without a capture.) **Requires HP-44.**

**`sendsResourceIndicator`, `protocolVersionPinning` — `unverifiable`.** Neither page mentions
the `resource` parameter, RFC 8707, or `MCP-Protocol-Version`. Copilot's MCP client is
closed-source. The repo template (`seed-host-template.ts:1411+`) is explicit that
*"Copilot's MCP client identity is not publicly documented"* and sets no
`supportedProtocolVersions` — so no E2 capture either. **Requires HP-44.**

#### 3.10b GitHub Copilot Chat (VS Code extension) — a separate, fully verified result

**`refuted` as a distinct OAuth client: Copilot Chat implements NO MCP OAuth of its own. It
delegates entirely to VS Code's built-in MCP support (§3.11).**

The complete extent of its MCP surface is a 88-line pass-through —
`https://raw.githubusercontent.com/microsoft/vscode/main/extensions/copilot/src/platform/mcp/vscode/mcpServiceImpl.ts` L42-64:
```ts
get mcpServerDefinitions() {
    return lm.mcpServerDefinitions;
}
...
const gateway = await lm.startMcpGateway();
```
where `lm` is the `vscode` API namespace (`L6`). The interface at
`extensions/copilot/src/platform/mcp/common/mcpService.ts` is 39 lines and declares exactly
three members.

Negative searches across all 5,267 files of `extensions/copilot/`, all empty: `code_challenge`
→ 0 results; `registration_endpoint` → 0 results; `oauth-protected-resource` across the whole
repo hits only `src/vs/base/common/oauth.ts`, `mainThreadMcp.ts`, `codexAgent.ts` and tests —
**zero** `extensions/copilot` paths. The archived standalone repo agrees: no OAuth, no
well-known, no DCR.

**The one piece of MCP auth Copilot Chat does own is a static bearer header** —
`extensions/copilot/src/extension/githubMcp/common/githubMcpDefinitionProvider.ts L153-171`:
```ts
const accessToken = this.authenticationService.permissiveGitHubSession?.accessToken;
if (accessToken) {
    server.headers['Authorization'] = `Bearer ${accessToken}`;
    return server;
}
```
targeting `https://api.githubcopilot.com/mcp/` (`L116-118`), plus proprietary non-auth headers
`X-MCP-Toolsets`, `X-MCP-Readonly`, `X-MCP-Lockdown`, `X-MCP-Insiders` (`L127-138`).

So for its **own** GitHub MCP server, Copilot Chat's auth model is **header/token injection,
not OAuth+DCR**, and no `401 → WWW-Authenticate → PRM` handshake is exercised on that path.
For **third-party** MCP servers its behavior is byte-for-byte VS Code's, and it would be
invisible to a server as a distinct client (`client_name` would read `Visual Studio Code`).

---

### 3.11 vs code

**The single best-verified client in the catalog.** VS Code has a hand-written first-party MCP
OAuth implementation — it does **not** delegate to the TypeScript SDK's `auth()`. Everything
below was read from `microsoft/vscode` @ `main`, fetched 2026-07-29. Line numbers are `~`
(main drifts).

Three layers:
* `src/vs/base/common/oauth.ts` — RFC 8414 / RFC 9728 discovery + DCR primitives
* `src/vs/workbench/api/common/extHostMcp.ts` — MCP HTTP transport, 401 handling, discovery
* `src/vs/workbench/api/common/extHostAuthentication.ts` (+ `api/node/`) — the
  `DynamicAuthProvider` that runs authorize/token

**`sendsResourceIndicator` — `verified`, E1. Sent on `/authorize` AND `/token`, across all
three flows (URL-handler, loopback, device-code).**

`https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/workbench/api/common/extHostAuthentication.ts` `~L675`:
```ts
if (this._resourceMetadata?.resource) {
    // If a resource is specified, include it in the request
    authorizationUrl.searchParams.append('resource', this._resourceMetadata.resource);
}
```
Same file `~L762` (`authorization_code` token request) and `~L817` (`refresh_token`), both:
```ts
// Add resource indicator if available (RFC 8707)
if (this._resourceMetadata?.resource) {
    tokenRequest.append('resource', this._resourceMetadata.resource);
}
```
Loopback + device-code flows repeat it in
`.../src/vs/workbench/api/node/extHostAuthentication.ts` at `~L109`, `~L190`, `~L258`.

**Two qualifications that matter for conformance, both read from the same code:**
1. The value sent is `this._resourceMetadata.resource` — the **PRM document's** `resource`
   field, **not** the MCP server URL. (Contrast Claude and ChatGPT, which both document
   sending the canonicalized *server URL*.) A server whose PRM `resource` differs from its
   own URL will produce different `resource` values across hosts.
2. It is guarded. If PRM discovery fails entirely, `_resourceMetadata` is `undefined` and
   **no `resource` param is sent at all** — `createAuthMetadata` has a fallback
   (`extHostMcp.ts ~L1155`, `getDefaultMetadataForUrl`) that proceeds with `resource` unset.
3. The **DCR request itself does not carry `resource`** (see the full body below).

**`oauthSpecVersion` — `verified` behaviorally (2025-06-18-or-later shape); `unverifiable` as a
literal.** No `MCP_AUTH_SPEC_VERSION` constant exists anywhere in the repo. What is verifiable
is the behavior. `src/vs/base/common/oauth.ts` L8-11:
```ts
const WELL_KNOWN_ROUTE = '/.well-known';
export const AUTH_PROTECTED_RESOURCE_METADATA_DISCOVERY_PATH = `${WELL_KNOWN_ROUTE}/oauth-protected-resource`;
export const AUTH_SERVER_METADATA_DISCOVERY_PATH = `${WELL_KNOWN_ROUTE}/oauth-authorization-server`;
export const OPENID_CONNECT_DISCOVERY_PATH = `${WELL_KNOWN_ROUTE}/openid-configuration`;
```
PRM discovery is path-aware (challenge URL → path-appended → root), `oauth.ts ~L1260`. The AS
ladder is a documented three-rung fallback (`oauth.ts L1326-1339`, implemented at `L1388`,
`L1397`, `L1406`) distinguishing RFC 8414 path **insertion** from OIDC path **addition**.

VS Code **enforces** RFC 9728 PRM correctness client-side and hard-fails on violation
(`oauth.ts ~L1241`):
```ts
if (prmValue !== expectedResource) {
    throw new Error(`Protected Resource Metadata 'resource' property value "${prmValue}" does not match expected value "${expectedResource}" for URL ${prmUrl}. Per RFC 9728, these MUST match. ...`);
}
```

**Non-spec fourth rung, worth flagging:** if the whole ladder fails, VS Code *invents* metadata
from the origin (`oauth.ts L919-924`, `getDefaultMetadataForUrl` → `/authorize`, `/token`,
`/register`). No other catalog client is known to do this. A server with no discovery documents
at all will still see VS Code attempt an OAuth flow against guessed endpoints.

**`protocolVersionPinning` — `verified`: hardcoded and pinned; and the header is NOT sent on
MCP traffic.** This is a genuinely surprising result and the most conformance-relevant finding
in this section.

`src/vs/platform/mcp/common/modelContextProtocol.ts:43`:
```ts
export const LATEST_PROTOCOL_VERSION = "2025-11-25";
```
Sent pinned in `initialize` — `src/vs/workbench/contrib/mcp/common/mcpServerRequestHandler.ts ~L113`
uses `protocolVersion: MCP.LATEST_PROTOCOL_VERSION`, and that is the **only** `protocolVersion`
occurrence across `mcpServerRequestHandler.ts`, `mcpRegistry.ts`, and `extHostMcp.ts` — the
server's returned version is never inspected or negotiated against a list.

The `MCP-Protocol-Version` **header** appears exactly once in the entire repo, and only for
**OAuth discovery same-origin requests** — `extHostMcp.ts ~L811`:
```ts
this._authMetadata = await createAuthMetadata(mcpUrl, res.headers, {
    sameOriginHeaders: {
        ...Object.fromEntries(this._launch.headers),
        'MCP-Protocol-Version': MCP.LATEST_PROTOCOL_VERSION
    },
```
It is **absent** from all three actual MCP request header builders in the same file:
`_sendStreamableHttp` (`~L451`), the SSE GET (`~L575`), and `_closeSession` (`~L412`).

**Trap — do not misread this.** A `SUPPORTED_PROTOCOL_VERSIONS` list *does* exist in the repo
(`src/vs/platform/mcp/node/mcpGatewaySession.ts L17-24`, listing `2025-11-25`, `2025-06-18`,
`2025-03-26`, `2024-11-05`, `2024-10-07`, with real negotiation at `~L192`) — but that is
VS Code acting as an MCP **gateway server**, not as a client. The behavior is asymmetric:
**server negotiates, client pins.** Attributing that list to VS Code-as-client would be a
textbook HP-17-style error.

**DCR identity — `verified`.** The complete request body, `oauth.ts L944-969`:
```ts
const requestBody: IAuthorizationDynamicClientRegistrationRequest = {
    client_name: clientName,
    client_uri: 'https://code.visualstudio.com',
    grant_types: ...,
    response_types: ['code'],
    redirect_uris: [
        'https://insiders.vscode.dev/redirect',
        'https://vscode.dev/redirect',
        'http://127.0.0.1/',
        `http://127.0.0.1:${DEFAULT_AUTH_FLOW_PORT}/`
    ],
    scope: scopes?.join(AUTH_SCOPE_SEPARATOR),
    token_endpoint_auth_method: 'none',
    application_type: 'native'
};
```
`DEFAULT_AUTH_FLOW_PORT = 33418` (`oauth.ts L943`), corroborated by the unit test at
`src/vs/base/test/common/oauth.test.ts L485-494`.

`client_name` resolves through a three-hop chain: the call site passes
`this._initData.environment.appName` (`extHostAuthentication.ts L269`, and again at `L856` in
`_generateNewClientId`); `appName` is populated from `this._productService.nameLong`
(`localProcessExtensionHost.ts L536`); and the runtime literals are proven in-repo by
`api/node/loopbackServer.ts L191/L193` comparing against `'Visual Studio Code'` and
`'Visual Studio Code - Insiders'`.

**Honest gap on `client_name`:** the shipped Microsoft `product.json` is **not** in the OSS
repo — the in-repo `product.json` says `"nameLong": "Code - OSS"`. So an OSS build registers
as `Code - OSS`, and official builds register as `Visual Studio Code` /
`Visual Studio Code - Insiders`. That last pair is `verified via in-repo string comparison`,
which is strong but is an inference about a build-time file rather than a direct read of it.

Redirect URI **actually used** at `/authorize` differs from the registered set —
`extHostAuthentication.ts L680-682` hardcodes `'https://vscode.dev/redirect'`; the node
loopback flow overrides with `http://127.0.0.1:${port}/` (`loopbackServer.ts L109`), binding
33418 first and falling back to an ephemeral port (`server.listen(0, '127.0.0.1')`, `L147`).
Flow priority: loopback is `unshift`ed ahead of URL-handler when not remote
(`api/node/extHostAuthentication.ts L60-65`); device code is appended last (`L69-73`).

**User-Agent — `verified`, and VS Code is the only catalog client where this could be read
from source.** `extHostMcp.ts L849`:
```ts
setHostHeader(init.headers, 'user-agent', `${product.nameLong}/${product.version}`);
```
i.e. `Visual Studio Code/<version>`. This is set in `_fetch`, which is also the fetch impl
passed into the OAuth discovery calls — so discovery requests carry it too. It is **not**
applied to the DCR POST, which uses bare global `fetch` (`oauth.ts L971`).

**Auth model — `verified`.** OAuth 2.1 + mandatory PKCE S256
(`extHostAuthentication.ts L668-669`, SHA-256 + base64url at `L726-736`), public client
(`token_endpoint_auth_method: 'none'`, `application_type: 'native'`) though `client_secret` is
appended when present (`L768`). Three grant types (`oauth.ts L934`):
`['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code']`.
A static-header path coexists (user `mcp.json` headers spread into every request,
`extHostMcp.ts L452/L576/L413`). An **Enterprise XAA / ID-JAG** path also exists
(`oauth.ts L60 buildIdJagExchangeBody`, `L84 buildResourceRedemptionBody`, both appending
`resource`; driven from `mainThreadMcp.ts ~L245-285` gated on `oauth.enterpriseManaged`) —
making VS Code and MCPJam the only two catalog clients with Cross-App Access support.
`_generateNewClientId()` re-runs DCR on `invalid_client` (`extHostAuthentication.ts L799-802`).

**Client quirks that constrain servers (see also §5):**
* **VS Code accepts `403` as an auth challenge, not just `401`** — `extHostMcp.ts L959-961`:
  ```ts
  function isAuthStatusCode(status: number): boolean {
      return status === 401 || status === 403;
  }
  ```
  Directly contradicts Claude, which honors only `401`. A per-host field, not a server rule.
* **Only the first `authorization_servers` entry is used** — `extHostMcp.ts L1099-1101`, with
  an in-source `TODO:@TylerLeonhardt support multiple authorization servers`. Same limitation
  as Claude, independently sourced.
* **`WWW-Authenticate` with `resource_metadata` is treated as optional**, not required
  (`extHostMcp.ts ~L1183` parses it; `oauth.ts L1251-1272` falls back to well-known probing).
* Cross-origin redirect hardening — `extHostMcp.ts L342`:
  `CROSS_ORIGIN_STRIPPED_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization', 'mcp-session-id'])`,
  and `ALLOWED_REDIRECT_PROTOCOLS = new Set(['http:', 'https:'])` (`L339`).
* Deliberate spec deviation on session expiry, documented in-source (`extHostMcp.ts L491-494`):
  the spec says only `404` triggers re-init, but VS Code also accepts `400` because
  "some servers send 400s as well, including their example".

**Note vs the in-repo template:** `seed-host-template.ts:1645-1651` records
`supportedProtocolVersions: ["2025-11-25"]` for the vscode template from a 1.130.0 probe (E2).
That **agrees** with the source constant read here (E1) — a rare two-independent-source
confirmation, and a useful sanity check that the probe pipeline is faithful.

---

### 3.12 agentcore (AWS Bedrock AgentCore Gateway)

**`protocolVersionPinning` — `refuted`.** AgentCore does **not** pin a single version; it
negotiates across four. Official AWS docs,
<https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-target-MCPservers.html>,
§"Configuration considerations for MCP server targets", verbatim:

> "Supported MCP protocol versions are - **2026-07-28** , **2025-11-25** , **2025-06-18** ,
> and **2025-03-26**."

and:

> "For accounts that are enabled for MCP version updates, you can modify the gateway's
> supported protocol versions with the `UpdateGateway` operation. Otherwise, the supported
> versions are fixed when you create the gateway."

This **refutes** the value carried in this repo's own template
(`seed-host-template.ts:1760`, `supportedProtocolVersions: ["2025-06-18"]`) — though to that
template's credit it is already explicitly labelled at `:1749-1759` as
*"GUESS (unprobed) — every value below is a best-effort placeholder chosen to match AWS's
product naming, NOT a live capture."* **Action: update the agentcore template to the
documented four-version list, and drop the `bedrock-agentcore` `clientInfo` guess or keep it
labelled.**

Related and citable: `2026-07-28` is stateless — *"Version `2026-07-28` is stateless and does
not use the `Mcp-Session-Id` header"* — while `2025-11-25` and earlier use `Mcp-Session-Id`.

**Auth model — `verified`, E1.** Same page, §"Authorization strategy", four outbound strategies:
* *"No authorization – The gateway invokes the MCP server without preconfigured authorization.
  This approach is not recommended."*
* *"OAuth – The gateway supports both two-legged OAuth (Client Credentials grant type) and
  three-legged OAuth (Authorization Code grant type). You configure the authorization provider
  in Amazon Bedrock AgentCore Identity."*
* *"IAM (AWS Signature Version 4 (Sig V4)) – The gateway signs requests to the MCP server using
  SigV4 with the gateway service role credentials."*
* *"API key – The gateway uses an API key credential provider to authenticate with the MCP server."*

**DCR — `unverifiable`, leaning "not used on the outbound leg".** The outbound authorization
provider is **pre-configured** in AgentCore Identity, which structurally displaces DCR. The
page never mentions RFC 7591 for the outbound direction. But absence from the page is not
proof, so this stays `unverifiable` rather than `refuted`. Consequently `client_name`,
redirect URI, and User-Agent are all `unverifiable`.

**`sendsResourceIndicator`, `oauthSpecVersion` — `unverifiable`.** Not mentioned. AgentCore
Gateway is a closed managed AWS service with no public source, and — unlike the CLI clients —
it **cannot be probed locally**; the repo template says as much at `:1740-1742`
(*"AgentCore runs server-side (no local CLI to run `mcpjam-learn start-host-probe` against)"*).
**HP-44 will need an AWS account with a Gateway provisioned; this one is not free.**

**Client quirk — `verified`, E1:** *"Currently DYNAMIC mode is not interoperable with semantic
search or outbound three-legged OAuth (3LO)."* — i.e. AgentCore's listing mode and its OAuth
mode interact, which no other catalog client does.

Also citable: OAuth authorization-URL **session binding** (the authorization URL and session
URI are valid for 10 minutes, and `CompleteResourceTokenAuth` validates that the user who
started the flow is the one who completed it) — an anti-consent-hijacking measure unique to
AgentCore in this catalog.

---

### 3.13 n8n

Open source. Read directly from `n8n-io/n8n` @ `master`, fetched 2026-07-29.

**Architectural finding that drives every field:** n8n is the **opposite** of Cline. It uses
`@modelcontextprotocol/sdk` only for the Client/transport; the entire OAuth2 protocol —
discovery, DCR, authorize URL, token exchange, refresh, resource indicator — is
**n8n-authored** code in `packages/cli/src/oauth/oauth.service.ts` and
`packages/@n8n/client-oauth2`. So n8n's OAuth behavior is a genuine per-host profile, not
SDK-inherited boilerplate.

**Auth model — prior claim `verified` (re-derived), and the `x-consumer-api-key` refutation
independently `re-confirmed`.**

The MCP Client Tool node's credential list,
`https://raw.githubusercontent.com/n8n-io/n8n/master/packages/@n8n/nodes-langchain/nodes/mcp/shared/descriptions.ts` L28-65:
```ts
export const credentials: INodeCredentialDescription[] = [
	{ name: 'httpBearerAuth', ...
	{ name: 'httpHeaderAuth', ...
	{ name: 'mcpOAuth2Api', ...
	{ name: 'httpMultipleHeadersAuth',
```
User-facing selector, `McpClientTool.node.ts L156-188`: `Bearer Auth`, `Header Auth`,
`MCP OAuth2`, `Multiple Headers Auth`, `None`. Node `version: [1, 1.1, 1.2, 1.3, 1.4],
defaultVersion: 1.4` (`L61-62`); on typeVersion **< 1.2** only Bearer / Header / None are
offered (`L134-147`) — **MCP OAuth2 requires node typeVersion ≥ 1.2**. That version gate is
itself a profile-worthy fact.

The credential, `packages/@n8n/nodes-langchain/credentials/McpOAuth2Api.credentials.ts`
(whole file is 29 lines):
```ts
export class McpOAuth2Api implements ICredentialType {
	name = 'mcpOAuth2Api';
	extends = ['oAuth2Api'];
	displayName = 'MCP OAuth2 API';
	properties: INodeProperties[] = [
		{ displayName: 'Use Dynamic Client Registration',
		  name: 'useDynamicClientRegistration', type: 'boolean', default: true },
		{ displayName: 'Resource URL', name: 'resourceUrl', ...
```
DCR is **on by default** and gated at `oauth.service.ts L939-947` on
`useDynamicClientRegistration && serverUrl`.

**`x-consumer-api-key` — `refuted`, re-confirmed independently.** GitHub code search over
`n8n-io/n8n` for `"x-consumer-api-key"` returns `total_count: 0`; `consumer-api-key` likewise
returns `0`. The string does not exist anywhere in the repository. n8n's header auth is the
**generic `httpHeaderAuth` credential** — an arbitrary user-supplied `name`/`value` pair —
applied at `nodes/mcp/shared/utils.ts L400-406`:
```ts
    .getCredentials<{ name: string; value: string }>('httpHeaderAuth')
...
    headers: { [credentials.name]: credentials.value },
```
So any `x-consumer-api-key` seen on the wire is a **user-typed header name**, fully consistent
with the original Kong-API-gateway explanation. The earlier refutation stands.

**`sendsResourceIndicator` — `verified`, E1, and notably client-authored rather than inherited.**
On `/authorize` — `packages/@n8n/client-oauth2/src/code-flow.ts L38-46`:
```ts
const queryParams = {
	...options.query,
	client_id: options.clientId,
	redirect_uri: options.redirectUri,
	response_type: 'code',
	state: options.state,
	...(options.resource ? { resource: options.resource } : {}),
```
On `/token` — same file `L99-104`, `...(options.resource ? { resource: options.resource } : {})`.
On refresh — `packages/@n8n/client-oauth2/src/client-oauth2-token.ts L86-90`, same pattern.
Wired from the credential at `oauth.service.ts L1306` (`resource: credential.resource,`).

n8n cites RFC 8707 by name in its own source comment (`oauth.service.ts L170-186`) and
normalizes trailing slashes, noting *"RFC 8707 treats the resource indicator as an opaque
identifier … In practice, MCP servers consistently treat them as equivalent"*. It also
validates the supplied resource against the discovered PRM resource and throws
`InvalidTargetError` on mismatch (`L211-247`).

**`oauthSpecVersion` — `verified` (2025-06-18-era, hand-implemented).** RFC 9728 PRM +
RFC 8414 AS metadata + RFC 7591 DCR + RFC 8707 resource, all hand-rolled. Explicit precedence
comment at `oauth.service.ts L1067-1073`: *"Prefer the scopes advertised by the protected
resource (RFC 9728) over the authorization server's scopes_supported (RFC 8414)."*
SDK pin (transport only) is an **exact** pin — `pnpm-workspace.yaml L57-58`:
`'@modelcontextprotocol/sdk': 1.26.0` (no caret).

**`protocolVersionPinning` — `verified`: negotiated, NOT pinned.** Code search for
`"MCP-Protocol-Version"` across `n8n-io/n8n` returns `total_count: 1`, and the single hit is a
**test fixture mocking what the SDK produces**
(`nodes/mcp/shared/__test__/utils.test.ts L657-660`), not a client pin. n8n's fetch wrapper
merges its auth headers on top of the SDK-supplied ones (`shared/utils.ts L311`).

This **corrects** how the in-repo template should be read: `seed-host-template.ts:1795-1801`
records `supportedProtocolVersions: ["2025-11-25"]` from a probe (E2) — that is the value the
*bundled SDK* negotiated at capture time, **not** a pin n8n owns. It will drift with the SDK
dependency.

**DCR identity — `verified`, E1.** `oauth.service.ts L1100-1111`:
```ts
const registerPayload = {
	redirect_uris: [`${this.getBaseUrl(OauthVersion.V2)}/callback`],
	token_endpoint_auth_method,
	grant_types,
	response_types: ['code'],
	client_name: 'n8n',
	client_uri: 'https://n8n.io/',
	scope,
```
* `client_name` = **`'n8n'`** (exact literal).
* Redirect URI = `<instance base URL>/<rest endpoint>/oauth2-credential/callback`
  (`getBaseUrl`, `L250-253`; default rest endpoint `rest` → `https://<host>/rest/oauth2-credential/callback`).
  This is a **hosted HTTPS redirect**, structurally the opposite of every CLI/desktop client
  in this catalog (which use loopback). Self-hosted n8n means the redirect URI is
  **deployment-specific** — a golden trace must record the instance URL as a variable, not a
  constant.
* `token_endpoint_auth_method` and `grant_types` are **negotiated** from the AS's advertised
  metadata (`L1079-1098`), so n8n can register as either a **public or confidential** client
  depending on the server. It is the only catalog client found to do this adaptively.
* **MCP `clientInfo.name` is not a product name.** `shared/utils.ts L176` constructs
  `new Client({ name, version: version.toString() }, ...)` with `name: node.type` and
  `version: node.typeVersion` (`L524-525`) — i.e. the n8n *node type string* and *node
  typeVersion*. This matches the in-repo probe capture
  (`seed-host-template.ts:1796-1800`: `name: "@n8n/n8n-nodes-langchain.mcpClientTool",
  version: "1.3"`), an E1↔E2 cross-confirmation.
* **User-Agent — `unverifiable`.** Code search for `"User-Agent"` scoped to
  `packages/@n8n/nodes-langchain/nodes/mcp` returns `total_count: 0`. The DCR POST goes through
  `this.http.request(...)` (`OutboundHttp`); no MCP-specific UA override was located, so the
  effective value is a runtime default that cannot be pinned from source.

Bearer application at `utils.ts L392` and an automatic 401→refresh→retry hook at `L526`
(`onUnauthorized`).

---

### 3.14 perplexity

**`protocolVersionPinning` — `verified`, E2** for `initialize` only: `2025-06-18`,
`seed-host-template.ts:1826-1832`, `clientInfo: { name: "mcp", version: "0.1.0" }`, annotated
at `:1820-1822` as *"Captured from the Perplexity host probe: protocol 2025-06-18, clientInfo
mcp@0.1.0, and an empty clientCapabilities object."*

**Everything else — `unverifiable`, with a specific and slightly unusual reason.** Perplexity's
only relevant first-party document is the help-center article
<https://www.perplexity.ai/help-center/en/articles/13915507-adding-custom-remote-connectors>,
which **returns HTTP 403 Forbidden to automated fetch** (bot protection). Both the
canonical URL and the shortened `/articles/13915507` form 403. Perplexity's client is
closed-source, so there is no alternative first-party route.

Search-engine snippets of that article suggest three auth modes (none / API key / OAuth 2.0
with optional manual Client ID+Secret when the server lacks DCR) and
`/.well-known/oauth-authorization-server` scope discovery — but a **search snippet is not a
first-party read**, and quoting it as verified is precisely the HP-17 failure. Recorded as
`unverifiable`.

*Lead only (E3):* <https://community.perplexity.ai/t/custom-mcp-connector-fails-with-did-not-return-a-client-secret-for-rfc-7591-compliant-public-client-registrations/5172>
reports that Perplexity's connector fails when a DCR response omits `client_secret` — i.e. the
same confidential-client requirement documented for Copilot (§3.10). If true this is a
high-value interop finding. **HP-44 should test this explicitly.**

---

### 3.15 cline

Open source. Read directly from `cline/cline` @ `main`, fetched 2026-07-29.

**Architectural finding that drives every field:** Cline authors **no** OAuth protocol code. It
implements the MCP SDK's `OAuthClientProvider` interface and hands it to the SDK transports.
All wire behavior — `resource`, PKCE, discovery, the DCR POST, token exchange — is executed by
`@modelcontextprotocol/sdk`'s `auth()`. **Cline's OAuth profile is therefore a property of its
pinned SDK version, and will change when it bumps that dependency without any Cline code
change.** That is itself the most important thing to record about Cline.

**Pinned SDK version — `verified`, E1.** `apps/vscode/package.json:471` →
`"@modelcontextprotocol/sdk": "^1.25.1"`; `sdk/packages/core/package.json:55` →
`"^1.29.0"`. The committed lockfile resolves both: `bun.lock:1614` →
`"@modelcontextprotocol/sdk@1.29.0"`.

**`sendsResourceIndicator` — `verified` (inherited), with a conditional.** SDK
`src/client/auth.ts` (v1.26.0 `~L470-521`; same logic at v1.29.0) passes `resource` into both
`fetchToken(...)` and `startAuthorization(...)`. But the SDK only emits it when RFC 9728 PRM
was retrieved — `auth.ts` v1.26.0 `~L545-564`:
```ts
// Only include resource parameter when Protected Resource Metadata is present
if (!resourceMetadata) {
    return undefined;
}
```
So Cline sends `resource` **iff the server publishes PRM**. Same conditional shape as VS Code,
reached by a completely different route.

**`oauthSpecVersion` — `verified` (inherited).** Cline pins no revision. Bundled SDK 1.29.0,
`src/types.ts L4-6`:
```ts
export const LATEST_PROTOCOL_VERSION = '2025-11-25';
export const DEFAULT_NEGOTIATED_PROTOCOL_VERSION = '2025-03-26';
export const SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];
```
Auth behavior corresponds to the 2025-06-18+ authorization spec (RFC 9728 PRM discovery +
RFC 8707 resource indicators).

**`protocolVersionPinning` — `verified`: negotiated, NOT pinned.** GitHub code search for
`"mcp-protocol-version"` and `MCP-Protocol-Version` over `cline/cline` both return
`total_count: 0` — **no hardcoded value exists in the Cline repo at all**. The header is set by
the SDK transport *after* negotiation — `src/client/streamableHttp.ts` v1.26.0 `L194-195`:
```ts
if (this._protocolVersion) {
    headers['mcp-protocol-version'] = this._protocolVersion;
```
Same correction as n8n: the in-repo template's `supportedProtocolVersions: ["2025-11-25"]`
(`seed-host-template.ts:1858-1863`, E2) is what the bundled SDK negotiated at capture time,
**not** a Cline-owned pin. Note also that the SDK's `SUPPORTED_PROTOCOL_VERSIONS` includes
`2024-11-05` and `2024-10-07`, so Cline can negotiate down much further than the probe
suggests.

**DCR identity — `verified`, E1.** `client_name` is the literal `"Cline"`, hardcoded in **two**
independent providers:
* `apps/vscode/src/services/mcp/McpOAuthManager.ts L108-116`:
  ```ts
  get clientMetadata(): OAuthClientMetadata {
      return {
          redirect_uris: [this.redirectUrl],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          client_name: "Cline",
      }
  }
  ```
* `sdk/packages/core/src/extensions/mcp/oauth.ts L84-92` — same fields, `client_name: "Cline"`.

Redirect URIs — loopback with **port scanning**, which is unusual and matters for any
server that pins an exact redirect URI. `McpOAuthManager.ts L41` and `L48`:
```ts
const DEFAULT_HTTP_MCP_REDIRECT_URL = "http://127.0.0.1:1456/mcp/oauth/callback"
const MCP_OAUTH_CALLBACK_PORTS = [1456, 1457, 1458, 1459, 1460, 1461]
```
Core defaults are narrower (`sdk/packages/core/src/extensions/mcp/oauth.ts L28-29`:
`[1456, 1457, 1458]`). The advertised `redirect_uris` value is whichever port actually bound
(`oauth.ts L319`), so **it varies per session** — an authorization server must accept the
whole 1456–1461 range, or accept port-agnostic loopback matching per RFC 8252 §7.3.

`token_endpoint_auth_method: "none"` — always a **public client**, never a secret.

MCP `clientInfo.name` (distinct from DCR) is `"Cline"` with the extension version
(`apps/vscode/src/services/mcp/McpHub.ts L452-456`), falling back to `"@cline/core"` / `"0.0.0"`
in the CLI path (`sdk/packages/core/src/extensions/mcp/oauth.ts L269-272`). This confirms the
in-repo probe (`seed-host-template.ts:1859-1863`: `clientInfo: { name: "Cline", version:
"3.89.2" }`) — E1↔E2 cross-confirmation.

**User-Agent — `unverifiable`.** Code searches for `"User-Agent"` scoped to
`apps/vscode/src/shared` and `src/services/mcp` both return `total_count: 0`. No MCP-specific
UA override exists in Cline; the effective value is the Node/undici runtime default, which
cannot be pinned from source.

**Auth model — `verified`, E1.** OAuth2 + PKCE + DCR as a **public client**, on remote
transports only, plus optional user-supplied static headers as an orthogonal mechanism.
The auth provider is attached only to `sse` / `streamableHttp` (`McpHub.ts L465-468`,
`L599-605`), and **stdio is explicitly excluded** with a thrown error
(`sdk/packages/core/src/extensions/mcp/oauth.ts L295-299`).

---

### 3.16 notion

**Auth model — `verified`, E1.** <https://www.notion.com/help/mcp-connections-for-custom-agents>:

> "Custom MCP servers may support one or both of the following sign-in methods: OAuth [and]
> Header-based authentication (for example, API keys or bearer tokens)"

and:

> "Some OAuth servers don't support dynamic client registration (DCR). This means Notion must
> pre-register a client application with the third-party service before OAuth sign-in can work."

That second sentence establishes, first-party, that Notion's default OAuth path **is** DCR
(pre-registration is described as the exception required when DCR is unavailable).

**Everything else — `unverifiable`.** The page explicitly contains no redirect URI, no
`client_name`, no `client_id`, no mention of RFC 8707 / the `resource` parameter, no
`/.well-known/oauth-protected-resource`, and no `MCP-Protocol-Version`. Notion's agent client
is closed-source.

**`protocolVersionPinning` — `unverifiable`, and the in-repo value must NOT be treated as
evidence.** `seed-host-template.ts:1888-1896` records `supportedProtocolVersions: ["2025-11-25"]`
and `clientInfo: { name: "notion", version: "1.0.0" }` — but the file itself flags this at
`:1890-1892`: *"NOTE: name/version are placeholders — only Notion's browser thinking animation
was captured, not its MCP `initialize` handshake."* This is an **E3-equivalent in-repo
placeholder**, not an E2 capture. Anyone reading the template without the comment would
mistake it for probe data. **Requires HP-44.**

---

## 4. Unverifiable — the explicit gap list for HP-44

Grouped by *why* it cannot be closed from a desk, because the reason determines what HP-44 has
to build.

### 4a. Closed-source client, vendor docs silent — needs a live handshake capture

These are the core HP-44 workload. A golden trace of `/authorize` + `/token` + the MCP HTTP
request headers settles all of them at once.

| Client | Fields still open |
| --- | --- |
| claude | `protocolVersionPinning`; DCR `client_name`; User-Agent |
| claude-code | `MCP-Protocol-Version` HTTP header; User-Agent; per-surface confirmation that the loopback flow sends `resource` (carried over from the hosted-surface doc, not independently confirmed) |
| chatgpt | `protocolVersionPinning`; DCR `client_name`; concrete CIMD document (URL is redacted in the doc); User-Agent |
| mistral | `sendsResourceIndicator`; `oauthSpecVersion`; redirect URI; `client_name`; User-Agent |
| slack | `sendsResourceIndicator`; `oauthSpecVersion`; `MCP-Protocol-Version` header; User-Agent |
| cursor | `sendsResourceIndicator`; `oauthSpecVersion` (docs mention only AS metadata, never PRM — suggestive but **not** evidence); `protocolVersionPinning`; `client_name`; User-Agent; and which redirect URI applies at which Cursor version |
| copilot | `sendsResourceIndicator`; exact spec revision; `protocolVersionPinning`; DCR `client_name` + redirect URI (opaque by design — Enterprise token store); User-Agent |
| perplexity | Everything except the `initialize` protocol version. **Additional blocker:** the only first-party doc returns HTTP 403 to automated fetch, so even the doc-level answers need a human with a browser |
| notion | Everything except the auth-model list. The in-repo `2025-11-25` value is a self-declared placeholder, not a capture |

### 4b. Open-source but not reachable in this pass

| Client | Field | Specific reason |
| --- | --- | --- |
| codex | Whether `2024-11-05` would be **accepted** if a server negotiated down | `rmcp` defines `V_2024_11_05` so the capability exists, and `protocol_mode.rs` offers only `2025-06-18` / `2026-07-28` so Codex does not *prefer* it. Whether it accepts a downgrade is not settled by those two files |
| codex | Whether configuring `oauth_resource` really produces **two** `resource` params on `/authorize` | `rmcp` already appends one and `append_query_param` uses `append_pair` (appends, not replaces). No test asserts either way. Labelled an inference in §3.9, not a finding — a live capture settles it in one request |
| goose | Whether the `goose/{ver}` User-Agent reaches the **authorization server** | Verified on the MCP transport (`extension_manager.rs L608-609`), but `oauth/mod.rs:145` calls `OAuthState::new(mcp_server_url, None)` — passing `None` lets `rmcp` build its own HTTP client. Settling it needs a trace of `rmcp` 2.2.0's default client construction. (Codex, by contrast, demonstrably reuses its UA-bearing client) |
| goose | Whether the port-less CIMD redirect actually interoperates | The CIMD registers `http://127.0.0.1/oauth_callback` with no port while Goose sends an ephemeral one. Both halves verified; **no test covers the interaction**. Depends on the AS implementing RFC 8252 §7.3 |
| cline | User-Agent | Code search for `"User-Agent"` under `apps/vscode/src/shared` and `src/services/mcp` → 0 results. No MCP-specific override exists; effective value is the Node/undici runtime default, unpinnable from source |
| n8n | User-Agent | Code search for `"User-Agent"` under `packages/@n8n/nodes-langchain/nodes/mcp` → 0 results. DCR POST goes through `OutboundHttp`; no override located |
| n8n | Exact `node.type` literal sent as `clientInfo.name` | Assembled at runtime by n8n's node loader (package prefix + `name: 'mcpClientTool'`), not a single literal in any file. The in-repo probe (E2) supplies it — `@n8n/n8n-nodes-langchain.mcpClientTool` — but source alone does not |
| vscode | Literal MCP auth spec-revision string | No such constant exists in the source. `oauthSpecVersion` is answerable **only** behaviorally. This is a real property of VS Code, not a research failure |
| vscode | Official-build `client_name` from a shipped `product.json` | The Microsoft `product.json` is not open source; the OSS repo's says `Code - OSS`. Bridged via in-repo string comparisons at `loopbackServer.ts:191/193` — strong, but an inference about a build-time file |
| vscode / cline / n8n | Whether `main` HEAD matches any shipped release | All three were read at `main`/`master` HEAD on 2026-07-29. A user's installed build may differ |
| copilot (github.com / JetBrains / Xcode / CLI) | Everything | Closed source; no public repo exposes their MCP client implementations. Separate implementations from the VS Code extension — **do not extrapolate §3.10b or §3.11 to them** |

### 4c. Structurally unprobeable without paid infrastructure

| Client | Reason |
| --- | --- |
| agentcore | Managed AWS service, closed source, **server-side only** — cannot be probed from a laptop. Closing `sendsResourceIndicator` / `oauthSpecVersion` / DCR identity requires an AWS account with a Bedrock AgentCore Gateway and an MCP-server target provisioned. Budget this explicitly; it is the one catalog entry HP-44 cannot cover for free |

### 4d. Fields that are structurally undefined rather than unknown

* **mcpjam User-Agent.** MCPJam's OAuth runs in the browser, and browsers forbid scripts from
  setting `User-Agent`. There is no value to capture on that surface. Record as **N/A**, not
  as a gap.
* **copilot DCR redirect URI.** Microsoft documents that the Enterprise token store owns it
  and the developer never sees it. A capture may still reveal it on the wire, but the field
  is "intentionally not part of the public contract", which is different from "unknown".

---

## 5. Route to conformance suite — server obligations, not host quirks

Several items collected during this investigation read like "client behavior" but are
actually **obligations on the MCP server or its authorization server**. They must **not**
become per-host profile fields: encoding them per-host would mean re-testing the same server
rule 16 times and would let a server-side bug masquerade as a host quirk. They belong in the
OAuth conformance suite (`sdk/src/oauth-conformance/`, driven by `OAuthConformanceSuite` in
`sdk/src/oauth-conformance/suite.ts`).

| # | Obligation | Source | Existing coverage |
| --- | --- | --- | --- |
| S1 | On 401, emit `WWW-Authenticate: Bearer resource_metadata="…"`. **A `WWW-Authenticate` header on a `200` is not honored** — the 401 status is mandatory | Anthropic connectors auth doc, §"Cross-host authorization servers" (E1) | Not obviously covered; `sdk/src/oauth-conformance/checks/oauth-negative.ts` has `runInvalidTokenCheck` — extend it to assert the header shape and the 401 status |
| S2 | PRM document's `resource` field must equal the MCP server URL exactly, including path | Anthropic auth doc (E1); mirrored in MCPJam's own enforcement at `sdk/src/oauth/state-machines/shared/resource-indicator.ts:56-79` | Partially — MCPJam already enforces "PRM missing required `resource`" per RFC 9728 §2. Promote to a first-class conformance check |
| S3 | AS metadata must advertise `"code_challenge_methods_supported": ["S256"]` | Anthropic auth doc + troubleshooting (E1) | Add |
| S4 | AS must serve **at least one** of `/.well-known/oauth-authorization-server` (RFC 8414) or `/.well-known/openid-configuration`; a 404 on one is fine if the other is 200 | Anthropic troubleshooting, §"OAuth discovery fails" (E1) | Add — assert "at least one", not "both" |
| S5 | PRM must be resolvable at the **path-aware** well-known URL first, then the root form | Anthropic troubleshooting (E1); `rmcp` `well_known_paths(base_url.path(), "oauth-protected-resource")` (E1) | Add as a ladder-ordering check |
| S6 | Token endpoint must accept `Content-Type: application/x-www-form-urlencoded`; the `/register` endpoint uses `application/json`. Returning `415` on the token endpoint is a common framework default | Anthropic auth doc, §"Token refresh" (E1) | Add — cheap, high hit-rate |
| S7 | Return RFC 6749-compliant error codes — `invalid_grant`, **not** `invalid_request` or a custom code — when a refresh token is invalid | Anthropic auth doc (E1) | Partially — `oauth-negative.ts` has `runInvalidClientCheck`; extend to refresh-grant errors |
| S8 | Rotate or sender-constrain refresh tokens for public clients; if rotating, return the new refresh token in the same response that invalidates the old one | Anthropic auth doc (E1) | Add |
| S9 | Server must validate the token audience (`aud`) against the **canonical** resource form — lowercase scheme/host, no trailing slash, no fragment, no default port — rather than byte-comparing what the user typed | Anthropic troubleshooting, §"Audience mismatch" (E1); MCPJam already has `canonicalizeResourceUrl` | Add; reuse the existing canonicalizer |
| S10 | `authorization_servers` in PRM: **only the first entry is used** by at least Claude, with no fallback. A server listing a broken issuer first is broken for those clients | Anthropic auth doc (E1) | Add as a **warning-level** check (it is a client policy hardening into a de-facto server obligation) |
| S11 | AS must display the redirect-URI hostname on the consent screen, and should warn when the only registered redirect URIs are loopback | MCP spec §"Localhost redirect URI risks", cited by Anthropic (E1) | Not machine-testable — document as a manual review item |
| S12 | AS response-time budget: token/discovery/registration responses within ~10 s, refresh within ~30 s, or Claude treats the flow as failed | Anthropic auth doc, §"Endpoint latency" (E1) | Add as a latency-threshold check |
| S13 | AS metadata must advertise a `registration_endpoint` for any DCR-only client to work at all | RFC 7591/8414; enforced independently by Cline (no hardcoded `client_id` exists), n8n (`oauth.service.ts L1061-1062, L1116`), and Codex (DCR-first, no pre-registered path) (E1) | Add — this is the single highest-frequency real-world failure across the catalog |
| S14 | Server must publish PRM, or resource indicators silently disappear | SDK `auth.ts`: `if (!resourceMetadata) { return undefined; }` (Cline, E1); VS Code's guarded `if (this._resourceMetadata?.resource)` (E1) | Add — and make the check **loud**: a server without PRM does not get an error, it gets a *silently weaker* flow with no audience binding. That silence is the danger |
| S15 | PRM `resource` MUST equal the target resource URL | VS Code hard-fails on mismatch (`oauth.ts ~L1241`, citing RFC 9728 explicitly); n8n throws `InvalidTargetError` (`oauth.service.ts L243`); `rmcp` has `validate_resource_metadata_resource` (E1) | Merge with S2 — now confirmed by **four** independent client implementations, so it is unambiguously a server obligation |
| S16 | Discovery endpoints must **tolerate a stale or unexpected `MCP-Protocol-Version` header**, including `2024-11-05` | `rmcp` hardcodes `.header(HEADER_MCP_PROTOCOL_VERSION, "2024-11-05")` on OAuth discovery (`auth.rs ~L2623`, E1) — affecting **both** Codex and Goose | **Add — new, and non-obvious.** A server that gates `/.well-known/*` responses on the protocol header will break for every `rmcp`-based client while working fine for TS-SDK-based ones |
| S17 | AS metadata must include `issuer` (RFC 8414) | RFC 8414; Codex **deliberately relaxes** this (`set_allow_missing_issuer(true)`, `perform_oauth_login.rs:656`, `auth_status.rs:221`, E1) | Add at **error** level. Codex's leniency is a client courtesy, not a licence — a server omitting `issuer` is out of spec and will fail against stricter clients |

**Items that are genuinely per-host fields, NOT server obligations** — explicitly do *not*
route these to the conformance suite. Each is a client constraint that makes an
otherwise-conformant server incompatible with exactly one host, and encoding them as server
rules would produce false failures:

* **Copilot requires a `client_secret` from DCR** — *"DCR without a client secret isn't
  supported yet"* (§3.10). Every other DCR client in the catalog registers as a public client.
  The suite should at most emit an informational note: "this server registers public clients;
  Microsoft 365 Copilot will reject it."
* **VS Code treats `403` as an auth challenge; Claude honors only `401`** (§3.11, §3.2). These
  two verified behaviors **directly contradict each other**. There is no single correct server
  behavior to test — the suite should assert `401` (the spec answer) and separately note that
  a `403`-returning server will work in VS Code and fail in Claude.
* **"Only the first `authorization_servers` entry is used"** — verified independently for
  Claude (docs) and VS Code (source `TODO`). Listed above as S10 at **warning** level
  deliberately: it is a client limitation hardening into a de-facto server obligation, and
  should be reported as advice, not a failure.
* **Cline's loopback port range 1456–1461** and **Codex's ephemeral loopback port** — servers
  that pin an exact redirect URI break for these clients. That is a per-host profile fact, and
  the relevant *server* obligation is the RFC 8252 §7.3 port-agnostic loopback match, which is
  already covered by S11's neighbourhood.
* **n8n's deployment-specific hosted redirect URI** — cannot be a constant in any fixture.
* **Goose's `body.starts_with("HTTP 401")` string-prefix sniff** (§3.6). A server that signals
  auth any other way gets no OAuth attempt from Goose. The *server* obligation (return a real
  401 with `WWW-Authenticate`) is already S1; Goose's brittleness in detecting it is a host fact.
* **Goose connects unauthenticated first, then falls back to OAuth on 401** — the opposite
  ordering from Claude/ChatGPT. Not a server rule; but any HP-44 trace fixture must expect an
  unauthenticated first request from Goose or it will look like a bug.
* **Codex's `set_allow_missing_issuer(true)`** — routed as S17 at error level *for the server*,
  but recorded here as a per-host field too, because "works in Codex, fails elsewhere" is
  exactly the kind of asymmetry a host profile exists to capture.

---

## 6. Honest assessment: desk research vs HP-44

**What desk research closed (roughly 55–60% of the 96 cells — better than expected, because
four clients turned out to be readable at the source level and two vendors publish
machine-readable client metadata):**

* **3 of the 4 "known prior findings" were re-derived, and 2 of them were wrong.** Both the
  "Claude Desktop omits `resource`" and "ChatGPT omits `resource`" claims are **refuted by the
  vendors' own documentation, in explicit prose**. Both vendors document sending `resource`
  on *both* legs. The "Claude.ai implements 2025-03-26" claim is likewise refuted. These three
  were HP-17-style lore and would have poisoned any conformance work built on them.
* **`codex` and `goose` are fully closed from source**, both read from local clones at pinned
  SHAs with the `rmcp` dependency pulled at its exact pinned version. The prior
  "Codex pins 2025-06-18" belief is **upheld** in its practical form (it is the default
  preference; `2026-07-28` exists behind an off-by-default flag), and the prior
  "Codex sends no User-Agent" belief is **refuted** — it sends
  `codex-mcp-client/{version}` and demonstrably reuses that client on the OAuth leg.
* **`goose` is a split-revision client** — RFC 9728 PRM discovery on the OAuth wire
  (2025-06-18+) while hard-pinning `2025-03-26` on the MCP wire, two revisions behind what its
  own SDK defaults to. It is the only catalog client whose two layers disagree, and the only
  one where a `2025-03-26` pin is verified in source rather than merely observed.
* **A cross-cutting `rmcp` finding worth more than either client:** every `rmcp`-based client
  (Codex *and* Goose) sends a **hardcoded `MCP-Protocol-Version: 2024-11-05` on OAuth discovery
  requests** while negotiating a much newer version on the MCP leg. This is invisible from any
  vendor doc and would never have surfaced without reading the dependency. It is now S16.
* **`mcpjam` is fully closed** — it is this repo, everything is first-party and exact.
* **`vscode` is the best-verified third-party client in the catalog**, and the only one where
  even the **User-Agent** was readable from source. It also produced the most conformance-
  relevant single fact in this investigation: VS Code **pins** `2025-11-25` as a client and
  sends the `MCP-Protocol-Version` header **only on OAuth discovery, never on MCP traffic**.
* **`cline` and `n8n` are fully readable and sit at opposite architectural extremes** — Cline
  authors zero OAuth code (100% SDK-delegated, so its profile is a property of its pinned SDK
  version), n8n hand-rolls the entire protocol. That distinction is more useful than any
  individual field: **an SDK-delegated client's profile is not stable across its own releases**,
  and any golden trace for Cline must record the resolved SDK version alongside it.
* **The n8n `x-consumer-api-key` refutation independently re-confirmed** — 0 occurrences in the
  entire repo, and the generic `httpHeaderAuth` credential (arbitrary user-supplied header
  name) fully explains the original observation. The Kong-gateway explanation stands.
* **`copilot` split into three unrelated clients**, which the single catalog row was hiding.
  GitHub Copilot Chat in VS Code implements **no MCP OAuth at all** (verified by exhaustive
  negative search across 5,267 files) and uses static bearer injection for its own server;
  Microsoft 365 Copilot is a genuinely separate DCR client with a unique
  **confidential-client-required** constraint; the other Copilot surfaces are closed source.
* **`agentcore`'s protocol-version pin is refuted** from AWS docs (4 negotiated versions, not
  1 pinned), which also corrects a value in our own template.
* **Auth models are the best-covered field: 14 of 16 verified.** Vendors document *what kinds*
  of auth they support even when they document nothing about the wire.
* **Two vendors publish machine-readable client metadata** (Anthropic for Claude Code, Slack
  for Slackbot). Those gave exact `client_name` / `redirect_uris` / `token_endpoint_auth_method`
  with zero inference. Worth checking for a CIMD document as a standard first move on any
  future host.

**What genuinely requires HP-44:**

* **`sendsResourceIndicator` is 9/16 settled** — verified for mcpjam, codex, goose, vscode,
  cline, n8n; refuted-into-positive for claude, claude-code, chatgpt. The remaining 7
  (mistral, slack, cursor, copilot, agentcore, perplexity, notion) are simply not documented
  anywhere and are all closed-source. Still the field with the worst desk yield among
  closed-source hosts, and the one the conformance work most depends on.
* **A subtlety HP-44 must capture, not just a yes/no.** Three of the five source-verified
  clients send `resource` **conditionally** — VS Code and Cline both omit it entirely when PRM
  discovery fails, and Codex's is caller-supplied `Option<&str>`. And the *value* differs:
  Claude and ChatGPT document the **canonicalized MCP server URL**, while VS Code sends the
  **PRM document's `resource` field**. A boolean `sendsResourceIndicator` column is therefore
  the wrong schema. The profile needs `{ sent: always | if-PRM | never, value: server-url |
  prm-resource }`.
* **`protocolVersionPinning` is the most systematically mis-answerable field.** There are
  **two different things** wearing that name: the `protocolVersion` in the MCP `initialize`
  body, and the `MCP-Protocol-Version` HTTP header. Our in-repo probes captured the former for
  9 hosts; **not one** of them tells us the latter. VS Code proves the two can diverge sharply
  — it pins `2025-11-25` in `initialize` but sends the header **only on OAuth discovery
  requests and never on MCP traffic at all**. Anyone reading the template's
  `supportedProtocolVersions` as an answer to HP-47 field 3 will be wrong. HP-44 must capture
  raw HTTP headers, not just the `initialize` body.
* **A second `protocolVersionPinning` trap, now demonstrated twice.** For SDK-delegated clients
  (cline, n8n) the captured version is what the *bundled SDK* negotiated, not a client-owned
  pin — it drifts with a dependency bump. And VS Code contains a real
  `SUPPORTED_PROTOCOL_VERSIONS` list that belongs to VS Code-as-**gateway-server**, not
  VS Code-as-client; reading it as client behavior would be a textbook HP-17 error. Both
  distinctions must be encoded in the profile schema or they will be lost.
* **User-Agent is 3/16 verified** — VS Code (`Visual Studio Code/<version>`), Codex
  (`codex-mcp-client/{ver}`, confirmed to reach the AS), Goose (`goose/{ver}`, but **whether it
  reaches the AS is unverifiable**). No vendor documents it, and it is invisible from source
  for anything delegating to a default HTTP client (confirmed by exhaustive negative searches
  for Cline and n8n). Still substantially a trace-capture field — and note that two of the
  three required reading a *dependency*, not the client.
* **`client_name` at DCR is 9/16.** Known: mcpjam (six distinct identities), codex (`Codex`),
  goose (`goose`), vscode (`Visual Studio Code` / `Code - OSS`), cline (`Cline`), n8n (`n8n`),
  claude-code (`Claude Code`, published CIMD), slack (`Slack`, published CIMD). Everything else
  needs a trace. Every single one came from either open source or a vendor-published CIMD —
  **not one** came from prose documentation. **Checking for a CIMD document at a guessable
  well-known URL should be the standard first move on any new host**; it paid off three times
  here (Claude Code, Slack, Goose) and cost one HTTP request each.
* **`agentcore` cannot be captured without paid AWS infrastructure.** Flag this early; it is
  the one entry HP-44 cannot cover on a developer laptop.

**Two process recommendations arising from this pass:**

1. **Distinguish E2 (real capture) from placeholder in the templates themselves.** Three
   templates — `agentcore`, `notion`, and parts of `copilot` — carry values that *look* like
   probe data and are only disclosed as guesses in a comment. The `agentcore` and `notion`
   comments are exemplary and should be the model; but a comment is not a machine-readable
   marker. A `provenance: "probe" | "guess" | "doc"` field on `mcpProfile.initialize` would
   make the distinction impossible to lose, and would have prevented me from nearly recording
   AgentCore's `2025-06-18` as evidence.
2. **Correct the ticket's host count from 9 to 16**, and separately decide where OAuth profile
   data lives — today the host-config schema has nowhere to put any of it.
3. **Record the SDK, not just the host.** Five of the six source-verified clients get some or
   all of their OAuth behavior from a dependency: cline and n8n from `@modelcontextprotocol/sdk`
   (1.29.0 and 1.26.0 respectively), codex and goose from `rmcp` (3.0.0-beta.3 and 2.2.0). Two
   of the sharpest findings in this document — the hardcoded `MCP-Protocol-Version: 2024-11-05`
   on `rmcp` discovery, and the `if (!resourceMetadata) return undefined` gate in the TS SDK —
   live in dependencies, not in any host's own code. A host profile that records only the host
   version will silently go stale on a dependency bump. **Every profile row needs an
   `oauthImplementation: { kind: "first-party" | "sdk", package?, version? }` field**, and
   HP-44 traces should capture the resolved dependency version alongside the host version.

### Bottom line

Desk research took HP-47 from "9 hosts, mostly lore" to **16 hosts with roughly 55–60% of cells
carrying a citation**, and it **refuted four standing beliefs** (Claude omits `resource`;
ChatGPT omits `resource`; Claude.ai is on 2025-03-26; Codex sends no User-Agent) while
**upholding two** (Codex prefers 2025-06-18; n8n has real OAuth2+DCR and the
`x-consumer-api-key` header was never n8n's). That ratio — four wrong out of six checkable
priors — is almost exactly HP-17's, which suggests the lore-to-evidence conversion rate in this
domain is genuinely poor and that this kind of pass is worth repeating rather than assuming.

What remains is not a research shortfall; it is a **structural** limit. Seven of the sixteen
clients are closed source with vendors who document *what* auth they accept but never *what
they put on the wire*. For those, no amount of further reading will help: `sendsResourceIndicator`,
`MCP-Protocol-Version`, `client_name`, and User-Agent are only knowable by watching a real
handshake. **HP-44 is not optional polish on this work — it is the only remaining instrument.**
Its highest-value first targets, ranked by (uncertainty × blast radius): **cursor**
(is it pre-PRM or not?), **slack** and **mistral** (DCR clients with zero wire documentation),
**copilot** (does the confidential-client requirement really hold?), and **perplexity** (whose
only doc is unreachable to automation at all).
