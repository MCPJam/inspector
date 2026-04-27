---
name: mcp-inspector
description: Interpret and use `mcpjam` probe, doctor, OAuth, apps conformance, tools, resources, and prompts output conservatively against MCP 2025-11-25. Use when interacting with MCP servers, executing tools, triaging findings, performing security reviews, deciding whether a CLI finding is real or overstated, or turning inspection output into an engineer-facing report with severity and confidence.
---

# MCPJam CLI Investigation

Use this skill when analyzing MCP server behavior from `mcpjam` or MCP Inspector output. The goal is to separate:

- real protocol issues
- interoperability warnings
- implementation polish
- mcpjam or SDK artifacts

## Interactive use

When the user wants to connect to a server and use it:

1. Probe the server first: `server probe --url <url> --quiet --format json`.
   - Use the probe to learn auth posture, resource metadata, authorization-server metadata, and registration strategies before assuming the connected surface is public.
2. If the probe shows `oauth_required`, authenticate with `oauth login --credentials-out <path>` or run `oauth conformance --credentials-out <path>` when the task is specifically to test the OAuth flow.
3. Discover tools: `tools list --url <url> --credentials-file <path> --quiet --format json`.
   - Tools with `_meta.ui.resourceUri`, deprecated `_meta["ui/resourceUri"]`, or `openai/outputTemplate` in `toolsMetadata` have interactive UI.
4. Execute a tool: `tools call --url <url> --tool-name <name> --tool-args <json> --credentials-file <path>`.
5. Execute with UI: `tools call --url <url> --tool-name <name> --tool-args <json> --credentials-file <path> --ui`.
   - `--ui` starts Inspector and renders the completed result in App Builder.
   - Use `--ui` only when the tool has UI metadata or the user explicitly asks to see UI.

When the user asks to investigate, audit, or triage, use the Investigation workflow below.

## Default stance

- Treat raw request/response evidence as higher trust than normalized CLI convenience output.
- Separate observations, compliance issues, and security findings. They are related, but not interchangeable.
- Map claims to spec strength: `MUST` and `MUST NOT` are strong conformance signals; `SHOULD` and `RECOMMENDED` are softer guidance; `MAY` and optional fields are usually informational.
- Do not label a security finding `high` unless you can support a concrete attacker benefit or clear breakage path.
- When evidence is ambiguous, lower confidence or use `pending` before overstating the conclusion.

## Investigation workflow

1. Start with the narrowest command that actually proves the claim.
2. If the command may fail, you want a reusable handoff artifact, or CI should retain evidence, add `--debug-out <path>` to `server probe`, `server validate`, `tools call`, or `oauth login`.
3. If the probe shows `oauth_required` and the task is to inspect the server surface, continue with `oauth login` or another supported auth flow to obtain reusable credentials before judging post-auth behavior. For multi-command connected sessions, use `--credentials-out <path>` on `oauth login`, `oauth conformance`, or `oauth conformance-suite` to persist tokens and `--credentials-file <path>` on later commands; read `references/cli-surface-notes.md` for access-token-only exceptions. When a token is already available (CI, M2M, env var), prefer a credentials file when possible and pass `--access-token` or `--oauth-access-token` only as an escape hatch.
4. After successful auth, inspect the connected surface with direct commands such as `server info`, `server capabilities`, `tools list`, `resources list/read/templates`, and `prompts list/get`.
5. Use `server doctor --out <path>` when you need one breadth-first snapshot instead of several single-purpose command outputs.
6. If the output came from `server doctor` or a `--debug-out` artifact, split it into primary command evidence, probe evidence, and connected-sweep evidence.
7. If the claim is specifically about MCP Apps tool metadata or `ui://` resources, start with `apps conformance --quiet --format json` before dropping to `tools list` or `resources read`.
8. If the claim is about a tool result rendering in Inspector, use `tools call --tool-name <name> --tool-args <json|@file|-> --ui --quiet --format json`.
9. If a field may be CLI-added or SDK-normalized, read `references/cli-surface-notes.md` before concluding anything.
10. If the claim depends on MCP semantics, read `references/mcp-2025-11-25-interpretation.md`.
11. If the task involves security review, read `references/security-best-practices.md` for the full checklist and follow the security review workflow below.
12. Write the result using the output contract below.

## Security review workflow

Use this when the task is to assess an MCP server's security posture. All checks use existing CLI commands. No special security tooling is needed. Do not assume every server should require auth.

### Phase 1: Observe (read-only)

Run `server probe --url <target> --quiet --format json` first. Add `oauth metadata` or `server doctor --out <path>` only when they clarify the picture.

- Record an initial auth signal:
  - `full-auth candidate`: probe `status` is `oauth_required`
  - `public-or-mixed candidate`: probe `status` is `ready`
  - `unknown`: probe is only `reachable`, `error`, or otherwise ambiguous
