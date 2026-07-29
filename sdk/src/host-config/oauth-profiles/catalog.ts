/**
 * HP-47 OAuth profile seed for the 16 built-in host templates.
 *
 * TRANSCRIBED — not researched here. Every value and every `source` string in
 * this file comes verbatim from `docs/host-oauth-profiles/HP-47-investigation.md`
 * (branch `docs/hp-47-client-oauth-investigation`, commit 5f5e55f4a). Nothing was
 * inferred, upgraded, or filled in while transcribing. Where the report's finding
 * did not map cleanly onto `HostConfigOAuthProfileV1`, the field is recorded as
 * `unverifiable` with a reason naming the mismatch, and the underlying finding is
 * preserved in that profile's `extensions` rather than being forced into the type.
 *
 * Evidence-class legend (carried over from the report; `source` strings state which):
 *   E1 — upstream first-party source code, an official vendor doc, or a
 *        vendor-published machine-readable artifact (e.g. a hosted CIMD document).
 *   E2 — a live wire capture recorded inside the MCPJam repo with a provenance
 *        comment (`sdk/src/host-config/templates/seed-host-template.ts`).
 *   E3 — third-party report (GitHub issue, forum post, search snippet). NEVER
 *        sufficient for `verified`; appears here only inside `extensions` as a lead.
 *
 * Two systematic mapping notes, both explained per-host below:
 *
 *  1. `oauthSpecVersion` is a closed enum of exactly four MCP revision dates. Six
 *     hosts (mcpjam, goose, codex, vscode, n8n, cline) have report findings that are
 *     real but are not one of those four literals — "implements four revisions",
 *     "2025-06-18-or-later shape", "2025-06-18-era", "SDK supports 2025-11-25 …
 *     2024-10-07". Those are `unverifiable` here with the mismatch stated. This is a
 *     schema-expressiveness gap, not a research gap.
 *
 *  2. `protocolVersionPinning` requires a `pinned` vs `negotiated` discriminant.
 *     Four hosts (claude-code, mistral, slack, perplexity) have only an E2 capture of
 *     the version in the `initialize` body, which does NOT establish the discriminant:
 *     the report proves for cline and n8n that a single-element captured version is the
 *     bundled SDK's negotiated outcome rather than a client-owned pin. Those four are
 *     therefore `unverifiable`, with the observed version preserved in `extensions`.
 *
 * `capturedAt` is 2026-07-29 throughout — the single date on which all evidence in the
 * report was gathered.
 */

import type { HostConfigOAuthProfileV1 } from "../types.js";

const CAPTURED = "2026-07-29";

