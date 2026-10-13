---
"@mcpjam/sdk": minor
"@mcpjam/inspector": minor
---

When an organization requires its own provider keys for AI features, the inspector server reads that policy before it routes a model: MCPJam-provided models, personal keys, keys sent with the request and local runtimes are refused with `org_keys_required`, and a policy that can't be read refuses the run instead of running it. Launch refusals now answer with their code and every listed problem rather than a server error. The SDK's model lease classifier reports these refusals as `policy` (never as a credential problem), and suite-file runs stop with the new `AI_POLICY_REFUSED` error code and `orgPolicy` refusal.