- Capture discovery facts:
  - OAuth metadata URLs and whether they point to public, private, or suspicious targets
  - `scopes_supported`, `WWW-Authenticate`, and PKCE methods
  - registration strategies such as `dcr`, `cimd`, and `preregistered`
- Record the evidence surface you are trusting. Raw probe/RPC evidence beats doctor summaries or convenience fields.
- Phase 1 can produce observations and compliance notes. By itself it should not produce a `high` security severity.

### Phase 2: Provoke (behavior, still mostly unauth)

Treat the Phase 1 auth signal as provisional until behavior confirms it.

- For a `full-auth candidate`:
  - run DCR shape probes if DCR is supported
  - spot-check representative unauth `tools list` or `tools call` behavior when feasible
  - check malformed, expired, or obviously wrong-audience token handling without overstating what a rejection proves
- For a `public-or-mixed candidate`:
  - run unauth `tools list`
  - classify exposed tools as read-only, write, or side-effect
  - call representative public tools unauth
  - check whether gated tools fail with a clean auth challenge instead of silent empty data or partial data
- Anonymous tiers, rate limits, or degraded public access are posture notes, not a separate posture class.
- Reclassify to one of `no-auth`, `full-auth`, `mixed-auth`, or `unknown` once Phase 2 behavior is clear. If Phase 2 contradicts Phase 1, update the posture and rerun the relevant checks instead of forcing the old classification.
- Input-validation hits from Phase 2 cap at `medium` security severity until Phase 3 proves attacker benefit.
- Design or posture findings can be real security findings in Phase 2, but do not auto-promote them. Document the unsafe behavior, abuse path, and any owner-intent uncertainty before calling them `medium` or `high`.

### Phase 3: Exploit or confirm attacker benefit

Use `oauth login` and the same browser session when the proof depends on consent or cookies.

- Use Phase 3 to turn a plausible concern into a real end-to-end security finding:
  - DCR plus authorization flow proof
  - redirect URI exact-match bypass proof
  - foreign-token acceptance or token passthrough proof
  - code, token, or cross-tenant data capture
- Consent skip is one route to `high`, not the only route. Any demonstrated chain that shows concrete attacker gain can justify `high`.

### Phase 4: Inventory blast radius

- After auth succeeds, decode JWT claims, inspect `Mcp-Session-Id` with raw logs, and enumerate tools, resources, prompts, scopes, and tenant context.
- Phase 4 is mainly blast-radius calibration. Treat it as context unless you also prove abuse.

### Security severity calibration

- `high`: demonstrated attacker benefit or conforming-client breakage with direct evidence
- `medium`: credible security issue with a concrete attack scenario, but end-to-end proof is still partial
- `low`: hardening gap or limited-impact security concern
- `pending`: plausible security concern with a specific missing proof step that could materially raise or lower severity
- `info`: true observation with no credible attacker benefit yet

Use `pending` instead of manufacturing a `medium` or `high` security severity from a checklist hit.

## Command choice

- `server probe`: HTTP transport reachability, initialize behavior, and OAuth discovery hints.
- `server doctor`: combined triage artifact for probe plus connected behavior. Good for breadth, not always sufficient to prove wire-level behavior by itself.
- `oauth metadata`, `oauth proxy`, `oauth debug-proxy`: exact endpoint and metadata inspection when conformance output looks surprising.
- `oauth login`: obtain reusable credentials and verify the authenticated MCP path. Use `--credentials-out <path>` to save tokens to disk (mode 0600) so later connected commands can use `--credentials-file <path>` without manual token extraction; check `references/cli-surface-notes.md` for commands that require a non-expired access token. Use this when the goal is to inspect a server that requires OAuth, then follow it with connected commands rather than stopping at the login result.
- `oauth conformance`, `oauth conformance-suite`: flow-level auth checks. Treat these as targeted probes, not a complete security review. Use `--credentials-out <path>` when a passing flow should hand credentials to later connected commands; use `--credentials-file <path>` after that instead of extracting tokens from JSON output. Raw JSON output redacts OAuth secrets by default. When `--conformance-checks` is enabled, the command can directly probe DCR non-loopback `http://` redirects, invalid client rejection, authorization-endpoint redirect mismatch handling, invalid bearer-token rejection at the MCP server, and token-endpoint redirect mismatch handling.
- `apps conformance`: server-side MCP Apps checks for `_meta.ui.resourceUri`, `ui://` resources, `resources/read`, HTML MIME and payload shape, and `_meta.ui` metadata. Use this for MCP Apps surface triage.
- `server info`, `server capabilities`, `server validate`, `server ping`, `server export`: connected behavior after initialization and auth.
- `tools list` and `tools call`, `resources list/read/templates`, `prompts list/get/list-multi`: direct post-connect capability checks. With `--ui`, `tools call` renders the completed tool result in Inspector and reports `inspectorRender` as UI command/render evidence.
- Prefer `--quiet --format json`. Add `--rpc` when available if you need request and response evidence rather than a summary. Add `--debug-out` when you need a failure-safe artifact, not as a replacement for raw evidence.
- Use `--reporter junit-xml` or `--reporter json-summary` for CI report artifacts on conformance and diff commands. `server validate` does not accept `--reporter`; use `--debug-out` for validation artifacts. Do not use `--format junit-xml`; `--format` is only for raw `json` or `human` output.
- For JSON-valued options, prefer `@path` or `-` stdin over shell-escaped inline JSON when payloads are generated or contain quotes. For example: `mcpjam tools call --url <target> --tool-name <name> --tool-args @params.json --quiet --format json`.

