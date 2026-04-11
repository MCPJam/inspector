---
name: mcpjam-cli-investigation
description: Interpret `mcpjam-cli` probe, doctor, OAuth, tools, resources, and prompts output conservatively against MCP 2025-11-25. Use when triaging MCP server findings, deciding whether a CLI finding is real or overstated, or turning inspection output into an engineer-facing report with severity and confidence.
---

# MCPJam CLI Investigation

Use this skill when analyzing MCP server behavior from `mcpjam-cli` output. The goal is to separate:

- real protocol issues
- interoperability warnings
- implementation polish
- mcpjam or SDK artifacts

## Default stance

- Treat raw request/response evidence as higher trust than normalized CLI convenience output.
- Map claims to spec strength: `MUST` and `MUST NOT` are strong conformance signals; `SHOULD` and `RECOMMENDED` are softer guidance; `MAY` and optional fields are usually informational.
- Do not label a finding `high` severity unless the spec clearly forbids the behavior or you can describe a concrete exploit or breakage path.
- When evidence is ambiguous, lower confidence before overstating the conclusion.

## Quick workflow

1. Start with the narrowest command that actually proves the claim.
2. If the command may fail, you want a reusable handoff artifact, or CI should retain evidence, add `--debug-out <path>` to `server probe`, `server validate`, `tools call`, or `oauth login`.
3. If the probe shows `oauth_required` and the task is to inspect the server surface, continue with `oauth login` or another supported auth flow to obtain reusable credentials before judging post-auth behavior.
4. After successful auth, inspect the connected surface with direct commands such as `server info`, `server capabilities`, `tools list`, `resources list/read/templates`, and `prompts list/get`.
5. Use `server doctor --out <path>` when you need one breadth-first snapshot instead of several single-purpose command outputs.
6. If the output came from `server doctor` or a `--debug-out` artifact, split it into primary command evidence, probe evidence, and connected-sweep evidence.
7. If a field may be CLI-added or SDK-normalized, read `references/cli-surface-notes.md` before concluding anything.
8. If the claim depends on MCP semantics, read `references/mcp-2025-11-25-interpretation.md`.
9. Write the result using the output contract below.

## Command choice

- `server probe`: HTTP transport reachability, initialize behavior, and OAuth discovery hints.
- `server doctor`: combined triage artifact for probe plus connected behavior. Good for breadth, not always sufficient to prove wire-level behavior by itself.
- `oauth metadata`, `oauth proxy`, `oauth debug-proxy`: exact endpoint and metadata inspection when conformance output looks surprising.
- `oauth login`: obtain reusable credentials and verify the authenticated MCP path. Use this when the goal is to inspect a server that requires OAuth, then follow it with connected commands rather than stopping at the login result.
- `oauth conformance`, `oauth conformance-suite`: flow-level auth checks. Treat these as targeted probes, not a complete security review.
- `server info`, `server capabilities`, `server validate`, `server ping`, `server export`: connected behavior after initialization and auth.
- `tools list` and `tools call`, `resources list/read/templates`, `prompts list/get/list-multi`: direct post-connect capability checks.
- Prefer `--format json`. Add `--rpc` when available if you need request and response evidence rather than a summary. Add `--debug-out` when you need a failure-safe artifact, not as a replacement for raw evidence.

## Output contract

For each claimed finding, return:

- `Verdict`: `real issue`, `interop warning`, `implementation polish`, or `scanner/client artifact`
- `Severity`: `high`, `medium`, `low`, or `info`
- `Confidence`: `high`, `medium`, or `low`
- `Why it matters`: one short paragraph tied to interoperability, security, or user impact
- `Evidence`: the exact CLI behavior that supports the claim
- `Missing evidence`: what would need to be confirmed before raising severity or confidence

## Hard rules

- Never call `toolsMetadata` an MCP server field.
- Never infer prompt support from an empty prompts list unless you have raw RPC evidence that `prompts/list` was actually sent and answered by the server.
- Never stop at `oauth_required` when the user asked to inspect the authenticated server surface and the CLI can complete login. Authenticate and continue with post-login commands when feasible.
- Never treat missing optional metadata such as `outputSchema`, content annotations, `scopes_supported`, or `scope` hints as a hard failure without a `MUST`.
- Separate OAuth RFC violations from MCP profile preferences.
- Distinguish "the server correctly rejected a bad request" from "the overall design is secure."
- Treat `--debug-out` artifacts as aggregated evidence envelopes, not pure wire captures.

## Reference map

- `references/cli-surface-notes.md`
  Use for command-specific caveats, artifact shapes, local enrichments, merged errors, and normalized empty arrays.
- `references/mcp-2025-11-25-interpretation.md`
  Use for capability, lifecycle, transport, authorization, tools, resources, and prompts interpretation against the latest MCP spec.
