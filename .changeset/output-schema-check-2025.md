---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Tool Output Schema Honored (`modern-tool-output-schema-conformant`) now runs on 2025-06-18 and 2025-11-25, not only on 2026-07-28. Those revisions state the same rule: "If an output schema is provided: Servers MUST provide structured results that conform to this schema." The check said "not applicable" there, so a tool whose result broke its own `outputSchema` was never caught. On the 2025 revisions it opens its own session, lists the tools, calls the ones named in `fixtures.toolCalls`, and closes the session. With no tool named it calls nothing: it is not applicable when no tool declares an `outputSchema`, and could not run (a setup gap, at no cost to the score) when one does. 2025-03-26 has no `outputSchema`, so the check stays not applicable there and sends nothing. The SDK exports `CHECK_FIRST_PROTOCOL_VERSION` and `checkRunsOnVersion` for a check whose rule is younger than its era. In the inspector, the check and its "Tool to check output" field now show on 2025-06-18, 2025-11-25 and Auto, and not on 2025-03-26.