export const HP47_OAUTH_PROFILE_SEED: Record<string, HostConfigOAuthProfileV1> = {
  // ── mcpjam ─────────────────────────────────────────────────────────────────
  // E1 throughout — this is MCPJam's own repo, so line numbers are exact rather
  // than approximate. Production OAuth runs MCPJam's own state-machine runner, NOT
  // the upstream TS SDK's auth(), so the state machines ARE the shipped behavior.
  mcpjam: {
    profileVersion: 1,
    sendsResourceIndicator: {
      status: "verified",
      value: true,
      source:
        "E1 — sdk/src/oauth/state-machines/debug-oauth-2025-06-18.ts:1404-1407 (authUrl.searchParams.set(\"resource\", ...)) and :1562-1565 (tokenRequestBody.set(\"resource\", ...)). Production path confirmed via mcpjam-inspector/client/src/lib/oauth/mcp-oauth.ts:1-3,21 which runs runOAuthStateMachine from @mcpjam/sdk/browser.",
      capturedAt: CAPTURED,
    },
    oauthSpecVersion: {
      status: "unverifiable",
      reason:
        "SCHEMA MISMATCH, not a research gap. The report verifies (E1) that MCPJam implements FOUR revisions concurrently — one state machine each for 2025-03-26, 2025-06-18, 2025-11-25 and 2026-07-28, selected by sdk/src/oauth/state-machines/factory.ts. The schema holds a single enum member and cannot express a multi-revision client. See extensions.oauthSpecVersionsImplemented.",
      capturedAt: CAPTURED,
    },
    protocolVersionPinning: {
      status: "verified",
      value: { mode: "pinned", version: "2025-11-25" },
      source:
        "E1 — sdk/src/oauth/browser-auth.ts:20 `const LATEST_PROTOCOL_VERSION = \"2025-11-25\";` is the default when unspecified. Each state machine additionally hardcodes its own header value (debug-oauth-2025-06-18.ts:540,592; debug-oauth-2025-03-26.ts:492,607; debug-oauth-2025-11-25.ts:658,710) — see extensions.protocolVersionPinningNotes.",
      capturedAt: CAPTURED,
    },
    dcrIdentity: {
      status: "verified",
      value: {
        clientName: "MCPJam - <serverName>",
        redirectUris: ["http://localhost:6274/oauth/callback"],
      },
      source:
        "E1 — mcpjam-inspector/client/src/lib/oauth/mcp-oauth.ts:2133 (client_name), :2136 (redirect_uris), :2138 (token_endpoint_auth_method). Redirect URI derived from window.location by mcpjam-inspector/client/src/lib/oauth/constants.ts:45-54, with the literal fallback recorded here.",
      capturedAt: CAPTURED,
    },
    authModel: {
      status: "verified",
      value: ["oauth2-dcr", "oauth2-cimd"],
      source:
        "E1 — DCR client metadata at mcpjam-inspector/client/src/lib/oauth/mcp-oauth.ts:2130-2139; CIMD path at sdk/src/oauth/client-identity.ts:7-8 (DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL). Report §3.1 summarises the model as 'Full OAuth2 + DCR, plus a CIMD path'.",
      capturedAt: CAPTURED,
    },
    extensions: {
      evidenceClass: "E1",
      oauthSpecVersionsImplemented: [
        "2025-03-26",
        "2025-06-18",
        "2025-11-25",
        "2026-07-28",
      ],
      protocolVersionPinningNotes:
        "Per-machine pinned, not a single value. The typed field carries the DEFAULT (2025-11-25, browser-auth.ts:20). Each state machine sends its own matching MCP-Protocol-Version header.",
      dcrIdentityGaps:
        "userAgent is structurally N/A, not unknown: MCPJam's OAuth runs in the browser and browsers forbid scripts from setting User-Agent (report §4d).",
      unmappedAuthModels:
        "Enterprise-Managed Authorization / Cross-App Access (ID-JAG, pinned to draft-ietf-oauth-identity-assertion-authz-grant-04, sdk/src/oauth/client-identity.ts:49-58) has no member in the OAuthAuthModel enum and is therefore absent from authModel.",
      additionalClientNames:
        "Five further DCR identities exist on other MCPJam surfaces (report §3.1 table): 'MCP Inspector Debug Client' (2025-03-26 debugger, client-identity.ts:12), 'MCPJam Inspector Debug Client' (:13-15), 'MCPJam SDK OAuth Conformance' (:30,41), 'MCPJam XAA Debugger' (:84), 'MCPJam Connect' (:105). The typed clientName carries the server-connect flow only.",
      divergenceFlag:
        "MCPJam's 2025-03-26 machine also sends `resource` (debug-oauth-2025-03-26.ts:1023-1025, :1169), sourced from the server URL. 2025-03-26 predates resource indicators in MCP, so this is a deliberate MCPJam choice and a divergence from any real 2025-03-26 client.",
    },
  },

  // ── claude (claude.ai web / Desktop / mobile / Cowork) ──────────────────────
  // E1 official Anthropic docs. All four surfaces share one backend per
  // claude.com/docs/connectors/building/authentication. Carries TWO refutations of
  // prior lore (resource param, and the 2025-03-26 spec belief).
  claude: {
    profileVersion: 1,
    sendsResourceIndicator: {
      status: "refuted",
      value: true,
      source:
        "E1 — REFUTES the prior claim that Claude Desktop omits the RFC 8707 resource param. https://claude.com/docs/connectors/building/troubleshooting §'Authorization with the MCP server failed' → 'Audience mismatch': \"Claude sends the RFC 8707 `resource` parameter on authorization and token requests, set to the canonical form of your MCP server URL — lowercase scheme and host, no trailing slash, no fragment, no default port — including any path component.\" Corroborated on the same page by §'Microsoft Entra ID rejects the resource value'.",
      capturedAt: CAPTURED,
    },
    oauthSpecVersion: {
      status: "verified",
      value: "2025-11-25",
      source:
        "E1 — https://claude.com/docs/connectors/building/authentication and .../troubleshooting. Every normative spec link targets modelcontextprotocol.io/specification/2025-11-25/basic/authorization. Also REFUTES the prior belief that claude.ai web implements 2025-03-26: the docs describe the RFC 9728 path-aware PRM ladder (\"/.well-known/oauth-protected-resource/<your-mcp-path> first, then /.well-known/oauth-protected-resource\") and resource indicators, neither of which exists in 2025-03-26.",
      capturedAt: CAPTURED,
    },
    protocolVersionPinning: {
      status: "unverifiable",
      reason:
        "Closed-source connector backend. Neither official page states an MCP-Protocol-Version header value, and there is no E2 capture (the claude template in seed-host-template.ts sets no supportedProtocolVersions). Requires HP-44.",
      capturedAt: CAPTURED,
    },
    dcrIdentity: {
      status: "verified",
      value: { redirectUris: ["https://claude.ai/api/mcp/auth_callback"] },
      source:
        "E1 — https://claude.com/docs/connectors/building/authentication §'Callback URLs': \"For the hosted Claude surfaces (Claude.ai web, Desktop, mobile, and Cowork), register the following redirect URI: https://claude.ai/api/mcp/auth_callback\". clientName and userAgent are NOT covered by this evidence — see extensions.dcrIdentityGaps.",
      capturedAt: CAPTURED,
    },
    authModel: {
      status: "verified",
      value: [
        "oauth2-cimd",
        "oauth2-dcr",
        "oauth2-preregistered",
        "api-key",
        "none",
      ],
      source:
        "E1 — https://claude.com/docs/connectors/building/authentication §'Supported authentication types' table: oauth_dcr (RFC 7591), oauth_cimd, oauth_anthropic_creds, custom_connection, static_headers (beta), none. CIMD-before-DCR ordering is report-backed: \"Claude selects CIMD only when your authorization server metadata advertises both ... If either is missing, Claude falls back to DCR.\" See extensions.authModelOrderCaveat for the rest of the ordering.",
      capturedAt: CAPTURED,
    },
    extensions: {
      evidenceClass: "E1",
      dcrIdentityGaps:
        "clientName unverifiable — neither official page states the literal DCR client_name, and unlike Claude Code the hosted surfaces publish no fetchable CIMD document. userAgent unverifiable — not documented, closed-source backend. Both require HP-44.",
      authModelOrderCaveat:
        "Only the CIMD-before-DCR precedence is report-backed. The trailing three entries (oauth2-preregistered ← oauth_anthropic_creds, api-key ← static_headers, none) follow the vendor doc's own table order and are NOT a verified preference ranking.",
      unmappedAuthModels:
        "`custom_connection` (custom URL or credentials supplied at connection time, Snowflake-style) has no member in the OAuthAuthModel enum and is absent from authModel.",
      refutedByVendorDoc:
        "Machine-to-machine client_credentials is explicitly NOT supported: \"A pure machine-to-machine client_credentials grant ... is not supported. Every connection requires user consent.\"",
      clientQuirks: [
        "DCR registers a NEW client on every fresh connection.",
        "CIMD selected only when AS metadata advertises BOTH client_id_metadata_document_supported:true AND \"none\" in token_endpoint_auth_methods_supported.",
        "Appends offline_access when the AS advertises it in scopes_supported.",
        "Uses ONLY the first authorization_servers entry, with no fallback.",
        "Honors WWW-Authenticate only on a 401 — explicitly not on a 200. (Contrast VS Code, which also accepts 403.)",
        "Timeouts: 10s discovery/registration/token, 30s refresh. Egress fixed to 160.79.104.0/21; connectors are IPv4-only.",
      ],
    },
  },

  // ── claude-code ────────────────────────────────────────────────────────────
  // E1 vendor-published CIMD document (fetched live) + E1 docs + E2 in-repo probe.
  // CIMD-first per the coordinator's note and the report; Claude Code explicitly
  // does NOT use Anthropic-held credentials.
  "claude-code": {
    profileVersion: 1,
    sendsResourceIndicator: {
      status: "refuted",
      value: true,
      source:
        "E1 — REFUTES the prior 'omits resource' claim. Same Anthropic connectors doc-set as `claude` (https://claude.com/docs/connectors/building/troubleshooting §'Audience mismatch'), whose stated scope includes Claude Code. CARRY-OVER CAVEAT recorded by the report: the sentence is not scoped per-surface and Claude Code's loopback flow is a different code path from the hosted backend, so the report grades this a MEDIUM-CONFIDENCE carry-over and asks HP-44 to capture Claude Code's authorize+token legs directly rather than inherit it.",
      capturedAt: CAPTURED,
    },
    oauthSpecVersion: {
      status: "verified",
      value: "2025-11-25",
      source:
        "E1 — https://claude.com/docs/connectors/building/authentication: \"The same infrastructure backs Claude.ai, Claude Desktop, Claude mobile, Claude Code, and Cowork.\" All normative spec links on that doc-set target modelcontextprotocol.io/specification/2025-11-25/basic/authorization.",
      capturedAt: CAPTURED,
    },
    protocolVersionPinning: {
      status: "unverifiable",
      reason:
        "SPLIT FINDING the schema cannot hold, plus an unresolved discriminant. (a) The MCP-Protocol-Version HTTP header is unverifiable — Claude Code ships as bundled/minified JS with no public source. (b) An E2 capture exists for the version in the `initialize` body (2025-11-25) but does not establish pinned-vs-negotiated; the report proves for cline and n8n that a single captured version can be an SDK-negotiated outcome rather than a client pin. See extensions.protocolVersionPinningNotes. Requires HP-44.",
      capturedAt: CAPTURED,
    },
    dcrIdentity: {
      status: "verified",
      value: {
        clientName: "Claude Code",
        redirectUris: ["http://localhost/callback", "http://127.0.0.1/callback"],
      },
      source:
        "E1 — Anthropic's vendor-published Client ID Metadata Document, fetched live 2026-07-29 from https://claude.ai/oauth/claude-code-client-metadata: {\"client_id\":\"https://claude.ai/oauth/claude-code-client-metadata\",\"client_name\":\"Claude Code\",\"client_uri\":\"https://claude.ai\",\"redirect_uris\":[\"http://localhost/callback\",\"http://127.0.0.1/callback\"],\"grant_types\":[\"authorization_code\",\"refresh_token\"],\"response_types\":[\"code\"],\"token_endpoint_auth_method\":\"none\"}. Corroborated in prose by claude.com/docs/connectors/building/authentication §'Callback URLs'.",
      capturedAt: CAPTURED,
    },
    authModel: {
      status: "verified",
      value: ["oauth2-cimd"],
      source:
        "E1 — https://claude.com/docs/connectors/building/authentication: \"Claude Code runs its own OAuth flow on the user's machine and identifies itself with its own Client ID Metadata Document, so it does not use Anthropic-held credentials.\" Public client (token_endpoint_auth_method:\"none\" in the CIMD), PKCE S256 mandatory on every authorization request.",
      capturedAt: CAPTURED,
    },
    extensions: {
      evidenceClass: "E1 (vendor CIMD + official docs), E2 (in-repo probe)",
      protocolVersionPinningNotes:
        "E2 capture: seed-host-template.ts:757-772 seeds supportedProtocolVersions:[\"2025-11-25\"] with clientInfo {name:\"claude-code\", title:\"Claude Code\", version:\"2.1.176\"}, annotated at :702-704 as \"Verbatim from a live mcpjam-learn start-host-probe against Claude Code CLI v2.1.176\". This is the initialize-body version only; the MCP-Protocol-Version HTTP header remains unknown, and pinned-vs-negotiated is not established.",
      runtimeRedirectForm:
        "RFC 8252 loopback on an ephemeral port at runtime — doc example \"http://localhost:3118/callback\"; \"The port varies per session.\" The two registered URIs above are what the CIMD declares; the AS must match them port-agnostically per RFC 8252 §7.3.",
      dcrIdentityGaps:
        "userAgent unverifiable — no public source (bundled JS). A lead only (E3, NOT evidence): openai/codex issue #16485 asserts in passing that Claude Code does send a UA where Codex did not.",
      cimdOmissions: "`scope` and `logo_uri` are absent from the published CIMD document.",
    },
  },

  // ── chatgpt ────────────────────────────────────────────────────────────────
  // E1 official OpenAI Apps SDK docs. Carries the second resource-param refutation.
  chatgpt: {
    profileVersion: 1,
    sendsResourceIndicator: {
      status: "refuted",
      value: true,
      source:
        "E1 — REFUTES the prior claim that ChatGPT omits the RFC 8707 resource param. https://developers.openai.com/apps-sdk/build/auth: \"Expect ChatGPT to append resource=https%3A%2F%2Fyour-mcp.example.com to both the authorization and token requests.\" The doc does not name RFC 8707, but the parameter name, both-leg placement, and server-URL value are exactly RFC 8707 semantics.",
      capturedAt: CAPTURED,
    },
    oauthSpecVersion: {
      status: "verified",
      value: "2025-11-25",
      source:
        "E1 — https://developers.openai.com/apps-sdk/build/auth links the \"MCP authorization spec\" at modelcontextprotocol.io/specification/2025-11-25/basic/authorization and requires PRM: \"GET https://your-mcp.example.com/.well-known/oauth-protected-resource\".",
      capturedAt: CAPTURED,
    },
    protocolVersionPinning: {
      status: "unverifiable",
      reason:
        "Closed-source connector backend; the auth doc says nothing about MCP-Protocol-Version. No E2 capture either — seed-host-template.ts:842-848 records clientInfo {name:\"openai-mcp\", version:\"1.0.0\"} but sets NO supportedProtocolVersions. Requires HP-44.",
      capturedAt: CAPTURED,
    },
    dcrIdentity: {
      status: "verified",
      value: {
        redirectUris: [
          "https://chatgpt.com/connector/oauth/{callback_id}",
          "https://chatgpt.com/connector_platform_oauth_redirect",
        ],
      },
      source:
        "E1 — https://developers.openai.com/apps-sdk/build/auth: \"ChatGPT completes the OAuth flow by redirecting to https://chatgpt.com/connector/oauth/{callback_id}\", with the legacy https://chatgpt.com/connector_platform_oauth_redirect noted as still working. clientName and userAgent are NOT covered — see extensions.dcrIdentityGaps.",
      capturedAt: CAPTURED,
    },
    authModel: {
      status: "verified",
      value: ["oauth2-dcr", "oauth2-cimd"],
      source:
        "E1 — https://developers.openai.com/apps-sdk/build/auth documents DCR (RFC 7591) or CIMD, the latter supporting both public-client (none) and signed-assertion (private_key_jwt) token exchange. Listing order follows the vendor doc; see extensions.authModelOrderCaveat.",
      capturedAt: CAPTURED,
    },
    extensions: {
      evidenceClass: "E1",
      authModelOrderCaveat:
        "No precedence between DCR and CIMD is stated in the report or the vendor doc. Order here reflects the doc's own listing sequence and must NOT be read as a verified preference ranking.",
      dcrIdentityGaps:
        "clientName unverifiable — the doc does not state the literal, and the concrete CIMD document URL is REDACTED in the doc (\"such as https://chatgpt.com/oauth/.../client.json\"), so it could not be fetched the way Claude Code's and Slack's were. userAgent unverifiable — not documented. Both require HP-44.",
      serverObligationNoted:
        "\"Once a request reaches your MCP server you must assume the token is untrusted and perform the full set of resource-server checks yourself—signature validation, issuer and audience matching, expiry, replay considerations, and scope enforcement.\"",
    },
  },

  // ── mistral (Le Chat) ──────────────────────────────────────────────────────
  // E1 docs are thin (one sentence); E2 probe for the initialize version only.
  // Four of five fields unverifiable — this is the honest outcome, not a gap in effort.
  mistral: {
    profileVersion: 1,
    sendsResourceIndicator: {
      status: "unverifiable",
      reason:
        "Le Chat is closed-source and https://docs.mistral.ai/le-chat/knowledge-integrations/connectors/mcp-connectors states only \"OAuth 2.1 (with dynamic client registration)\" — it contains no mention of the resource parameter, RFC 8707, or resource indicators. Requires HP-44.",
      capturedAt: CAPTURED,
    },
    oauthSpecVersion: {
      status: "unverifiable",
      reason:
        "SCHEMA MISMATCH plus missing evidence. The only first-party statement is \"OAuth 2.1\", which is an OAuth framework version, not one of the four MCP authorization-spec revision dates the enum accepts. The doc also never mentions /.well-known/oauth-protected-resource, so no revision can be inferred behaviorally either.",
      capturedAt: CAPTURED,
    },
    protocolVersionPinning: {
      status: "unverifiable",
      reason:
        "The report verifies only the version observed in the `initialize` body via an E2 probe (2025-11-25); it does not establish the pinned-vs-negotiated discriminant the schema requires. The report proves for cline and n8n that a single captured version is often the bundled SDK's negotiated outcome rather than a client pin, so it cannot be assumed here. Observed value preserved in extensions.protocolVersionPinningNotes.",
      capturedAt: CAPTURED,
    },
    dcrIdentity: {
      status: "unverifiable",
      reason:
        "Closed-source. The official MCP-connectors page gives no redirect URI, no client_name, and no User-Agent — it states only that DCR is supported. Requires HP-44.",
      capturedAt: CAPTURED,
    },
    authModel: {
      status: "verified",
      value: ["oauth2-dcr"],
      source:
        "E1 — https://docs.mistral.ai/le-chat/knowledge-integrations/connectors/mcp-connectors: \"OAuth 2.1 (with dynamic client registration): for servers using standard OAuth 2.1 delegated access.\"",
      capturedAt: CAPTURED,
    },
    extensions: {
      evidenceClass: "E1 (thin docs), E2 (in-repo probe)",
      protocolVersionPinningNotes:
        "E2 capture: seed-host-template.ts:985-990 records supportedProtocolVersions:[\"2025-11-25\"] with clientInfo {name:\"mcp\", version:\"0.1.0\"}, annotated at :948-954 as a capture of Le Chat's real base MCP initialize. Initialize-body only; discriminant unresolved.",
      leadsNotEvidence:
        "E3 ONLY, deliberately not promoted: third-party write-ups describe Le Chat's flow as \"resource and authorization server discovery, DCR, and a PKCE-based authorization code flow\". Do not promote without a capture.",
    },
  },

  // ── goose ──────────────────────────────────────────────────────────────────
  // E1 local clone of block/goose @ ca6ba6c4488aebd87cb6588da176d7ee073283bb, with
  // rmcp 2.2.0 read as a dependency. CIMD-first. NOTE: split-revision client — its
  // OAuth layer and MCP layer are on DIFFERENT spec revisions.
  goose: {
    profileVersion: 1,
    sendsResourceIndicator: {
      status: "verified",
      value: true,
      source:
        "E1 — 100% inherited from rmcp 2.2.0 (Cargo.toml:23, resolved in Cargo.lock); a grep for \"resource\" across crates/goose/src/oauth/ returns NO hits, so Goose contributes none of it. rmcp-2.2.0 src/transport/auth.rs ~L1356, ~L1604, ~L1738 — including the refresh leg comment: \"// RFC 8707: the resource indicator is required on token requests, including refreshes\" followed by .add_extra_param(\"resource\", self.base_url.to_string()). Value sent is the MCP SERVER URL, not the PRM resource field.",
      capturedAt: CAPTURED,
    },
    oauthSpecVersion: {
      status: "unverifiable",
      reason:
        "SCHEMA MISMATCH on two counts, not a research gap. (a) The report grades the OAuth layer \"RFC 9728 PRM (2025-06-18+)\" — a shape, not one of the four enum literals; no revision constant exists in Goose or rmcp 2.2.0 to pin it. (b) Goose is a SPLIT-REVISION client: its OAuth layer is PRM-era while its MCP layer hard-pins 2025-03-26, so a single value would misrepresent it either way. Both halves preserved in extensions.oauthSpecVersionNotes.",
      capturedAt: CAPTURED,
    },
    protocolVersionPinning: {
      status: "verified",
      value: { mode: "pinned", version: "2025-03-26" },
      source:
        "E1 — crates/goose/src/agents/mcp_client.rs L539-553, the client's get_info(): `.with_protocol_version(ProtocolVersion::V_2025_03_26)` with NO supported-versions list. The `#[expect(deprecated)]` attribute shows rmcp itself has deprecated this override, and rmcp's own ProtocolVersion::LATEST is V_2025_11_25 — so Goose deliberately pins two full revisions behind its SDK default. Cross-confirmed by E2: seed-host-template.ts:1095-1099 records supportedProtocolVersions:[\"2025-03-26\"] with clientInfo {name:\"goose-desktop\", version:\"1.38.0\"}.",
      capturedAt: CAPTURED,
    },
    dcrIdentity: {
      status: "verified",
      value: {
        clientName: "goose",
        redirectUris: [
          "http://127.0.0.1/oauth_callback",
          "http://[::1]/oauth_callback",
          "http://127.0.0.1:{port}/oauth_callback",
        ],
      },
      source:
        "E1 — Goose's vendor-published CIMD, fetched live 2026-07-29 from https://goose-docs.ai/oauth/client-metadata.json (HTTP 200): {\"client_id\":\"https://goose-docs.ai/oauth/client-metadata.json\",\"client_name\":\"goose\",\"redirect_uris\":[\"http://127.0.0.1/oauth_callback\",\"http://[::1]/oauth_callback\"],\"grant_types\":[\"authorization_code\",\"refresh_token\"],\"response_types\":[\"code\"],\"token_endpoint_auth_method\":\"none\",\"code_challenge_methods_supported\":[\"S256\"]}. Runtime redirect form from crates/goose/src/oauth/mod.rs L145-155 and L131-135. DCR-fallback client_name \"goose\" passed at mod.rs:145. userAgent deliberately omitted — see extensions.dcrIdentityGaps.",
      capturedAt: CAPTURED,
    },
    authModel: {
      status: "verified",
      value: ["api-key", "oauth2-cimd", "oauth2-dcr"],
      source:
        "E1 — ORDER IS SEMANTIC AND SOURCE-BACKED. crates/goose/src/agents/extension_manager.rs:697 inserts the UA plus user-supplied headers and connects UNAUTHENTICATED; only then (:781) does `if should_attempt_oauth_fallback(&client_res)` trigger oauth_flow. Stored credentials short-circuit at :728. CIMD-before-DCR from rmcp-2.2.0 auth.rs L2745-2782: if AS metadata advertises client_id_metadata_document_supported:true the CIMD URL IS the client_id (SEP-991) and no DCR happens; otherwise it falls through to .register_client(\"goose\", ...).",
      capturedAt: CAPTURED,
    },
    extensions: {
      evidenceClass: "E1 (local clone + dependency source + live CIMD fetch), E2 (probe)",
      oauthSpecVersionNotes:
        "OAuth layer: RFC 9728 PRM discovery (rmcp-2.2.0 auth.rs ~L1096, \"per SEP-985: Protected Resource Metadata first, then direct OAuth\") with a path-aware AS ladder — 2025-06-18-or-later shape. MCP layer: hard-pinned 2025-03-26. rmcp 2.2.0 additionally has a POST-probe fallback (RESOURCE_METADATA_POST_PROBE_BODY, auth.rs:33) that rmcp 3.0 REMOVED, so Goose discovers OAuth on some servers Codex will not.",
      protocolVersionPinningNotes:
        "SPLIT: the typed value covers the MCP initialize leg (2025-03-26, hard-pinned). Separately, rmcp hardcodes `.header(HEADER_MCP_PROTOCOL_VERSION, \"2024-11-05\")` on OAuth DISCOVERY requests (rmcp auth.rs ~L2623). 2024-11-05 is NOT a member of the McpProtocolVersion enum and so cannot be represented in the typed field at all. This affects Codex identically — routed to the conformance suite as S16.",
      dcrIdentityGaps:
        "userAgent DELIBERATELY OMITTED rather than recorded. `goose/{CARGO_PKG_VERSION}` is verified on the MCP transport (extension_manager.rs L608-609), but whether it reaches the AUTHORIZATION SERVER is unverifiable: oauth/mod.rs:145 calls OAuthState::new(mcp_server_url, None), passing None so rmcp builds its own HTTP client. Recording it as the DCR UA would be an upgrade the report does not support. (Contrast Codex, which demonstrably reuses its UA-bearing client.)",
      inferenceNotFinding:
        "The CIMD registers http://127.0.0.1/oauth_callback with NO port while Goose sends an ephemeral one. Both halves verified; NO test covering the interaction was found, so interop depends on the AS implementing RFC 8252 §7.3 port-agnostic loopback matching. Labelled an inference, not a finding.",
      clientQuirks: [
        "OAuth entry is a 401 sniff and one arm is a STRING-PREFIX match: extension_manager.rs L467-482 `StreamableHttpError::UnexpectedServerResponse(body) => body.starts_with(\"HTTP 401\")`. A server signalling auth any other way gets NO OAuth attempt at all.",
        "First request to a protected server is ALWAYS unauthenticated — HP-44 trace fixtures must expect this or it will look like a bug.",
      ],
    },
  },

  // ── slack (Slackbot MCP Client) ────────────────────────────────────────────
  // E1 official docs + vendor-published CIMD. SCOPE: this is Slack-as-CLIENT, NOT
  // Slack's MCP server at mcp.slack.com. The widely-quoted "Slack does not support
  // DCR" line is about the SERVER and is irrelevant here — conflating the two would
  // have reproduced the exact HP-17 failure mode.
  slack: {
    profileVersion: 1,
    sendsResourceIndicator: {
      status: "unverifiable",
      reason:
        "Slackbot is closed-source and https://docs.slack.dev/ai/slackbot-mcp-client/ explicitly does not cover the resource parameter, RFC 8707, or /.well-known/oauth-protected-resource. Requires HP-44.",
      capturedAt: CAPTURED,
    },
    oauthSpecVersion: {
      status: "unverifiable",
      reason:
        "Closed-source, and the Slackbot MCP Client docs state no spec revision and never mention PRM discovery, so no revision can be established either literally or behaviorally. Requires HP-44.",
      capturedAt: CAPTURED,
    },
    protocolVersionPinning: {
      status: "unverifiable",
      reason:
        "The report verifies only the version observed in the `initialize` body via an E2 probe (2025-06-18); it does not establish the pinned-vs-negotiated discriminant the schema requires. The MCP-Protocol-Version header is separately undocumented. Observed value preserved in extensions.protocolVersionPinningNotes.",
      capturedAt: CAPTURED,
    },
    dcrIdentity: {
      status: "verified",
      value: {
        clientName: "Slack",
        redirectUris: ["https://oauth2.slack.com/external/auth/callback"],
      },
      source:
        "E1 — Slack's vendor-published CIMD, fetched live 2026-07-29 from https://slack.com/.well-known/oauth-client-metadata: {\"client_id\":\"https://slack.com/.well-known/oauth-client-metadata\",\"client_name\":\"Slack\",\"client_uri\":\"https://slack.com\",\"logo_uri\":\"https://a.slack-edge.com/80588/marketing/img/icons/icon_slack_hash_colored.png\",\"redirect_uris\":[\"https://oauth2.slack.com/external/auth/callback\"],\"grant_types\":[\"authorization_code\",\"refresh_token\"],\"response_types\":[\"code\"],\"token_endpoint_auth_method\":\"none\"}. Pointer to the document and the redirect URI corroborated in prose at https://docs.slack.dev/ai/slackbot-mcp-client/. NOTE the literal client_name is \"Slack\", NOT \"Slackbot\".",
      capturedAt: CAPTURED,
    },
    authModel: {
      status: "verified",
      value: ["none", "oauth2-dcr", "oauth2-preregistered"],
      source:
        "E1 — https://docs.slack.dev/ai/slackbot-mcp-client/ and https://docs.slack.dev/changelog/2026/06/18/slackbot-mcp-client/ list four methods: (1) \"Slack identity auth\", (2) \"No auth: for MCP servers that serve standard responses regardless of requestor.\", (3) \"Dynamic Client Registration: for MCP servers that support standard OAuth discovery. Slack handles client registration automatically.\", (4) \"Manual OAuth: for MCP servers where you manually register OAuth credentials with the provider.\" Order follows the vendor doc's own numbering; see extensions.authModelOrderCaveat.",
      capturedAt: CAPTURED,
    },
    extensions: {
      evidenceClass: "E1 (official docs + live CIMD fetch), E2 (probe)",
      scopeCorrection:
        "This profile is the Slackbot MCP CLIENT (Slack as host, connecting out). It is NOT Slack's MCP server at https://mcp.slack.com/mcp. The line \"We do not support ... Dynamic Client Registration at this time\" is about Slack-as-a-SERVER and must not be applied here.",
      protocolVersionPinningNotes:
        "E2 capture: seed-host-template.ts:1199-1204 records supportedProtocolVersions:[\"2025-06-18\"] with clientInfo {name:\"Slackbot MCP Client\", version:\"1.0.0\"}, annotated at :1162 as \"Captured from Slackbot on 2026-06-24\". Initialize-body only; discriminant unresolved.",
      authModelOrderCaveat:
        "The vendor doc says \"Choose the one that fits your use case\" — the numbering is a catalogue, NOT a stated preference ranking. Order here preserves the doc's sequence and must not be read as runtime precedence.",
      unmappedAuthModels:
        "\"Slack identity auth\" (Slack maps user and team IDs to server features, with no separate OAuth flow for end users) has no member in the OAuthAuthModel enum and is absent from authModel.",
      dcrIdentityGaps:
        "userAgent unverifiable — the Slackbot MCP Client docs explicitly do not state it, and Slackbot is closed-source.",
      clientQuirks: [
        "Slack \"still signs every request so your server can verify it originated from Slack\" — request signing is an extra per-host behavior a golden trace should capture.",
      ],
    },
  },

  // ── cursor ─────────────────────────────────────────────────────────────────
  // E1 official docs only (closed-source). NOTE: the report deliberately refused to
  // promote "docs mention only AS metadata, never PRM" into a pre-2025-06-18
  // finding — absence from a docs page is not evidence of absence in code.
  cursor: {
    profileVersion: 1,
    sendsResourceIndicator: {
      status: "unverifiable",
      reason:
        "Closed-source, and https://cursor.com/docs/context/mcp does not mention the resource parameter or RFC 8707. Requires HP-44.",
      capturedAt: CAPTURED,
    },
    oauthSpecVersion: {
      status: "unverifiable",
      reason:
        "The docs document scope discovery via /.well-known/oauth-authorization-server and make NO mention of /.well-known/oauth-protected-resource (RFC 9728). That is suggestive of a pre-2025-06-18 discovery model, but the report explicitly declines to promote it: absence from a docs page is not evidence of absence in the implementation. Flagged as a top-priority HP-44 target precisely because the uncertainty is high and consequential.",
      capturedAt: CAPTURED,
    },
    protocolVersionPinning: {
      status: "unverifiable",
      reason:
        "Not mentioned in the docs; closed-source. No E2 capture either — the cursor template records respectToolVisibility:false from a 3.4.20 probe but sets no supportedProtocolVersions. Requires HP-44.",
      capturedAt: CAPTURED,
    },
    dcrIdentity: {
      status: "verified",
      value: {
        redirectUris: [
          "https://www.cursor.com/agents/mcp/oauth/callback",
          "http://localhost:8787/callback",
        ],
      },
      source:
        "E1 — https://cursor.com/docs/context/mcp gives two fixed redirect URIs applying across web, Cursor Agents, and the desktop app: \"https://www.cursor.com/agents/mcp/oauth/callback\" and \"http://localhost:8787/callback\". clientName and userAgent are NOT covered — see extensions.dcrIdentityGaps.",
      capturedAt: CAPTURED,
    },
    authModel: {
      status: "verified",
      value: ["oauth2-dcr", "oauth2-preregistered"],
      source:
        "E1 — https://cursor.com/docs/context/mcp. DCR is the default; static credentials are documented as the escape hatch for when \"The provider does not support OAuth 2.0 Dynamic Client Registration\", via an `auth` object taking CLIENT_ID (required), CLIENT_SECRET (optional) and scopes (optional). DCR-first ordering IS report-backed (\"by default\").",
      capturedAt: CAPTURED,
    },
    extensions: {
      evidenceClass: "E1",
      dcrIdentityGaps:
        "clientName unverifiable — the docs do not state it and Cursor is closed-source. userAgent unverifiable — same reason. Both require HP-44.",
      leadsNotEvidence:
        "E3 ONLY, deliberately excluded from the typed value and CONFLICTING with the current official docs: Cursor community-forum threads report the redirect URI changing from cursor://anysphere.cursor-mcp/oauth/callback to an http://localhost form around 3.10.17, and report http://127.0.0.1:54321/callback being registered at DCR. Treat the version-to-URI mapping as OPEN until captured.",
    },
  },

  // ── codex (OpenAI Codex CLI) ───────────────────────────────────────────────
  // E1 local clone of openai/codex @ 1ae2b9880e8af5d465161a58f24a127aaa4b0040, with
  // rmcp pulled from crates.io at the EXACT pinned version (=3.0.0-beta.3).
  // Real DCR, no CIMD. Carries the fourth refutation (User-Agent).
  codex: {
    profileVersion: 1,
    sendsResourceIndicator: {
      status: "verified",
      value: true,
      source:
        "E1 — TWO independent mechanisms. (a) rmcp-3.0.0-beta.3 src/transport/auth.rs ~L1727, ~L2006, ~L2151 send it unconditionally with value = the MCP server URL: `.add_extra_param(\"resource\", self.base_url.to_string());` including on refresh. (b) Codex SEPARATELY appends a second, user-configured resource to the authorize URL only — codex-rs/rmcp-client/src/perform_oauth_login.rs L531-535, driven by codex-rs/config/src/mcp_types.rs L216-218 which names RFC 8707 in its own doc comment.",
      capturedAt: CAPTURED,
    },
    oauthSpecVersion: {
      status: "unverifiable",
      reason:
        "SCHEMA MISMATCH, not a research gap. The report verifies the DISCOVERY SHAPE (RFC 9728 PRM + path-aware ladder, all inherited from rmcp) but does not pin one of the four enum literals: the literal string 'oauth-protected-resource' appears NOWHERE in the Codex repo, and rmcp's ladder doc comment names 'spec-2025-11-25 4.3' while Codex negotiates 2025-06-18 on the MCP leg — two different revisions in one client. Both observations preserved in extensions.oauthSpecVersionNotes.",
      capturedAt: CAPTURED,
    },
    protocolVersionPinning: {
      status: "verified",
      value: { mode: "pinned", version: "2025-06-18" },
      source:
        "E1 — UPHOLDS the prior 'Codex pins 2025-06-18' claim in its practical form. codex-rs/rmcp-client/src/protocol_mode.rs L19-33: `Self::Legacy => ProtocolVersion::V_2025_06_18`, and Legacy's client_lifecycle is `ClientLifecycleMode::Initialize` with no version list. The 2026-07-28 alternative is gated OFF by default — codex-rs/features/src/lib.rs L1118-1123: `FeatureSpec { id: Feature::Mcp20260728, key: \"mcp_2026_07_28\", stage: Stage::UnderDevelopment, default_enabled: false }`, gated at codex-rs/core/src/config/mod.rs L1761-1767. Cross-confirmed by E2: seed-host-template.ts:1393-1405 records supportedProtocolVersions:[\"2025-06-18\"] with clientInfo {name:\"codex-mcp-client\", title:\"Codex\", version:\"0.131.0-alpha.9\"}.",
      capturedAt: CAPTURED,
    },
    dcrIdentity: {
      status: "verified",
      value: {
        clientName: "Codex",
        redirectUris: ["http://127.0.0.1:{ephemeral}/callback/{id}"],
        userAgent: "codex-mcp-client/{CARGO_PKG_VERSION}",
      },
      source:
        "E1 — client_name at codex-rs/rmcp-client/src/perform_oauth_login.rs:665 `.with_client_name(\"Codex\")`. Redirect at :404-419 and :508 (OS-ephemeral port via `format!(\"{bind_host}:0\")` at :498; callback path suffix is base64url(SHA-256(server_url)[..9]) per :438-439, so it differs per server). User-Agent at codex-rs/rmcp-client/src/utils.rs:12 `const MCP_USER_AGENT: &str = concat!(\"codex-mcp-client/\", env!(\"CARGO_PKG_VERSION\"));` and :67, and it demonstrably reaches the AS via :520 passing the UA-bearing client into OAuthHttpClientAdapter::new.",
      capturedAt: CAPTURED,
    },
    authModel: {
      status: "verified",
      value: ["api-key", "oauth2-dcr", "none"],
      source:
        "E1 — ORDER IS SEMANTIC AND SOURCE-BACKED. codex-rs/config/src/mcp_types.rs L130-142: \"Authentication flow Codex attempts after resolving an HTTP MCP server's configured bearer token and authorization headers, which always take precedence. ... both modes ultimately fall back to an unauthenticated connection.\" OAuth is the #[default]. Codex passes NO client_metadata_url to rmcp, so it never takes the CIMD branch — it does real DCR, registering a public client (token_endpoint_auth_method:\"none\", application_type:\"native\").",
      capturedAt: CAPTURED,
    },
    extensions: {
      evidenceClass: "E1 (local clone + exact-version dependency source), E2 (probe)",
      oauthSpecVersionNotes:
        "Discovery is 100% rmcp's: RFC 9728 PRM + path-aware AS ladder (rmcp auth.rs ~L2238, whose comment reads 'following the priority order in spec-2025-11-25 4.3'). Codex has an integration test proving the full 401 → WWW-Authenticate resource_metadata → PRM → authorization_servers → AS metadata chain: codex-rs/rmcp-client/tests/mcp_2026_oauth_discovery.rs L54-56, L73-76.",
      protocolVersionPinningNotes:
        "SPLIT. The typed value covers the MCP initialize leg in DEFAULT configuration. Two caveats: (a) enabling the off-by-default mcp_2026_07_28 feature switches to Auto { preferred_versions: [V_2026_07_28], legacy_version: Some(V_2025_06_18) } — i.e. genuinely negotiated; (b) rmcp hardcodes `.header(HEADER_MCP_PROTOCOL_VERSION, \"2024-11-05\")` on OAuth DISCOVERY requests (auth.rs ~L2623) — 2024-11-05 is NOT a member of the McpProtocolVersion enum and cannot be represented in the typed field. Affects Goose identically; routed to the conformance suite as S16.",
      priorClaimRefuted:
        "\"Codex sends no User-Agent\" is REFUTED. It sends codex-mcp-client/{version} and reuses that client on the OAuth leg. The prior claim traced to https://github.com/openai/codex/issues/16485 (E3), which has no maintainer confirmation and is CLOSED — most likely fixed after filing. An earlier pass of this very investigation repeated the error by leaning on that issue; recorded here as the correction.",
      stillUnverifiable:
        "Whether 2024-11-05 would be ACCEPTED if a server negotiated down: rmcp defines V_2024_11_05 so the capability exists, and protocol_mode.rs offers only 2025-06-18 / 2026-07-28 so Codex does not prefer it, but acceptance-on-downgrade is not settled by those files.",
      inferenceNotFinding:
        "Configuring oauth_resource should yield TWO `resource` query params on /authorize, since rmcp already appends one and append_query_param uses append_pair (appends, not replaces, ~L693). No test asserts either way. A genuine interop hazard worth one HP-44 capture.",
      clientQuirks: [
        "Codex DELIBERATELY relaxes the RFC 8414 requirement that AS metadata include `issuer` — perform_oauth_login.rs:656 and auth_status.rs:221 both call auth_manager.set_allow_missing_issuer(true). A server omitting issuer is out of spec but works with Codex. Routed to the conformance suite as S17 at error level; this leniency is a client courtesy, not a licence.",
      ],
    },
  },

  // ── copilot (Microsoft 365 Copilot) ────────────────────────────────────────
  // E1 official Microsoft Learn docs. SCOPE: this is M365 Copilot, per the template
  // label "Copilot 1.0.1" / "Microsoft 365 Copilot 1.0.1 compatibility profile".
  // GitHub Copilot Chat in VS Code is a DIFFERENT client (no MCP OAuth at all) and
  // the github.com / JetBrains / Xcode / CLI surfaces are closed-source.
  copilot: {
    profileVersion: 1,
    sendsResourceIndicator: {
      status: "unverifiable",
      reason:
        "Neither the plugin-authentication nor the plugin-authentication-dynamic-client-registration Learn page mentions the resource parameter or RFC 8707, and M365 Copilot's MCP client is closed-source. The repo template is itself explicit that \"Copilot's MCP client identity is not publicly documented\". Requires HP-44.",
      capturedAt: CAPTURED,
    },
    oauthSpecVersion: {
      status: "unverifiable",
      reason:
        "SCHEMA MISMATCH. Microsoft documents RFC 9728 PRM and RFC 8414 AS metadata as hard PREREQUISITES — which places Copilot at the 2025-06-18-or-later discovery model — but never states an MCP authorization spec REVISION, so no enum literal can be selected. The behavioral finding is preserved in extensions.oauthSpecVersionNotes.",
      capturedAt: CAPTURED,
    },
    protocolVersionPinning: {
      status: "unverifiable",
      reason:
        "Neither Learn page mentions MCP-Protocol-Version; closed-source. No E2 capture either — seed-host-template.ts sets no supportedProtocolVersions for the copilot template. Requires HP-44.",
      capturedAt: CAPTURED,
    },
    dcrIdentity: {
      status: "unverifiable",
      reason:
        "Opaque BY DESIGN, per https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-authentication-dynamic-client-registration: \"Unlike static OAuth, you don't configure a redirect URI or client credentials yourself - the Enterprise token store registers the client and handles those details behind the scenes.\" client_name, the DCR-path redirect URI, and the User-Agent are therefore all undocumented. See extensions.dcrIdentityGaps for the static-path URI that must NOT be carried over.",
      capturedAt: CAPTURED,
    },
    authModel: {
      status: "verified",
      value: ["oauth2-dcr", "oauth2-preregistered", "none"],
      source:
        "E1 — https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-authentication publishes a per-scheme support matrix. For MCP plugins: Microsoft Entra SSO = Supported, Dynamic client registration (DCR) = Supported, OAuth 2.0 authorization code flow = Supported, API key = NOT SUPPORTED, No authentication (anonymous) = Supported. Order follows the doc's table; api-key is DELIBERATELY ABSENT because the vendor explicitly marks it unsupported for MCP plugins.",
      capturedAt: CAPTURED,
    },
    extensions: {
      evidenceClass: "E1",
      scopeCorrection:
        "Three unrelated 'Copilot' MCP clients exist. This profile is Microsoft 365 Copilot. (a) GitHub Copilot Chat in VS Code implements NO MCP OAuth of its own — verified by exhaustive negative search across 5,267 files of extensions/copilot/ (code_challenge → 0, registration_endpoint → 0, oauth-protected-resource → 0 hits under that path); it delegates wholly to VS Code (see the `vscode` profile) and uses static bearer injection for its own server. (b) Copilot on github.com, JetBrains, Xcode and the CLI are closed-source — unverifiable, and nothing here may be extrapolated to them.",
      oauthSpecVersionNotes:
        "Hard prerequisites, quoted: \"Your MCP server exposes OAuth 2.0 protected resource metadata at its .well-known/oauth-protected-resource endpoint (RFC 9728)\" and \"The authorization server publishes its metadata at the .well-known/oauth-authorization-server endpoint (RFC 8414), including a registration_endpoint, and supports dynamic client registration (RFC 7591) that issues a client secret.\"",
      dcrIdentityGaps:
        "For the STATIC OAuth path — a different scheme — the docs give https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect. The report explicitly warns NOT to carry that over to the DCR path without a capture, so it is recorded here rather than in the typed value.",
      unmappedAuthModels:
        "\"Microsoft Entra single sign-on (SSO)\" is documented as Supported for MCP plugins but has no member in the OAuthAuthModel enum and is absent from authModel.",
      apiKeyExclusionIsDeliberate:
        "api-key is omitted from authModel on positive vendor evidence, not for lack of evidence: the Learn matrix marks API key 'Not supported' for MCP plugins (it is an API-plugin-only feature).",
      clientQuirks: [
        "UNIQUE IN THE CATALOG: \"DCR without a client secret isn't supported yet. The authorization server must issue a client secret during registration.\" Every other DCR client here registers as a PUBLIC client (token_endpoint_auth_method:\"none\"). A server returning a public-client registration works with Claude, Slack, Goose and Claude Code but FAILS with M365 Copilot. This is a per-host field, NOT a server obligation — do not route it to the conformance suite.",
        "\"PKCE is enabled by default for DCR.\"",
      ],
    },
  },

  // ── vscode ─────────────────────────────────────────────────────────────────
  // E1 microsoft/vscode @ main. The best-verified third-party client in the
  // catalog, and the only one where the User-Agent was readable from source.
  // NOTE: userAgent is deliberately NOT in dcrIdentity — see extensions.
  vscode: {
    profileVersion: 1,
    sendsResourceIndicator: {
      status: "verified",
      value: true,
      source:
        "E1 — hand-written first-party implementation (VS Code does NOT delegate to the TS SDK's auth()). src/vs/workbench/api/common/extHostAuthentication.ts ~L675 (authorize: `authorizationUrl.searchParams.append('resource', this._resourceMetadata.resource);`), ~L762 (authorization_code token request) and ~L817 (refresh), the latter two commented \"// Add resource indicator if available (RFC 8707)\". Loopback and device-code flows repeat it at src/vs/workbench/api/node/extHostAuthentication.ts ~L109, ~L190, ~L258. TWO QUALIFICATIONS: the value sent is the PRM document's `resource`, NOT the MCP server URL (contrast Claude/ChatGPT/Goose/Codex); and it is guarded — if PRM discovery fails, _resourceMetadata is undefined and NO resource param is sent. The DCR request itself carries no resource.",
      capturedAt: CAPTURED,
    },
    oauthSpecVersion: {
      status: "unverifiable",
      reason:
        "SCHEMA MISMATCH, and a real property of VS Code rather than a research failure. The report grades this \"verified behaviorally (2025-06-18-or-later shape); unverifiable as a literal\" — NO MCP_AUTH_SPEC_VERSION constant or equivalent exists anywhere in microsoft/vscode, so there is nothing to pin to one of the four enum members. The verified behavior is preserved in extensions.oauthSpecVersionNotes.",
      capturedAt: CAPTURED,
    },
    protocolVersionPinning: {
      status: "verified",
      value: { mode: "pinned", version: "2025-11-25" },
      source:
        "E1 — src/vs/platform/mcp/common/modelContextProtocol.ts:43 `export const LATEST_PROTOCOL_VERSION = \"2025-11-25\";`, sent pinned at src/vs/workbench/contrib/mcp/common/mcpServerRequestHandler.ts ~L113 (`protocolVersion: MCP.LATEST_PROTOCOL_VERSION`). That is the ONLY protocolVersion occurrence across mcpServerRequestHandler.ts, mcpRegistry.ts and extHostMcp.ts — the server's returned version is never inspected or negotiated. Cross-confirmed by E2: seed-host-template.ts:1645-1651 records the same value from a 1.130.0 probe.",
      capturedAt: CAPTURED,
    },
    dcrIdentity: {
      status: "verified",
      value: {
        clientName: "Visual Studio Code",
        redirectUris: [
          "https://insiders.vscode.dev/redirect",
          "https://vscode.dev/redirect",
          "http://127.0.0.1/",
          "http://127.0.0.1:33418/",
        ],
      },
      source:
        "E1 — the complete DCR request body at src/vs/base/common/oauth.ts L944-969 (client_uri 'https://code.visualstudio.com', response_types ['code'], token_endpoint_auth_method 'none', application_type 'native'), with DEFAULT_AUTH_FLOW_PORT = 33418 at oauth.ts L943 and corroborated by the unit test at src/vs/base/test/common/oauth.test.ts L485-494. clientName resolves through appName ← productService.nameLong (localProcessExtensionHost.ts L536), with the runtime literals proven in-repo by api/node/loopbackServer.ts L191/L193 comparing against 'Visual Studio Code' and 'Visual Studio Code - Insiders'. userAgent DELIBERATELY OMITTED — see extensions.dcrIdentityGaps.",
      capturedAt: CAPTURED,
    },
    authModel: {
      status: "verified",
      value: ["oauth2-dcr", "api-key"],
      source:
        "E1 — OAuth 2.1 + mandatory PKCE S256 (extHostAuthentication.ts L668-669, L726-736), public client (token_endpoint_auth_method 'none', application_type 'native'), three grant types at oauth.ts L934: ['authorization_code','refresh_token','urn:ietf:params:oauth:grant-type:device_code']. A static-header path coexists (user mcp.json headers spread into every request, extHostMcp.ts L452/L576/L413). See extensions.authModelOrderCaveat.",
      capturedAt: CAPTURED,
    },
    extensions: {
      evidenceClass: "E1 (upstream source), E2 (probe, agrees)",
      oauthSpecVersionNotes:
        "RFC 9728 PRM discovery, path-aware (oauth.ts ~L1260), plus a documented three-rung AS ladder (oauth.ts L1326-1339, implemented L1388/L1397/L1406) distinguishing RFC 8414 path INSERTION from OIDC path ADDITION. Constants at oauth.ts L8-11. VS Code ENFORCES RFC 9728 client-side and hard-fails on mismatch (~L1241). NON-SPEC FOURTH RUNG: if the whole ladder fails it INVENTS metadata from the origin (oauth.ts L919-924, getDefaultMetadataForUrl → /authorize, /token, /register) — no other catalog client is known to do this.",
      protocolVersionPinningNotes:
        "SPLIT, and the most conformance-relevant finding in the report. The MCP-Protocol-Version HEADER appears exactly ONCE in the whole repo and only for OAuth DISCOVERY same-origin requests (extHostMcp.ts ~L811); it is ABSENT from all three actual MCP request header builders — _sendStreamableHttp (~L451), the SSE GET (~L575), and _closeSession (~L412). TRAP: a SUPPORTED_PROTOCOL_VERSIONS list DOES exist at src/vs/platform/mcp/node/mcpGatewaySession.ts L17-24 with real negotiation at ~L192, but that is VS Code acting as an MCP GATEWAY SERVER, not as a client. Server negotiates, client pins. Attributing that list to VS Code-as-client would be a textbook HP-17 error.",
      dcrIdentityGaps:
        "userAgent DELIBERATELY OMITTED from the typed value. `Visual Studio Code/<version>` is verified at extHostMcp.ts L849 (`setHostHeader(init.headers, 'user-agent', `${product.nameLong}/${product.version}`)`) and reaches OAuth DISCOVERY requests, but the report is explicit that it is NOT applied to the DCR POST, which uses bare global fetch (oauth.ts L971). Since this schema field means 'user-agent used at Dynamic Client Registration', recording it would misrepresent the finding.",
      clientNameVariants:
        "'Visual Studio Code' (official stable), 'Visual Studio Code - Insiders' (official insiders), 'Code - OSS' (OSS build). HONEST GAP: the shipped Microsoft product.json is NOT in the OSS repo — the in-repo product.json says nameLong 'Code - OSS'. The official literals are verified via in-repo string comparison, which is strong but is an inference about a build-time file rather than a direct read of it.",
      runtimeRedirectDiffersFromRegistered:
        "The redirect URI actually sent at /authorize differs from the registered set: extHostAuthentication.ts L680-682 hardcodes 'https://vscode.dev/redirect'; the node loopback flow overrides with http://127.0.0.1:${port}/ (loopbackServer.ts L109), binding 33418 first then falling back to an ephemeral port (server.listen(0,'127.0.0.1'), L147). Flow priority: loopback unshifted ahead of URL-handler when not remote (api/node/extHostAuthentication.ts L60-65); device code appended last (L69-73).",
      authModelOrderCaveat:
        "Unlike Goose and Codex, the report states NO runtime precedence between OAuth and static headers for VS Code. The order here is not a verified preference ranking.",
      unmappedAuthModels:
        "Device-code grant (urn:ietf:params:oauth:grant-type:device_code) and Enterprise XAA / ID-JAG (oauth.ts L60 buildIdJagExchangeBody, L84 buildResourceRedemptionBody, driven from mainThreadMcp.ts ~L245-285 gated on oauth.enterpriseManaged) have no members in the OAuthAuthModel enum. VS Code and MCPJam are the only two catalog clients with Cross-App Access support.",
      clientQuirks: [
        "VS Code accepts 403 AS AN AUTH CHALLENGE, not just 401 — extHostMcp.ts L959-961 `return status === 401 || status === 403;`. This DIRECTLY CONTRADICTS Claude, which honors only 401. There is no single correct server behavior to test; per-host field, not a server rule.",
        "Only the first authorization_servers entry is used — extHostMcp.ts L1099-1101, with an in-source `TODO:@TylerLeonhardt support multiple authorization servers`. Same limitation as Claude, independently sourced.",
        "WWW-Authenticate with resource_metadata is treated as OPTIONAL, not required (extHostMcp.ts ~L1183 parses it; oauth.ts L1251-1272 falls back to well-known probing).",
        "Cross-origin redirect hardening — extHostMcp.ts L342 CROSS_ORIGIN_STRIPPED_HEADERS = ['authorization','cookie','proxy-authorization','mcp-session-id']; L339 ALLOWED_REDIRECT_PROTOCOLS = ['http:','https:'].",
        "Deliberate documented spec deviation (extHostMcp.ts L491-494): spec says only 404 triggers re-init, but VS Code also accepts 400 because 'some servers send 400s as well, including their example'.",
        "_generateNewClientId() re-runs DCR on invalid_client (extHostAuthentication.ts L799-802).",
      ],
    },
  },

  // ── agentcore (AWS Bedrock AgentCore Gateway) ──────────────────────────────
  // E1 official AWS docs. Carries a refutation of the PROTOCOL VERSION pin — which
  // also corrects a GUESS value in MCPJam's own seed template.
  agentcore: {
    profileVersion: 1,
    sendsResourceIndicator: {
      status: "unverifiable",
      reason:
        "Not mentioned in the AWS docs. AgentCore Gateway is a closed managed AWS service with no public source and — unlike the CLI clients — it CANNOT be probed locally; the repo template says as much at seed-host-template.ts:1740-1742. Closing this requires an AWS account with a Gateway and an MCP-server target provisioned. Budget it explicitly; it is the one catalog entry HP-44 cannot cover for free.",
      capturedAt: CAPTURED,
    },
    oauthSpecVersion: {
      status: "unverifiable",
      reason:
        "Not mentioned. AWS documents four supported MCP PROTOCOL versions, but that is a different axis from the OAuth authorization-spec revision, and no PRM/RFC 9728 discovery behavior is described for the outbound leg. Same server-side-only probing blocker as above.",
      capturedAt: CAPTURED,
    },
    protocolVersionPinning: {
      status: "refuted",
      value: { mode: "negotiated" },
      source:
        "E1 — REFUTES the single-version pin. https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-target-MCPservers.html §'Configuration considerations for MCP server targets': \"Supported MCP protocol versions are - 2026-07-28 , 2025-11-25 , 2025-06-18 , and 2025-03-26.\" and \"For accounts that are enabled for MCP version updates, you can modify the gateway's supported protocol versions with the UpdateGateway operation. Otherwise, the supported versions are fixed when you create the gateway.\" This also refutes MCPJam's own template value — seed-host-template.ts:1760 supportedProtocolVersions:[\"2025-06-18\"] — though that entry is already honestly labelled at :1749-1759 as \"GUESS (unprobed)\".",
      capturedAt: CAPTURED,
    },
    dcrIdentity: {
      status: "unverifiable",
      reason:
        "No DCR on the outbound leg. The outbound authorization provider is PRE-CONFIGURED in Amazon Bedrock AgentCore Identity, which structurally displaces DCR, and the page never mentions RFC 7591 for the outbound direction. Consequently client_name, redirect URI and User-Agent are all undocumented. Note: absence from the page is not proof, so this is unverifiable rather than refuted.",
      capturedAt: CAPTURED,
    },
    authModel: {
      status: "verified",
      value: ["oauth2-preregistered", "api-key", "none"],
      source:
        "E1 — https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-target-MCPservers.html §'Authorization strategy': \"No authorization – The gateway invokes the MCP server without preconfigured authorization. This approach is not recommended.\"; \"OAuth – The gateway supports both two-legged OAuth (Client Credentials grant type) and three-legged OAuth (Authorization Code grant type). You configure the authorization provider in Amazon Bedrock AgentCore Identity.\"; \"IAM (AWS Signature Version 4 (Sig V4)) – ...\"; \"API key – The gateway uses an API key credential provider...\". See extensions.authModelOrderCaveat.",
      capturedAt: CAPTURED,
    },
    extensions: {
      evidenceClass: "E1",
      supportedMcpProtocolVersions: [
        "2026-07-28",
        "2025-11-25",
        "2025-06-18",
        "2025-03-26",
      ],
      authModelOrderCaveat:
        "AWS lists four strategies WITHOUT a stated preference order. 'No authorization' is explicitly \"not recommended\" so it is placed last. This ordering is EDITORIAL, not report-backed — do not read it as runtime precedence.",
      unmappedAuthModels:
        "IAM / AWS Signature Version 4 (SigV4) outbound signing has no member in the OAuthAuthModel enum and is absent from authModel. It requires the MCP server to sit behind an AWS service that natively verifies SigV4.",
      templateCorrectionRequired:
        "ACTION: update the agentcore template to the documented four-version list, and drop or keep-labelled the 'bedrock-agentcore' clientInfo guess.",
      clientQuirks: [
        "\"Currently DYNAMIC mode is not interoperable with semantic search or outbound three-legged OAuth (3LO).\" — listing mode and OAuth mode interact, which no other catalog client does.",
        "OAuth authorization-URL SESSION BINDING: the authorization URL and session URI are valid for 10 minutes, and CompleteResourceTokenAuth validates that the user who started the flow is the one who completed it. An anti-consent-hijacking measure unique to AgentCore in this catalog.",
        "Version 2026-07-28 is stateless and does not use the Mcp-Session-Id header; 2025-11-25 and earlier do.",
      ],
    },
  },

  // ── n8n ────────────────────────────────────────────────────────────────────
  // E1 n8n-io/n8n @ master. Opposite architecture from cline: n8n HAND-ROLLS the
  // entire OAuth protocol and uses the MCP SDK only for the transport. Confirms the
  // prior OAuth2+DCR claim and re-confirms the x-consumer-api-key refutation.
  n8n: {
    profileVersion: 1,
    sendsResourceIndicator: {
      status: "verified",
      value: true,
      source:
        "E1 — CLIENT-AUTHORED, not SDK-inherited. packages/@n8n/client-oauth2/src/code-flow.ts L38-46 (authorize: `...(options.resource ? { resource: options.resource } : {})`) and L99-104 (token, same pattern); refresh at packages/@n8n/client-oauth2/src/client-oauth2-token.ts L86-90. Wired from the credential at packages/cli/src/oauth/oauth.service.ts L1306 (`resource: credential.resource,`). n8n cites RFC 8707 by name in its own comment at oauth.service.ts L170-186 and validates the supplied resource against the discovered PRM resource, throwing InvalidTargetError on mismatch (L211-247).",
      capturedAt: CAPTURED,
    },
    oauthSpecVersion: {
      status: "unverifiable",
      reason:
        "SCHEMA MISMATCH. The report grades this \"2025-06-18-era, hand-implemented\" — a hedged era, not one of the four enum literals, and n8n contains no MCP authorization-spec revision constant to pin. The RFCs it actually implements are preserved in extensions.oauthSpecVersionNotes.",
      capturedAt: CAPTURED,
    },
    protocolVersionPinning: {
      status: "verified",
      value: { mode: "negotiated" },
      source:
        "E1 — GitHub code search for \"MCP-Protocol-Version\" across n8n-io/n8n returns total_count: 1, and the single hit is a TEST FIXTURE mocking what the SDK produces (packages/@n8n/nodes-langchain/nodes/mcp/shared/__test__/utils.test.ts L657-660), not a client pin. n8n's fetch wrapper merges its auth headers on top of the SDK-supplied ones (shared/utils.ts L311). SDK pinned exactly at pnpm-workspace.yaml L57-58: '@modelcontextprotocol/sdk': 1.26.0 (no caret).",
      capturedAt: CAPTURED,
    },
    dcrIdentity: {
      status: "verified",
      value: {
        clientName: "n8n",
        redirectUris: ["<instance>/rest/oauth2-credential/callback"],
      },
      source:
        "E1 — packages/cli/src/oauth/oauth.service.ts L1100-1111, the DCR register payload: `client_name: 'n8n'`, `client_uri: 'https://n8n.io/'`, `redirect_uris: [`${this.getBaseUrl(OauthVersion.V2)}/callback`]`, `response_types: ['code']`. getBaseUrl at L250-253 resolves to <instance base URL>/<rest endpoint>/oauth2-credential — default rest endpoint 'rest'. token_endpoint_auth_method and grant_types are NEGOTIATED from the AS's advertised metadata (L1079-1098), so n8n can register as either a public OR confidential client — the only catalog client found to do this adaptively. userAgent unverifiable — see extensions.dcrIdentityGaps.",
      capturedAt: CAPTURED,
    },
    authModel: {
      status: "verified",
      value: ["api-key", "oauth2-dcr", "oauth2-preregistered", "none"],
      source:
        "E1 — CONFIRMS the prior 'n8n has full MCP OAuth2 + DCR' claim. Credential list at packages/@n8n/nodes-langchain/nodes/mcp/shared/descriptions.ts L28-65 (httpBearerAuth, httpHeaderAuth, mcpOAuth2Api, httpMultipleHeadersAuth) and user-facing selector at McpClientTool.node.ts L156-188: Bearer Auth, Header Auth, MCP OAuth2, Multiple Headers Auth, None. DCR is ON BY DEFAULT — McpOAuth2Api.credentials.ts declares `useDynamicClientRegistration` type boolean default true, gated at oauth.service.ts L939-947; toggling it off falls back to the static oAuth2Api client id/secret. Order follows the node's own selector sequence; see extensions.authModelOrderCaveat.",
      capturedAt: CAPTURED,
    },
    extensions: {
      evidenceClass: "E1 (upstream source + GitHub code search), E2 (probe)",
      oauthSpecVersionNotes:
        "Hand-rolls RFC 9728 (PRM) + RFC 8414 (AS metadata) + RFC 7591 (DCR) + RFC 8707 (resource). Explicit precedence comment at oauth.service.ts L1067-1073: \"Prefer the scopes advertised by the protected resource (RFC 9728) over the authorization server's scopes_supported (RFC 8414).\" The MCP SDK is used for the Client/transport ONLY.",
      protocolVersionPinningNotes:
        "CORRECTS how the E2 capture must be read: seed-host-template.ts:1795-1801 records supportedProtocolVersions:[\"2025-11-25\"], but that is the value the BUNDLED SDK negotiated at capture time, NOT a pin n8n owns. It will drift with the SDK dependency bump.",
      priorClaimRefutedReconfirmed:
        "`x-consumer-api-key` REFUTED, re-confirmed independently: GitHub code search over n8n-io/n8n for \"x-consumer-api-key\" returns total_count: 0, and \"consumer-api-key\" likewise 0 — the string does not exist anywhere in the repository. n8n's header auth is the GENERIC httpHeaderAuth credential (arbitrary user-supplied name/value) applied at nodes/mcp/shared/utils.ts L400-406. Any x-consumer-api-key seen on the wire is a USER-TYPED header name, fully consistent with the original Kong-API-gateway explanation.",
      authModelOrderCaveat:
        "Order follows the node's UI selector sequence. Unlike Goose and Codex, the report states no RUNTIME precedence for n8n. Note also that api-key here DEDUPES three distinct credential types (Bearer Auth, Header Auth, Multiple Headers Auth) which the enum cannot distinguish.",
      versionGate:
        "MCP OAuth2 requires node typeVersion >= 1.2. On typeVersion < 1.2 only Bearer / Header / None are offered (McpClientTool.node.ts L134-147). Node version list [1, 1.1, 1.2, 1.3, 1.4], defaultVersion 1.4 (L61-62).",
      dcrIdentityGaps:
        "userAgent unverifiable — code search for \"User-Agent\" scoped to packages/@n8n/nodes-langchain/nodes/mcp returns total_count: 0. The DCR POST goes through OutboundHttp; no MCP-specific override was located, so the effective value is a runtime default that cannot be pinned from source.",
      redirectUriIsDeploymentSpecific:
        "Self-hosted n8n means the redirect URI is deployment-specific — a HOSTED HTTPS redirect, structurally the opposite of every CLI/desktop client in this catalog. An HP-44 trace must record the instance URL as a VARIABLE, not a constant.",
      mcpClientInfoIsNotAProductName:
        "shared/utils.ts L176 constructs new Client({ name, version }) with name = node.type and version = node.typeVersion (L524-525) — the n8n NODE TYPE STRING, not a product name. Matches the E2 probe (@n8n/n8n-nodes-langchain.mcpClientTool, 1.3). The exact literal is assembled at runtime by n8n's node loader and is not a single literal in any file.",
    },
  },

  // ── perplexity ─────────────────────────────────────────────────────────────
  // ALL FIVE FIELDS UNVERIFIABLE — and for an unusual, specific reason worth
  // preserving: the only first-party doc is unreachable to automation.
  perplexity: {
    profileVersion: 1,
    sendsResourceIndicator: {
      status: "unverifiable",
      reason:
        "Perplexity's only relevant first-party document — https://www.perplexity.ai/help-center/en/articles/13915507-adding-custom-remote-connectors — returns HTTP 403 Forbidden to automated fetch (bot protection); both the canonical URL and the shortened /articles/13915507 form 403. The client is closed-source, so there is no alternative first-party route. Search-engine snippets exist but a snippet is NOT a first-party read, and quoting one as verified is precisely the HP-17 failure mode.",
      capturedAt: CAPTURED,
    },
    oauthSpecVersion: {
      status: "unverifiable",
      reason:
        "Same blocker: the only first-party doc returns HTTP 403 to automated fetch, and the client is closed-source. Even the doc-level answers here need a human with a browser.",
      capturedAt: CAPTURED,
    },
    protocolVersionPinning: {
      status: "unverifiable",
      reason:
        "The report verifies only the version observed in the `initialize` body via an E2 probe (2025-06-18); it does not establish the pinned-vs-negotiated discriminant the schema requires, and the closed-source client plus 403-blocked doc give no way to settle it. Observed value preserved in extensions.protocolVersionPinningNotes.",
      capturedAt: CAPTURED,
    },
    dcrIdentity: {
      status: "unverifiable",
      reason:
        "Same blocker: help-center article returns HTTP 403 to automated fetch; closed-source client. No redirect URI, client_name, or User-Agent could be read from any first-party source.",
      capturedAt: CAPTURED,
    },
    authModel: {
      status: "unverifiable",
      reason:
        "DELIBERATELY NOT PROMOTED. Search-engine snippets of the 403-blocked help-center article suggest three modes (none / API key / OAuth 2.0 with optional manual Client ID+Secret when the server lacks DCR), but the report explicitly refuses to record a search snippet as a first-party read. Snippet preserved as a lead in extensions.leadsNotEvidence.",
      capturedAt: CAPTURED,
    },
    extensions: {
      evidenceClass: "E2 (probe) only — no readable E1 source",
      protocolVersionPinningNotes:
        "E2 capture: seed-host-template.ts:1826-1832 records supportedProtocolVersions:[\"2025-06-18\"] with clientInfo {name:\"mcp\", version:\"0.1.0\"}, annotated at :1820-1822 as \"Captured from the Perplexity host probe\". Initialize-body only; discriminant unresolved.",
      blockerIsUnusual:
        "Unlike the other closed-source hosts, Perplexity's gap is not 'the vendor didn't document it' but 'the vendor's document is machine-unreachable'. HP-44 aside, a human opening that URL in a browser would close several of these cells cheaply.",
      leadsNotEvidence:
        "E3 ONLY: (a) search snippets suggest none / API key / OAuth 2.0, with /.well-known/oauth-authorization-server scope discovery. (b) https://community.perplexity.ai/t/custom-mcp-connector-fails-with-did-not-return-a-client-secret-for-rfc-7591-compliant-public-client-registrations/5172 reports that Perplexity's connector FAILS when a DCR response omits client_secret — i.e. the same confidential-client requirement documented for M365 Copilot. If true this is a high-value interop finding; HP-44 should test it explicitly.",
    },
  },

  // ── cline ──────────────────────────────────────────────────────────────────
  // E1 cline/cline @ main. Opposite architecture from n8n: Cline authors ZERO OAuth
  // protocol code and delegates entirely to the MCP SDK. Its OAuth profile is
  // therefore a property of its PINNED SDK VERSION and will change on a dep bump
  // with no Cline code change — the most important single fact about this host.
  cline: {
    profileVersion: 1,
    sendsResourceIndicator: {
      status: "verified",
      value: true,
      source:
        "E1 — INHERITED, not client-authored. Cline implements the SDK's OAuthClientProvider interface and hands it to the SDK transports; @modelcontextprotocol/sdk src/client/auth.ts (~L470-521) passes `resource` into both fetchToken(...) and startAuthorization(...). CONDITIONAL: the SDK only emits it when RFC 9728 PRM was retrieved — auth.ts ~L545-564 `// Only include resource parameter when Protected Resource Metadata is present` / `if (!resourceMetadata) { return undefined; }`. So Cline sends resource IFF the server publishes PRM. Pinned SDK resolved to 1.29.0 (bun.lock:1614).",
      capturedAt: CAPTURED,
    },
    oauthSpecVersion: {
      status: "unverifiable",
      reason:
        "SCHEMA MISMATCH. Cline pins NO revision of its own; the bundled SDK 1.29.0 declares a LIST — src/types.ts L4-6 SUPPORTED_PROTOCOL_VERSIONS = [2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07] — which is neither a single value nor wholly inside the enum (2024-11-05 and 2024-10-07 are not members). The SDK list is preserved in extensions.sdkSupportedProtocolVersions.",
      capturedAt: CAPTURED,
    },
    protocolVersionPinning: {
      status: "verified",
      value: { mode: "negotiated" },
      source:
        "E1 — GitHub code search for \"mcp-protocol-version\" and MCP-Protocol-Version over cline/cline both return total_count: 0: NO hardcoded value exists in the Cline repo at all. The header is set by the SDK transport AFTER negotiation — src/client/streamableHttp.ts ~L194-195 `if (this._protocolVersion) { headers['mcp-protocol-version'] = this._protocolVersion;`.",
      capturedAt: CAPTURED,
    },
    dcrIdentity: {
      status: "verified",
      value: {
        clientName: "Cline",
        redirectUris: [
          "http://127.0.0.1:1456/mcp/oauth/callback",
          "http://127.0.0.1:1457/mcp/oauth/callback",
          "http://127.0.0.1:1458/mcp/oauth/callback",
          "http://127.0.0.1:1459/mcp/oauth/callback",
          "http://127.0.0.1:1460/mcp/oauth/callback",
          "http://127.0.0.1:1461/mcp/oauth/callback",
        ],
      },
      source:
        "E1 — client_name is the literal \"Cline\", hardcoded in TWO independent providers: apps/vscode/src/services/mcp/McpOAuthManager.ts L108-116 (clientMetadata: redirect_uris:[this.redirectUrl], token_endpoint_auth_method:\"none\", grant_types:[\"authorization_code\",\"refresh_token\"], response_types:[\"code\"], client_name:\"Cline\") and sdk/packages/core/src/extensions/mcp/oauth.ts L84-92 (same fields). Loopback with PORT SCANNING: McpOAuthManager.ts L41 DEFAULT_HTTP_MCP_REDIRECT_URL = \"http://127.0.0.1:1456/mcp/oauth/callback\" and L48 MCP_OAUTH_CALLBACK_PORTS = [1456,1457,1458,1459,1460,1461]. The advertised redirect_uris value is whichever port actually bound (oauth.ts L319), so it VARIES PER SESSION. userAgent unverifiable — see extensions.dcrIdentityGaps.",
      capturedAt: CAPTURED,
    },
    authModel: {
      status: "verified",
      value: ["oauth2-dcr", "api-key"],
      source:
        "E1 — OAuth2 + PKCE + DCR as a PUBLIC client (token_endpoint_auth_method \"none\", always, never a secret), on remote transports only: the auth provider is attached only to sse / streamableHttp (McpHub.ts L465-468, L599-605) and STDIO IS EXPLICITLY EXCLUDED with a thrown error (sdk/packages/core/src/extensions/mcp/oauth.ts L295-299). Optional user-supplied static headers coexist as an orthogonal mechanism. See extensions.authModelOrderCaveat.",
      capturedAt: CAPTURED,
    },
    extensions: {
      evidenceClass: "E1 (upstream source + GitHub code search), E2 (probe)",
      oauthImplementationIsInherited:
        "MOST IMPORTANT FACT ABOUT THIS HOST: Cline authors no OAuth protocol code. All wire behavior — resource, PKCE, discovery, the DCR POST, token exchange — is executed by @modelcontextprotocol/sdk's auth(). Its profile is a property of the pinned SDK version and will change on a dependency bump with NO Cline code change. Any golden trace for Cline MUST record the resolved SDK version alongside it.",
      pinnedSdkVersion:
        "apps/vscode/package.json:471 '@modelcontextprotocol/sdk': '^1.25.1'; sdk/packages/core/package.json:55 '^1.29.0'; committed lockfile resolves both — bun.lock:1614 '@modelcontextprotocol/sdk@1.29.0'.",
      sdkSupportedProtocolVersions: [
        "2025-11-25",
        "2025-06-18",
        "2025-03-26",
        "2024-11-05",
        "2024-10-07",
      ],
      protocolVersionPinningNotes:
        "CORRECTS how the E2 capture must be read: seed-host-template.ts:1858-1863 records supportedProtocolVersions:[\"2025-11-25\"], but that is what the bundled SDK negotiated at capture time, NOT a Cline-owned pin. The SDK can negotiate down as far as 2024-10-07, much further than the probe suggests.",
      redirectPortRangeNarrowerInCore:
        "Core defaults are narrower than the VS Code extension's: sdk/packages/core/src/extensions/mcp/oauth.ts L28-29 uses [1456, 1457, 1458]. An authorization server must accept the whole 1456-1461 range, or accept port-agnostic loopback matching per RFC 8252 §7.3.",
      dcrIdentityGaps:
        "userAgent unverifiable — code searches for \"User-Agent\" scoped to apps/vscode/src/shared and src/services/mcp both return total_count: 0. No MCP-specific override exists; the effective value is the Node/undici runtime default, which cannot be pinned from source.",
      authModelOrderCaveat:
        "Unlike Goose and Codex, the report states no RUNTIME precedence between OAuth and static headers for Cline. The order here is not a verified preference ranking.",
      mcpClientInfoDistinctFromDcr:
        "MCP clientInfo.name is \"Cline\" with the extension version (McpHub.ts L452-456), falling back to \"@cline/core\" / \"0.0.0\" in the CLI path (oauth.ts L269-272). Confirms the E2 probe (clientInfo {name:\"Cline\", version:\"3.89.2\"}).",
    },
  },

  // ── notion ─────────────────────────────────────────────────────────────────
  // E1 official help doc for the auth model only; everything else undocumented.
  // NOTE: the in-repo template's protocol version is a SELF-DECLARED PLACEHOLDER,
  // not a capture — it must not be read as E2 evidence.
  notion: {
    profileVersion: 1,
    sendsResourceIndicator: {
      status: "unverifiable",
      reason:
        "https://www.notion.com/help/mcp-connections-for-custom-agents explicitly contains no mention of RFC 8707 or the resource parameter, and Notion's agent client is closed-source. Requires HP-44.",
      capturedAt: CAPTURED,
    },
    oauthSpecVersion: {
      status: "unverifiable",
      reason:
        "The official help page contains no mention of /.well-known/oauth-protected-resource or any spec revision, so no enum member can be selected either literally or behaviorally. Closed-source. Requires HP-44.",
      capturedAt: CAPTURED,
    },
    protocolVersionPinning: {
      status: "unverifiable",
      reason:
        "No first-party evidence, AND the in-repo value must NOT be treated as a capture: seed-host-template.ts:1888-1896 records supportedProtocolVersions:[\"2025-11-25\"] with clientInfo {name:\"notion\", version:\"1.0.0\"}, but the file flags it at :1890-1892 — \"NOTE: name/version are placeholders — only Notion's browser thinking animation was captured, not its MCP initialize handshake.\" That is an E3-equivalent in-repo placeholder, not E2 probe data. Requires HP-44.",
      capturedAt: CAPTURED,
    },
    dcrIdentity: {
      status: "unverifiable",
      reason:
        "The official help page explicitly contains no redirect URI, no client_name, no client_id, and no User-Agent. Closed-source. Requires HP-44.",
      capturedAt: CAPTURED,
    },
    authModel: {
      status: "verified",
      value: ["oauth2-dcr", "oauth2-preregistered", "api-key"],
      source:
        "E1 — https://www.notion.com/help/mcp-connections-for-custom-agents: \"Custom MCP servers may support one or both of the following sign-in methods: OAuth [and] Header-based authentication (for example, API keys or bearer tokens)\". DCR-first ordering IS report-backed: \"Some OAuth servers don't support dynamic client registration (DCR). This means Notion must pre-register a client application with the third-party service before OAuth sign-in can work.\" — pre-registration is described as the EXCEPTION required when DCR is unavailable, establishing DCR as the default path.",
      capturedAt: CAPTURED,
    },
    extensions: {
      evidenceClass: "E1 (auth model only) — no E2 capture exists",
      inRepoValueIsPlaceholderNotEvidence:
        "WARNING for anyone reading the seed template: notion's supportedProtocolVersions:[\"2025-11-25\"] and clientInfo are self-declared placeholders (comment at seed-host-template.ts:1890-1892), NOT probe data. Read without the comment they are indistinguishable from a real E2 capture. This is one of the cases motivating the report's recommendation for a machine-readable provenance:'probe'|'guess'|'doc' marker on mcpProfile.initialize.",
      guidanceQuoted:
        "\"If the server you want to use doesn't support DCR, check its documentation to see if you can use an API key or bearer token instead.\"",
    },
  },
};
