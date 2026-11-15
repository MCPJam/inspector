> Independent qualitative review; frozen strict rewards are unchanged. Raw trajectory references map to public-only projections via run indexes.

# Final supplement and freeze

All34 v1.3 attempts have independent semantic reviews in final-observations.json:28 usable cycle1 comparison trials,2 provider-blocked attempts retained, and4 supplemental final-build-assigned trials. Raw Harbor rewards are unchanged. The24 priority comparison and4 usable cycle1 auth trials remain distinct from the supplement. No further product, fixture, prompt or verifier changes were made after cycle2 commit a6e25a8.

| Supplemental run | Agent / prompt | Raw reward | Independent outcome | Actual build / exposure |
|---|---|---:|---|---|
| auth__3bkokhu | Claude Code / C | 1 | Auth recovered, doctor and valid/invalid tool calls; no owner action | Cycle2 SDK archive fetched; no conformance invocation, so fix not exercised |
| auth__MV27c9o | Codex / C | 1 | Auth recovered, direct tests and saved reproducer; protocol14/14 applicable passed,30N/A | Cycle2 SDK archive fetched; fix directly exercised |
| discovery__pXszNVb | Claude Code / A | 1 | Docs→CLI→reproducible tool checks; identified fixture overflow | Cycle2 SDK archive fetched; no Eval or conformance |
| discovery__gvhHS8f | Codex / A | 1 | Docs→CLI→reproducible7/8-case test, identifies fixture extra-argument defect | **Public npm build, not pinned cycle2**; no /registry or /packages fixture requests. Exclude from pinned treatment-effect claims |

For the Codex A exception, eventbfb941bf7f244003a5caec7a7c2d7b4a runs npm install --prefix /workspace/mcp-check. Saved package-lock.json resolves CLI6.2.2 and SDK10.7.0 to registry.npmjs.org, with immutable integrity values. The assigned package mount is cycle2, but the archive ledger proves it was not consumed. A likely mechanism is npm --prefix changing global-config lookup; this explanation was not independently tested. Retain the successful discovery observation while disclosing uncontrolled package delivery. The other three supplemental trials fetched SDK tarballs matching work/versions.json patched_cycle2 hashes; CLI hash alone is insufficient because the CLI source did not change in cycle2.

## Fresh conformance improvement

The untouched C prompt led Codex to execute:

`npm exec --yes --package=@mcpjam/cli@6.2.2 -- mcpjam protocol conformance --url http://fixture:8765/mcp --access-token "$MCP_SERVER_TOKEN" --protocol-version 2025-11-25 --check-timeout 1000 --fixtures-file /workspace/validation/safe-calls.json --reporter json-summary`

Eventc6bcc98b46d84dfe9ac1927b2aece8ec exits0. Its saved validation/conformance.json reports passed=true,14 applicable passed,0failed,30N/A, and wire-schema-valid passed. Baseline Codex auth__DebKeUR and cycle1 Codex auth__GiXEbFi both observed13/14 and the GET405 false positive. The frozen fixture is identical. Check-timeout differs1000 versus2000ms, but the same actual14 checks completed, so no timeout exclusion explains the improvement. Public final note: “Protocol checks: 14 passed, 30 not applicable.”

This fresh observation complements the exact-command controlled before/after proof:14/16→15/16 on loopback, with the independent Host-validation fixture failure preserved. Claude did not choose conformance, so do not claim both agents behaviorally verified the checker fix.

## Unguided discovery stays separate

A starts at https://docs.mcpjam.com, so this measures finding a validation workflow from the named documentation site, not open-web brand discovery. Both agents achieved useful reproducible validation2/2. Neither executed a repeatable MCPJam Eval0/2, and no contemporaneous note demonstrates natural Eval discovery0/2 observed. Neither executed MCPJam protocol conformance0/2. Custom Python arithmetic checks and doctor are separate milestones.

Claude's A quote: “The overflow case returns invalid JSON.” Evente864742c2bac4d368d0058065236ffdf records1e308+1e308 serialized as Infinity and CLI JSON parsing failure. This is a fixture finite-result defect; no product parser bug is established. Codex A quote: “`add` accepts extra arguments despite declaring `additionalProperties: false`.” Its saved summary7/8 and reproducer exit1 preserve a real fixture schema defect.

One additional installation concern in Claude C: unscoped `npx --no-install mcpjam --help` produced npmE404, then @mcpjam/cli worked. Event7fd715c741394f89a0a9df60caf12af7. Keep as a bounded package-name-versus-command-name backlog item; no third fix cycle.

## Remaining limitations

No observed product-source or private grader access across34 attempts; captured command/tool-call scans find normal installed CLI execution and self-authored artifacts. This is an observed boundary audit, not proof arbitrary hidden access is impossible. No duplicate synthetic charge IDs across34; deliberate repeated smoke/negative-control launches are not accidental double charges. Agent-provider401s remain separate from product/fixture auth. Actual cost/balance discovery, non-owner roles, live billing, interactive browser/PTY flows and broad network fault classes remain untested. Conformance success is limited to14 applicable checks on this simple fixture, not exhaustive MCP certification.

Frozen review files: final-observations.json, final-observations.md, comparison-reviews.json, priority-patterns.md, auth-observations.md, final-supplement.md. Parent's publishing pass must redact and convert local evidence paths to repository-accessible links.
