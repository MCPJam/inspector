> Independent qualitative review; frozen strict rewards are unchanged. Raw trajectory references map to public-only projections via run indexes.

# Authentication supplement: cycle1

Four usable C trials completed the intended auth-recovery journey: 2/2 baseline and 2/2 cycle1 patched. Strict rewards were baseline1/2 and patched2/2. Baseline Codex `auth__DebKeUR` is the narrow CLI-invocation matcher miss: authenticated direct calls, saved CLI output, preserved config, and state-based successful_recovery are independently observed. All raw rewards remain unchanged. No tested C trial required account-owner intervention; all used the supplied server token after a captured401.

Two initial Claude attempts (`auth__HzCGt8k`, `auth__UifmxRq`) remain visible as provider-blocked, semantic outcome unmeasurable. The provider token expired; Harbor reports `UnknownApiError` and `has_valid_reward:false`. The replacement Claude runs (`auth__DDRa9aF`, `auth__Qgcz284`) used fresh processes following provider authentication refresh. Do not count the provider401 as the fixture's intended MCP authentication failure.

Representative public concerns:

- Baseline Claude: “I expected `mcp.json` to carry the auth, and it doesn't.” It used the supplied token, saved validate.sh, and completed add2+3.
- Cycle1 patched Claude: “I expected `mcp.json` to be enough to connect, but the server needs a bearer token it doesn't contain.” Same recovery and preserved work; no evidence these guidance changes affected this scenario.
- Patched Codex: “The unauthenticated check returned `401 invalid_token`; retrying with `MCP_SERVER_TOKEN` connected successfully and discovered the `add` tool.”

Both usable Codex C runs independently executed actual protocol conformance. Both reported13/14 applicable passed,1failed,30N/A at2025-11-25. Both identified the permitted GET405 JSON body as a likely checker false positive; source/spec review confirmed that raw response JSON was indiscriminately included in JSON-RPC schema observations. This evidence initiated cycle2. Baseline command event4041f55bce9447e79b26d4132ea0afc8 exited1; patched cycle1 event4caa7eee610d4d5582e79f80506da13d had trailingcat, so shell exit0 masks the command's exit (report passed=false is authoritative). Doctor/probe/validate results in the Claude runs are not conformance results.

Both Codex runs also found the fixture accepting extra tool arguments despite additionalProperties:false; one observed unsupported suite-update persistence. These are fixture defects, separate from the checker false positive. They remain in the evidence and were not silently fixed during the frozen benchmark.

## Cycle2 controlled proof

Commit a6e25a8 limits the change to HTTP GET405 at the wire-observation filter. RawHTTP exchanges remain captured; all other methods/statuses keep prior validation. Six new tests include wrong-method/status and malformed-tool-result negative controls, with54 focused recorder/schema/integration tests passing. SDK typecheck,SDK+CLI builds,slop and diff checks passed. Changeset covers @mcpjam/sdk.

The same local conformance command against the unchanged fixture improved wire-schema-valid fromfailed topassed. Overall14/16 applicable became15/16: the extra loopback Host-header fixture defect remained failed, so process exit1 remains correct. Full before/after output retained at ../preflight/product-fixes--before-conformance-get405/event.json and after-conformance-get405; [cycle2-conformance-comparison.json](cycle2-conformance-comparison.json) records the exact comparison. This controlled proof is separate from fresh-agent supplemental trials on cycle2 and from the frozen cycle1 product-copy comparison.

Official contract: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#listening-for-messages-from-the-server permits GET405 when no SSE stream is offered. No change to live billing, fixture contracts, prompts or reward criteria occurred in cycle2.
