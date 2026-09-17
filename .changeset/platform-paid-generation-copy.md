---
"@mcpjam/sdk": minor
"@mcpjam/cli": patch
"@mcpjam/inspector": patch
---

Say generation and insights are included with MCPJam, not billed to the customer.

Eight operations run a model whose cost is MCPJam's, not the organization's —
eval-case generation, the description-rewrite proposal, persona and journey
drafting, swarm wave insights, user-testing insights, and the two directory
readiness starts with `includeLlmObservations`. Every surface told the customer
otherwise: the MCP tool descriptions carried "COSTS MONEY", the CLI said
"spends credits", the approval cards warned about money, and the docs said
"SPENDS ORG CREDITS". For swarm wave insights and session clustering that copy
was already wrong today.

`risk` on those operations moves from `"spend"` to `"none"`, which is the single
lever for the MCP tool surface (`operationDescription` appends its spend warning
off that facet). What they actually consume is a bounded daily REQUEST quota —
`insightsPerDay` for the insight operations, a per-project generation quota for
the rest — so the copy now says "Included with MCPJam — no credits are consumed"
and names the quota instead.

They all stay GATED on the agent surface rather than deriving `direct` from the
new risk: the quota is shared across the organization, and an agent that
exhausts today's slice on its own initiative has taken something a person was
going to use. Each is a named `TIER_EXCEPTIONS` entry with its reason, and
`confirmSeverity` drops to `"none"` so no approval card claims a charge.

Still customer-paid and unchanged: eval suite/case runs, `request_eval_run_judge`,
the judge backtest, `start_eval_description_experiment`, journey launches and
chat.