## Output contract

### General triage output

For non-security tasks, return:

- `Verdict`: `real issue`, `interop warning`, `implementation polish`, or `scanner/client artifact`
- `Severity`: `high`, `medium`, `low`, or `info`
- `Confidence`: `high`, `medium`, or `low`
- `Why it matters`: one short paragraph tied to interoperability, security, or user impact
- `Evidence`: the exact CLI behavior that supports the claim
- `Missing evidence`: what would need to be confirmed before raising severity or confidence

### Security review output

For each claimed security-review finding, return:

- `Verdict`: `real issue`, `interop warning`, `implementation polish`, or `scanner/client artifact`
- `Compliance severity`: `high`, `medium`, `low`, or `info`
- `Security severity`: `high`, `medium`, `low`, `info`, or `pending`
- `Confidence`: `high`, `medium`, or `low`
- `Attack scenario or pending rationale`: if `Security severity` is `medium` or `high`, open with 2-3 sentences answering who the attacker is, what they need, and what they gain; if it is `pending`, say exactly what proof is missing
- `Verified via`: the phase plus exact command or result that supports the claim
- `Evidence`: the exact CLI behavior that supports the claim
- `Missing evidence`: what would need to be confirmed before raising severity or confidence

## Hard rules

- Never call `toolsMetadata` an MCP server field.
- Never use removed app/widget commands for UI rendering. Use `tools call --ui`; use `resources read --resource-uri ui://...` for raw resource HTML.
- Never manually orchestrate Inspector API calls when `tools call --ui` can drive the render.
- Never skip `tools list` discovery when the user names a server but not a specific tool.
- Never infer prompt support from an empty prompts list unless you have raw RPC evidence that `prompts/list` was actually sent and answered by the server.
- Never stop at `oauth_required` when the user asked to inspect the authenticated server surface and the CLI can complete login. Authenticate and continue with post-login commands when feasible.
- Never treat a passing `apps conformance` result as full SEP-1865 conformance. The current command is server-side only and does not prove host lifecycle, sandbox proxy, or postMessage bridge behavior.
- Never treat missing optional metadata such as `outputSchema`, content annotations, `scopes_supported`, or `scope` hints as a hard failure without a `MUST`.
- Separate OAuth RFC violations from MCP profile preferences.
- Distinguish "the server correctly rejected a bad request" from "the overall design is secure."
- Treat `--debug-out` artifacts as aggregated evidence envelopes, not pure wire captures.
- Never flag missing `scopes_supported` or missing `scope` in `WWW-Authenticate` as a security issue. Both are optional.
- Never claim a server is "secure" based solely on it rejecting one specific bad input. A single negative test does not prove broader security posture.
- Never treat a passing `oauth_invalid_token` or redirect-mismatch probe as proof that the whole authorization design is secure. Those checks only prove the exact case that was sent.
- Never let a checklist hit assign `high` security severity by itself.
- JWT `aud` mismatch is not token passthrough proof unless you show the server accepts a token issued for a different audience or resource, or otherwise misbinds the token.
- Supporting `plain` PKCE is usually hardening only. It cannot compound with attacker-owned-client DCR flows where the attacker chose the verifier.
- Hostile `redirect_uri` values are not SSRF unless you show the server fetches them.
- Public unauthenticated access is not itself a finding. Check whether behavior matches advertised posture and whether exposed surfaces are safe by design.
- Anonymous trial or rate-limited access is a posture note, not a separate severity finding.
- When compounding findings, explain the compound attack path. Do not just list unrelated findings and call the combination worse.

## Reference map

- `references/cli-surface-notes.md`
  Use for command-specific caveats, artifact shapes, local enrichments, merged errors, and normalized empty arrays.
- `references/mcp-2025-11-25-interpretation.md`
  Use for capability, lifecycle, transport, authorization, tools, resources, and prompts interpretation against the latest MCP spec.
- `references/security-best-practices.md`
  Use for security review checks mapped to CLI commands. Covers SSRF, confused deputy, PKCE, token passthrough, scope minimization, auth-posture checks, and session security. Source: https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices
